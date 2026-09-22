import { ContractExecuteTransaction, ContractFunctionParameters, ContractId, Hbar } from "@hiero-ledger/sdk";

import { LaunchBlocksError } from "../errors";
import { decodeUint, encodeAddress, encodeCall, encodeUint, entityIdToEvmAddress } from "../hedera/abi";
import type { DecimalAmount } from "../hedera/amounts";
import { fromUnits, toLong, toUnits } from "../hedera/amounts";
import type { HederaContext } from "../hedera/context";
import { translateHederaError } from "../hedera/errors";
import { readContract, resolveEvmAddress } from "../hedera/mirror";
import { getTokenInfo } from "../hedera/ops/tokens";
import { SELECTORS, SWAP_GAS, saucerswapFor } from "./config";
import { applySlippage } from "./pool";

/**
 * Buying a token with HBAR on SaucerSwap V1: the trade that proves a freshly
 * seeded pool is a working market. Quotes come from the router's own
 * `getAmountsOut` through the mirror node, so quoting costs nothing and uses
 * exactly the maths the swap will.
 */

export type SwapQuote = {
  /** Smallest token units the router would return right now. */
  tokensOutUnits: bigint;
  hbarInTinybar: bigint;
};

export type QuoteOptions = {
  /**
   * Retries while the mirror node catches up. The quote is simulated on the
   * mirror's copy of state, which trails consensus by a few seconds: straight
   * after a pool is funded it still sees an empty pool.
   */
  attempts?: number;
  delayMs?: number;
  signal?: AbortSignal | undefined;
};

/** Quote HBAR → token through the pool, without spending anything. */
export async function quoteHbarForTokens(
  hedera: HederaContext,
  tokenId: string,
  hbarInTinybar: bigint,
  options: QuoteOptions = {},
): Promise<SwapQuote> {
  const { v1Router, whbarToken } = saucerswapFor(hedera.network);
  const data = encodeCall(
    SELECTORS.getAmountsOut,
    encodeUint(hbarInTinybar),
    encodeUint(64), // offset of the dynamic path array: two head words
    encodeUint(2),
    encodeAddress(entityIdToEvmAddress(whbarToken)),
    encodeAddress(entityIdToEvmAddress(tokenId)),
  );
  const attempts = options.attempts ?? 1;
  const delayMs = options.delayMs ?? 1500;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
    try {
      const raw = await readContract(hedera, { to: entityIdToEvmAddress(v1Router), data }, options.signal);
      // uint256[] return: [offset, length, amountIn, amountOut]
      const tokensOutUnits = decodeUint(raw, 3);
      if (tokensOutUnits > 0n) return { tokensOutUnits, hbarInTinybar };
      lastError = new LaunchBlocksError(
        "SWAP_NO_LIQUIDITY",
        `The pool for ${tokenId} would return nothing for this amount`,
      );
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof LaunchBlocksError && lastError.code === "SWAP_NO_LIQUIDITY") throw lastError;
  throw new LaunchBlocksError("SWAP_QUOTE_FAILED", `Could not quote HBAR → ${tokenId}`, {
    cause: lastError,
    hint:
      "The token needs a SaucerSwap pool against HBAR (saucerswap.createPool). If one was just created, " +
      "the mirror node may not have caught up yet: retry in a few seconds.",
  });
}

export type SwapParams = {
  tokenId: string;
  /** HBAR to spend. */
  hbarAmount: DecimalAmount;
  /** Tolerated shortfall against the quote, in basis points (100 = 1%). */
  slippageBps: number;
  deadlineSeconds: number;
  gasLimit?: number | undefined;
};

export type SwapResult = {
  tokenId: string;
  transactionId: string;
  hbarInTinybar: string;
  tokensOutUnits: string;
  /** Human amount received. */
  tokensOut: string;
  /** Quote taken just before the swap, for comparison with what was filled. */
  quotedUnits: string;
  /** HBAR paid per whole token on this trade. */
  effectivePriceHbar: string;
};

export async function swapHbarForTokens(
  hedera: HederaContext,
  params: SwapParams,
  signal?: AbortSignal,
): Promise<SwapResult> {
  const { v1Router, whbarToken } = saucerswapFor(hedera.network);
  const { decimals } = await getTokenInfo(hedera, params.tokenId);
  const hbarInTinybar = toUnits(params.hbarAmount, 8);
  if (hbarInTinybar === 0n) throw new LaunchBlocksError("SWAP_AMOUNT_ZERO", "Swap amount must be greater than zero");

  // Often runs right after the pool is funded, so give the mirror node time to catch up.
  const quote = await quoteHbarForTokens(hedera, params.tokenId, hbarInTinybar, { attempts: 8, signal });
  // Alias-created accounts must be addressed by their EVM alias, not long-zero.
  const recipient = await resolveEvmAddress(hedera, hedera.operatorId.toString(), signal);
  const deadline = Math.floor(Date.now() / 1000) + params.deadlineSeconds;

  try {
    const response = await new ContractExecuteTransaction()
      .setContractId(ContractId.fromString(v1Router))
      .setGas(params.gasLimit ?? SWAP_GAS)
      .setPayableAmount(Hbar.fromTinybars(toLong(hbarInTinybar)))
      .setFunction(
        "swapExactETHForTokens",
        new ContractFunctionParameters()
          .addUint256(toLong(applySlippage(quote.tokensOutUnits, params.slippageBps)))
          .addAddressArray([entityIdToEvmAddress(whbarToken), entityIdToEvmAddress(params.tokenId)])
          .addAddress(recipient)
          .addUint256(deadline),
      )
      .execute(hedera.client);
    const record = await response.getRecord(hedera.client);
    const result = record.contractFunctionResult;
    if (!result) throw new LaunchBlocksError("CONTRACT_NO_RESULT", "The swap produced no contract result");

    // uint256[] return: [offset, length, amountIn, amountOut]
    const tokensOutUnits = BigInt(result.getUint256(3).toString());
    return {
      tokenId: params.tokenId,
      transactionId: response.transactionId.toString(),
      hbarInTinybar: hbarInTinybar.toString(),
      tokensOutUnits: tokensOutUnits.toString(),
      tokensOut: fromUnits(tokensOutUnits, decimals),
      quotedUnits: quote.tokensOutUnits.toString(),
      effectivePriceHbar: effectivePrice(hbarInTinybar, tokensOutUnits, decimals),
    };
  } catch (error) {
    throw translateHederaError(error, `Swapping HBAR for ${params.tokenId}`);
  }
}

/** HBAR per whole token for a fill, truncated to tinybar precision. */
export function effectivePrice(hbarInTinybar: bigint, tokenUnits: bigint, decimals: number): string {
  if (tokenUnits === 0n) return "0";
  return fromUnits((hbarInTinybar * 10n ** BigInt(decimals)) / tokenUnits, 8);
}
