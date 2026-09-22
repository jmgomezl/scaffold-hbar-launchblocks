import { ContractExecuteTransaction, ContractFunctionParameters, ContractId, Hbar } from "@hiero-ledger/sdk";

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
  resolveEvmAddress,
  tinycentsToTinybars,
} from "../hedera/mirror";
import { getTokenInfo } from "../hedera/ops/tokens";
import { APPROVE_GAS, CREATE_POOL_GAS, SELECTORS, saucerswapFor } from "./config";

/**
 * Seeding a SaucerSwap V1 pool from a freshly created HTS token, with the
 * router's `addLiquidityETHNewPool`: one call deploys the pair, mints its LP
 * token, deposits both sides and sends the LP tokens to the recipient.
 *
 * What makes it awkward by hand, and what this handles:
 *
 * - **The LP recipient must be the account's EVM alias**, not the long-zero
 *   form of its id (`AccountId.toSolidityAddress()`). Alias-created ECDSA
 *   accounts reject the long-zero form with INVALID_ALIAS_KEY on the final
 *   transfer, after the pair has been created and funded. The router only
 *   reports "Safe token transfer failed!"; the real status is visible only in
 *   the transaction's child records on the mirror node.
 * - **The creation fee is priced in tinycents.** It is read from the factory
 *   and converted with the network's live exchange rate exactly as the 0x168
 *   precompile does, then added to `msg.value` on top of the HBAR deposited.
 * - **The documented gas is too low** (see CREATE_POOL_GAS).
 * - **The router pulls the token through an allowance**, granted here on the
 *   token's ERC-20 facade, the approval SaucerSwap's own front end requests.
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

/**
 * Look up the pool, retrying while the mirror node catches up.
 *
 * Mirror data trails consensus by a few seconds, so a pool read immediately
 * after the transaction that created it comes back empty. Only reads that
 * follow a write need this; plain lookups can call `findPool` directly.
 */
export async function findPoolAfterWrite(
  hedera: HederaContext,
  tokenId: string,
  options: { attempts?: number; delayMs?: number; signal?: AbortSignal } = {},
): Promise<PoolRef | null> {
  const attempts = options.attempts ?? 6;
  const delayMs = options.delayMs ?? 1500;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pool = await findPool(hedera, tokenId, options.signal);
    if (pool?.contractId) return pool;
    if (attempt < attempts - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return findPool(hedera, tokenId, options.signal);
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
  /** Override the gas limit when a token's path needs more than CREATE_POOL_GAS. */
  gasLimit?: number | undefined;
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
  gasUsed: number;
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
      { hint: "Add to the existing pool instead of creating one." },
    );
  }

  const { decimals } = await getTokenInfo(hedera, params.tokenId);
  const tokenUnits = toUnits(params.tokenAmount, decimals);
  const hbarTinybar = toUnits(params.hbarAmount, 8);
  if (tokenUnits === 0n || hbarTinybar === 0n) {
    throw new LaunchBlocksError("POOL_AMOUNT_ZERO", "Both sides of a new pool must be greater than zero");
  }

  const quote = await quotePoolCreation(hedera, signal);
  // Alias-created accounts must be addressed by their EVM alias, not long-zero.
  const recipient = await resolveEvmAddress(hedera, hedera.operatorId.toString(), signal);
  const allowanceTransactionId = await approveRouterAllowance(hedera, params.tokenId, deployment.v1Router, tokenUnits);

  try {
    const deadline = Math.floor(Date.now() / 1000) + params.deadlineSeconds;
    const response = await new ContractExecuteTransaction()
      .setContractId(ContractId.fromString(deployment.v1Router))
      .setGas(params.gasLimit ?? CREATE_POOL_GAS)
      // msg.value carries the deposited HBAR and the pool creation fee.
      .setPayableAmount(Hbar.fromTinybars(toLong(hbarTinybar + quote.creationFeeTinybar)))
      .setFunction(
        "addLiquidityETHNewPool",
        new ContractFunctionParameters()
          .addAddress(entityIdToEvmAddress(params.tokenId))
          .addUint256(toLong(tokenUnits))
          .addUint256(toLong(applySlippage(tokenUnits, params.slippageBps)))
          .addUint256(toLong(applySlippage(hbarTinybar, params.slippageBps)))
          .addAddress(recipient)
          .addUint256(deadline),
      )
      .execute(hedera.client);
    const record = await response.getRecord(hedera.client);
    const result = record.contractFunctionResult;
    if (!result) {
      throw new LaunchBlocksError("CONTRACT_NO_RESULT", "The router call produced no contract result");
    }

    const amountToken = BigInt(result.getUint256(0).toString());
    const amountHbar = BigInt(result.getUint256(1).toString());
    const liquidity = BigInt(result.getUint256(2).toString());
    const pair = await findPoolAfterWrite(hedera, params.tokenId, signal ? { signal } : {});
    const pairId = pair?.contractId ?? null;

    return {
      tokenId: params.tokenId,
      pairId,
      pairEvmAddress: pair?.evmAddress ?? null,
      lpTokenId: pairId,
      transactionId: response.transactionId.toString(),
      allowanceTransactionId,
      tokenAmountUnits: amountToken.toString(),
      hbarAmountTinybar: amountHbar.toString(),
      liquidityUnits: liquidity.toString(),
      creationFeeHbar: quote.creationFeeHbar,
      gasUsed: Number(result.gasUsed ?? 0),
      openingPriceHbar: openingPrice(amountHbar, amountToken, decimals),
      poolUrl: pairId ? `${deployment.appBaseUrl}/liquidity/${pairId}` : deployment.appBaseUrl,
    };
  } catch (error) {
    throw translateHederaError(error, `Creating a SaucerSwap pool for ${params.tokenId}`);
  }
}

/**
 * Grant the router an allowance over the token through its ERC-20 facade.
 * This is the approval SaucerSwap's own front end asks users to sign.
 */
async function approveRouterAllowance(
  hedera: HederaContext,
  tokenId: string,
  routerId: string,
  units: bigint,
): Promise<string> {
  try {
    // An HTS token's ERC-20 facade lives at the contract id matching its token id.
    const response = await new ContractExecuteTransaction()
      .setContractId(ContractId.fromString(tokenId))
      .setGas(APPROVE_GAS)
      .setFunction(
        "approve",
        new ContractFunctionParameters().addAddress(entityIdToEvmAddress(routerId)).addUint256(toLong(units)),
      )
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
