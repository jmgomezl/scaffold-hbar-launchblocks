import {
  AccountAllowanceApproveTransaction,
  ContractExecuteTransaction,
  ContractFunctionParameters,
  ContractId,
  Hbar,
  TokenId,
} from "@hiero-ledger/sdk";

import { LaunchBlocksError } from "../errors";
import {
  ZERO_ADDRESS,
  decodeAddress,
  decodeUint,
  encodeAddress,
  encodeCall,
  entityIdToEvmAddress,
} from "../hedera/abi";
import type { DecimalAmount } from "../hedera/amounts";
import { fromUnits, toLong, toUnits } from "../hedera/amounts";
import type { HederaContext } from "../hedera/context";
import { translateHederaError } from "../hedera/errors";
import {
  TINYBAR_PER_HBAR,
  fetchExchangeRate,
  readContract,
  resolveContractId,
  tinycentsToTinybars,
} from "../hedera/mirror";
import { getTokenInfo } from "../hedera/ops/tokens";
import { CREATE_POOL_GAS, SELECTORS, saucerswapFor } from "./config";

/**
 * Seeding a SaucerSwap V1 pool from a freshly created HTS token.
 *
 * Three things make this awkward to do by hand, and they are the reason this
 * exists as one step:
 *
 * 1. The pool creation fee is quoted in tinycents and must be converted to
 *    tinybars with the network's live exchange rate — the same conversion the
 *    0x168 precompile performs — then added to `msg.value` on top of the HBAR
 *    being deposited. Underpay and the call reverts after spending the gas.
 * 2. The router needs an HTS *allowance* over the token before it can pull it.
 * 3. The LP token is created during the call, so the receiving account needs a
 *    free auto-association slot for it.
 */

export type PoolQuote = {
  /** Pool creation fee in tinybars, converted at the current rate. */
  creationFeeTinybar: bigint;
  creationFeeHbar: string;
  /** Tinycents as the factory reports it, before conversion. */
  creationFeeTinycents: string;
  exchangeRate: { hbarEquivalent: number; centEquivalent: number };
};

/** What creating this pool will cost, without spending anything. */
export async function quotePoolCreation(hedera: HederaContext, signal?: AbortSignal): Promise<PoolQuote> {
  const { v1Factory } = saucerswapFor(hedera.network);
  const [raw, rate] = await Promise.all([
    readContract(hedera, { to: entityIdToEvmAddress(v1Factory), data: SELECTORS.pairCreateFee }, signal),
    fetchExchangeRate(hedera, signal),
  ]);
  const tinycents = decodeUint(raw);
  const tinybar = tinycentsToTinybars(tinycents, rate);
  return {
    creationFeeTinybar: tinybar,
    creationFeeHbar: fromUnits(tinybar, 8),
    creationFeeTinycents: tinycents.toString(),
    exchangeRate: rate,
  };
}

export type PoolRef = { evmAddress: string; contractId: string | null };

/**
 * The existing pool for `tokenId` paired with WHBAR, or null when there is
 * none. Pairs are deployed with CREATE2, so their EVM address is aliased and
 * the contract id has to come from the mirror node rather than arithmetic.
 */
export async function findPool(hedera: HederaContext, tokenId: string, signal?: AbortSignal): Promise<PoolRef | null> {
  const { v1Factory, whbarToken } = saucerswapFor(hedera.network);
  const data = encodeCall(
    SELECTORS.getPair,
    encodeAddress(entityIdToEvmAddress(tokenId)),
    encodeAddress(entityIdToEvmAddress(whbarToken)),
  );
  const raw = await readContract(hedera, { to: entityIdToEvmAddress(v1Factory), data }, signal);
  const evmAddress = decodeAddress(raw);
  if (evmAddress === ZERO_ADDRESS) return null;
  return { evmAddress, contractId: await resolveContractId(hedera, evmAddress, signal) };
}

export type CreatePoolParams = {
  tokenId: string;
  /** Whole tokens to deposit. Together with hbarAmount this sets the opening price. */
  tokenAmount: DecimalAmount;
  /** HBAR to deposit alongside the tokens. */
  hbarAmount: DecimalAmount;
  /** Tolerated shortfall on either side, in basis points (100 = 1%). */
  slippageBps: number;
  /** Seconds from now the router will still accept the call. */
  deadlineSeconds: number;
};

export type CreatePoolResult = {
  tokenId: string;
  pairId: string | null;
  pairEvmAddress: string | null;
  lpTokenId: string | null;
  transactionId: string;
  allowanceTransactionId: string;
  /** Actually deposited, which can be below the desired amount. */
  tokenAmountUnits: string;
  hbarAmountTinybar: string;
  liquidityUnits: string;
  creationFeeHbar: string;
  /** HBAR per whole token implied by the deposits. */
  openingPriceHbar: string;
  poolUrl: string;
};

export async function createPoolWithHbar(
  hedera: HederaContext,
  params: CreatePoolParams,
  signal?: AbortSignal,
): Promise<CreatePoolResult> {
  const deployment = saucerswapFor(hedera.network);
  const existing = await findPool(hedera, params.tokenId, signal);
  if (existing) {
    throw new LaunchBlocksError(
      "POOL_EXISTS",
      `A SaucerSwap pool for ${params.tokenId} and WHBAR already exists (${existing.contractId ?? existing.evmAddress})`,
      { hint: "Use saucerswap.addLiquidity to add to the existing pool instead of creating one." },
    );
  }

  const { decimals } = await getTokenInfo(hedera, params.tokenId);
  const tokenUnits = toUnits(params.tokenAmount, decimals);
  const hbarTinybar = toUnits(params.hbarAmount, 8);
  if (tokenUnits === 0n || hbarTinybar === 0n) {
    throw new LaunchBlocksError("POOL_AMOUNT_ZERO", "Both sides of a new pool must be greater than zero");
  }

  const quote = await quotePoolCreation(hedera, signal);
  const minToken = applySlippage(tokenUnits, params.slippageBps);
  const minHbar = applySlippage(hbarTinybar, params.slippageBps);
  const routerId = ContractId.fromString(deployment.v1Router);

  // 1. Let the router pull exactly what this call deposits.
  const allowanceTransactionId = await approveRouterAllowance(hedera, params.tokenId, routerId, tokenUnits);

  // 2. msg.value carries the deposited HBAR *and* the pool creation fee.
  const payable = Hbar.fromTinybars(toLong(hbarTinybar + quote.creationFeeTinybar));
  const deadline = Math.floor(Date.now() / 1000) + params.deadlineSeconds;

  const args = new ContractFunctionParameters()
    .addAddress(entityIdToEvmAddress(params.tokenId))
    .addUint256(toLong(tokenUnits))
    .addUint256(toLong(minToken))
    .addUint256(toLong(minHbar))
    .addAddress(hedera.operatorId.toSolidityAddress())
    .addUint256(deadline);

  try {
    const response = await new ContractExecuteTransaction()
      .setContractId(routerId)
      .setGas(CREATE_POOL_GAS)
      .setPayableAmount(payable)
      .setFunction("addLiquidityETHNewPool", args)
      .execute(hedera.client);
    const record = await response.getRecord(hedera.client);
    const result = record.contractFunctionResult;
    if (!result) {
      throw new LaunchBlocksError("CONTRACT_NO_RESULT", "The router call produced no contract result");
    }

    const amountToken = BigInt(result.getUint256(0).toString());
    const amountHbar = BigInt(result.getUint256(1).toString());
    const liquidity = BigInt(result.getUint256(2).toString());
    const pair = await findPool(hedera, params.tokenId, signal);
    const pairId = pair?.contractId ?? null;

    return {
      tokenId: params.tokenId,
      pairId,
      // On V1 the LP token is an HTS token whose id matches the pair contract.
      lpTokenId: pairId,
      transactionId: response.transactionId.toString(),
      allowanceTransactionId,
      tokenAmountUnits: amountToken.toString(),
      hbarAmountTinybar: amountHbar.toString(),
      liquidityUnits: liquidity.toString(),
      creationFeeHbar: quote.creationFeeHbar,
      openingPriceHbar: openingPrice(amountHbar, amountToken, decimals),
      pairEvmAddress: pair?.evmAddress ?? null,
      poolUrl: pairId ? `${deployment.appBaseUrl}/liquidity/${pairId}` : deployment.appBaseUrl,
    };
  } catch (error) {
    throw translateHederaError(error, `Creating a SaucerSwap pool for ${params.tokenId}`);
  }
}

async function approveRouterAllowance(
  hedera: HederaContext,
  tokenId: string,
  routerId: ContractId,
  units: bigint,
): Promise<string> {
  try {
    const response = await new AccountAllowanceApproveTransaction()
      .approveTokenAllowance(TokenId.fromString(tokenId), hedera.operatorId, routerId.toString(), toLong(units))
      .execute(hedera.client);
    await response.getReceipt(hedera.client);
    return response.transactionId.toString();
  } catch (error) {
    throw translateHederaError(error, `Approving the SaucerSwap router to spend ${tokenId}`);
  }
}

/** Minimum acceptable amount after tolerating `bps` basis points of shortfall. */
export function applySlippage(units: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) {
    throw new LaunchBlocksError("SLIPPAGE_INVALID", "Slippage must be an integer between 0 and 9999 basis points");
  }
  return (units * BigInt(10_000 - bps)) / 10_000n;
}

/** HBAR per whole token, for display. */
export function openingPrice(hbarTinybar: bigint, tokenUnits: bigint, decimals: number): string {
  if (tokenUnits === 0n) return "0";
  const scale = 10n ** BigInt(decimals);
  // Eight extra digits keep tinybar precision through the division.
  const scaled = (hbarTinybar * scale * TINYBAR_PER_HBAR) / (tokenUnits * TINYBAR_PER_HBAR);
  return fromUnits(scaled, 8);
}
