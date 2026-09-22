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
import type { ExchangeRate } from "../hedera/mirror";
import {
  TINYBAR_PER_HBAR,
  fetchExchangeRates,
  readContract,
  resolveContractId,
  resolveEvmAddress,
  tinycentsToTinybars,
} from "../hedera/mirror";
import { getTokenInfo } from "../hedera/ops/tokens";
import {
  ADD_LIQUIDITY_GAS,
  APPROVE_GAS,
  CREATE_PAIR_GAS,
  DEFAULT_FEE_BUFFER_BPS,
  SELECTORS,
  saucerswapFor,
} from "./config";

/**
 * Seeding a SaucerSwap V1 pool from a freshly created HTS token.
 *
 * A launch has one number that must come out exactly as specified: the
 * opening price, set by the ratio of the two deposits. That drives the
 * design here.
 *
 * The router offers a one-call `addLiquidityETHNewPool`, but it deposits
 * everything in `msg.value` beyond the creation fee it computes at consensus.
 * The fee is priced in tinycents and converted with the exchange rate in
 * effect at that moment, which the caller can only estimate — on testnet the
 * mirror node's `current_rate` had expired and consensus used its
 * `next_rate`. Any estimate error lands in the pool: one run asked for 10 HBAR
 * and deposited 10.32, opening 3.2% high.
 *
 * So the pool is created in two calls:
 *
 * 1. `factory.createPair`, paying the quoted fee plus a small buffer. The
 *    factory forwards whatever exceeds the LP-token cost to SaucerSwap's rent
 *    payer, so overpaying never touches the pool; underpaying reverts here,
 *    before any liquidity moves.
 * 2. `router.addLiquidityETH`, sending exactly the HBAR to deposit. Into an
 *    empty pair the router takes both amounts as given, so the opening price
 *    is exact.
 *
 * Between the two calls someone could fund the empty pair first, but only a
 * holder of the new token can, and at launch the operator holds the supply.
 *
 * Also handled: the LP recipient must be the account's EVM alias — alias-
 * created ECDSA accounts reject the long-zero address with INVALID_ALIAS_KEY
 * on the final transfer, reported only as "Safe token transfer failed!" — and
 * the router pulls the token through an allowance granted on its ERC-20
 * facade, the approval SaucerSwap's own front end requests.
 */

export type PoolQuote = {
  /** Fee in tinybars at whichever listed rate makes it larger. */
  creationFeeTinybar: bigint;
  creationFeeHbar: string;
  /** Tinycents as the factory reports it, before conversion. */
  creationFeeTinycents: string;
  exchangeRate: ExchangeRate;
};

/**
 * What creating a pool will cost, without spending anything. The mirror
 * node lists a current and a next rate and consensus may be using either,
 * so this quotes the larger of the two conversions.
 */
export async function quotePoolCreation(hedera: HederaContext, signal?: AbortSignal): Promise<PoolQuote> {
  const { v1Factory } = saucerswapFor(hedera.network);
  const [raw, rates] = await Promise.all([
    readContract(hedera, { to: entityIdToEvmAddress(v1Factory), data: SELECTORS.pairCreateFee }, signal),
    fetchExchangeRates(hedera, signal),
  ]);
  const tinycents = decodeUint(raw);
  const candidates = [rates.current, ...(rates.next ? [rates.next] : [])].map(rate => ({
    rate,
    tinybar: tinycentsToTinybars(tinycents, rate),
  }));
  const chosen = candidates.reduce((max, candidate) => (candidate.tinybar > max.tinybar ? candidate : max));
  return {
    creationFeeTinybar: chosen.tinybar,
    creationFeeHbar: fromUnits(chosen.tinybar, 8),
    creationFeeTinycents: tinycents.toString(),
    exchangeRate: chosen.rate,
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
  /** Seconds from now the router will still accept the deposit. */
  deadlineSeconds: number;
  /** Margin on the creation fee, in basis points; the excess goes to SaucerSwap's rent payer. */
  feeBufferBps?: number | undefined;
  /** Override the gas limit for the deposit (addLiquidityETH). */
  gasLimit?: number | undefined;
  /** Override the gas limit for createPair. */
  createPairGasLimit?: number | undefined;
};

export type CreatePoolResult = {
  tokenId: string;
  pairId: string | null;
  pairEvmAddress: string | null;
  lpTokenId: string | null;
  /** The deposit (addLiquidityETH). */
  transactionId: string;
  createPairTransactionId: string;
  allowanceTransactionId: string;
  /** Deposited exactly as requested, in smallest units. */
  tokenAmountUnits: string;
  hbarAmountTinybar: string;
  liquidityUnits: string;
  /** Quoted fee, and what was actually sent to createPair including the buffer. */
  creationFeeHbar: string;
  creationFeePaidHbar: string;
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
  const feePaid = withBuffer(quote.creationFeeTinybar, params.feeBufferBps ?? DEFAULT_FEE_BUFFER_BPS);
  const tokenEvm = entityIdToEvmAddress(params.tokenId);
  // Alias-created accounts must be addressed by their EVM alias, not long-zero.
  const recipient = await resolveEvmAddress(hedera, hedera.operatorId.toString(), signal);

  // 1. Create the pair, paying the fee. Nothing is deposited yet.
  let createPairTransactionId: string;
  try {
    const response = await new ContractExecuteTransaction()
      .setContractId(ContractId.fromString(deployment.v1Factory))
      .setGas(params.createPairGasLimit ?? CREATE_PAIR_GAS)
      .setPayableAmount(Hbar.fromTinybars(toLong(feePaid)))
      .setFunction(
        "createPair",
        new ContractFunctionParameters().addAddress(tokenEvm).addAddress(entityIdToEvmAddress(deployment.whbarToken)),
      )
      .execute(hedera.client);
    await response.getReceipt(hedera.client);
    createPairTransactionId = response.transactionId.toString();
  } catch (error) {
    const translated = translateHederaError(error, `Creating the SaucerSwap pair for ${params.tokenId}`);
    throw new LaunchBlocksError(translated.code, translated.message, {
      cause: error,
      hint:
        translated.hint ??
        "If the exchange rate moved since the quote, the fee was short: retry, or raise feeBufferBps. Nothing was deposited.",
    });
  }

  // 2. Let the router pull exactly the tokens it is about to deposit.
  const allowanceTransactionId = await approveRouterAllowance(hedera, params.tokenId, deployment.v1Router, tokenUnits);

  // 3. Deposit both sides; into an empty pair the router takes them as given.
  try {
    const deadline = Math.floor(Date.now() / 1000) + params.deadlineSeconds;
    const response = await new ContractExecuteTransaction()
      .setContractId(ContractId.fromString(deployment.v1Router))
      .setGas(params.gasLimit ?? ADD_LIQUIDITY_GAS)
      .setPayableAmount(Hbar.fromTinybars(toLong(hbarTinybar)))
      .setFunction(
        "addLiquidityETH",
        new ContractFunctionParameters()
          .addAddress(tokenEvm)
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
      throw new LaunchBlocksError("CONTRACT_NO_RESULT", "The deposit produced no contract result");
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
      // On V1 the LP token is an HTS token created alongside the pair.
      lpTokenId: pairId,
      transactionId: response.transactionId.toString(),
      createPairTransactionId,
      allowanceTransactionId,
      tokenAmountUnits: amountToken.toString(),
      hbarAmountTinybar: amountHbar.toString(),
      liquidityUnits: liquidity.toString(),
      creationFeeHbar: quote.creationFeeHbar,
      creationFeePaidHbar: fromUnits(feePaid, 8),
      gasUsed: Number(result.gasUsed ?? 0),
      openingPriceHbar: openingPrice(amountHbar, amountToken, decimals),
      poolUrl: pairId ? `${deployment.appBaseUrl}/liquidity/${pairId}` : deployment.appBaseUrl,
    };
  } catch (error) {
    throw translateHederaError(error, `Depositing into the new SaucerSwap pool for ${params.tokenId}`);
  }
}

/**
 * Grant the router an allowance over the token through its ERC-20 facade,
 * which lives at the contract id matching the token id. This is the approval
 * SaucerSwap's own front end asks users to sign.
 */
async function approveRouterAllowance(
  hedera: HederaContext,
  tokenId: string,
  routerId: string,
  units: bigint,
): Promise<string> {
  try {
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

/** `amount` increased by `bps` basis points, rounded up. */
export function withBuffer(amount: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new LaunchBlocksError("FEE_BUFFER_INVALID", "Fee buffer must be an integer between 0 and 10000 basis points");
  }
  return (amount * BigInt(10_000 + bps) + 9_999n) / 10_000n;
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
