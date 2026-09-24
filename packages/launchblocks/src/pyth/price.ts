import { ContractExecuteTransaction, ContractId, Hbar } from "@hiero-ledger/sdk";
import { decodeFunctionResult, encodeFunctionData, hexToBytes, parseAbi } from "viem";

import { LaunchBlocksError } from "../errors";
import type { DecimalAmount } from "../hedera/amounts";
import { fromUnits, numberToDecimalString, toLong } from "../hedera/amounts";
import type { HederaContext } from "../hedera/context";
import { readContract, waitForMirror } from "../hedera/mirror";
import { sendContract } from "../hedera/ops/submit";
import { PYTH_FEEDS, PYTH_UPDATE_GAS, pythFor } from "./config";

const PYTH_ABI = parseAbi([
  "function getPriceUnsafe(bytes32 id) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime))",
  "function getUpdateFee(bytes[] updateData) view returns (uint256 feeAmount)",
  "function updatePriceFeeds(bytes[] updateData) payable",
]);

/** A Pyth price as its contract stores it: `price × 10^expo`, with a confidence interval in the same units. */
export type PythPrice = {
  feedId: string;
  price: bigint;
  conf: bigint;
  expo: number;
  /** Unix seconds. */
  publishTime: number;
};

/**
 * The price Pyth's contract on Hedera holds now, read for free through the
 * mirror node. It is only as fresh as the last update anyone posted.
 */
export async function readPythPrice(hedera: HederaContext, feedId: string, signal?: AbortSignal): Promise<PythPrice> {
  const { evmAddress } = pythFor(hedera.network);
  const data = encodeFunctionData({ abi: PYTH_ABI, functionName: "getPriceUnsafe", args: [feedId as `0x${string}`] });
  let raw: string;
  try {
    raw = await readContract(hedera, { to: evmAddress, data }, signal);
  } catch (cause) {
    throw new LaunchBlocksError(
      "PYTH_NO_PRICE",
      `Pyth's contract on ${hedera.network} has no price for feed ${feedId}`,
      {
        cause,
        hint: "Set PYTH_API_KEY so the step posts a price update first.",
      },
    );
  }
  const price = decodeFunctionResult({ abi: PYTH_ABI, functionName: "getPriceUnsafe", data: raw as `0x${string}` });
  if (price.price <= 0n) {
    throw new LaunchBlocksError("PYTH_NO_PRICE", `Pyth's price for feed ${feedId} is not positive`);
  }
  return { feedId, price: price.price, conf: price.conf, expo: price.expo, publishTime: Number(price.publishTime) };
}

export type PostedUpdate = { transactionId: string; feeTinybar: string; gasUsed: number };

/**
 * Post fresh signed prices to Pyth's contract: fetch them from the context's
 * price source, ask the contract for its fee (1 tinybar per update on
 * testnet, none on mainnet), and call `updatePriceFeeds` with that fee.
 */
export async function postPythUpdate(
  hedera: HederaContext,
  feedIds: readonly string[],
  signal?: AbortSignal,
): Promise<PostedUpdate> {
  if (!hedera.pythPriceUpdates) {
    throw new LaunchBlocksError("PYTH_NOT_CONFIGURED", "No Pyth price source is configured", {
      hint: "Set PYTH_API_KEY, a Hermes key from Pyth Terminal.",
    });
  }
  const { contractId, evmAddress } = pythFor(hedera.network);
  const updates = await hedera.pythPriceUpdates(feedIds, signal);
  const feeRaw = await readContract(
    hedera,
    { to: evmAddress, data: encodeFunctionData({ abi: PYTH_ABI, functionName: "getUpdateFee", args: [updates] }) },
    signal,
  );
  // Hedera's EVM counts msg.value in tinybars.
  const fee = decodeFunctionResult({ abi: PYTH_ABI, functionName: "getUpdateFee", data: feeRaw as `0x${string}` });
  const transaction = new ContractExecuteTransaction()
    .setContractId(ContractId.fromString(contractId))
    .setGas(PYTH_UPDATE_GAS)
    .setPayableAmount(Hbar.fromTinybars(toLong(fee)))
    .setFunctionParameters(
      hexToBytes(encodeFunctionData({ abi: PYTH_ABI, functionName: "updatePriceFeeds", args: [updates] })),
    );
  const outcome = await sendContract(hedera, transaction, "Posting a Pyth price update", signal);
  return { transactionId: outcome.transactionId, feeTinybar: fee.toString(), gasUsed: outcome.gasUsed };
}

export type PriceInUsdParams = {
  /** Tokens that will go into the pool. */
  tokenAmount: DecimalAmount;
  /** The opening price of one token, in US dollars. */
  tokenPriceUsd: DecimalAmount;
  /** Refuse a price older than this; 0 accepts any age. */
  maxAgeSeconds?: number | undefined;
  /** Refuse a price whose confidence interval is wider than this share of it, in basis points. */
  maxConfidenceBps?: number | undefined;
};

export type PriceInUsdResult = {
  tokenAmount: string;
  tokenPriceUsd: string;
  /** HBAR that, next to `tokenAmount` tokens, opens a pool at `tokenPriceUsd`. */
  hbarAmount: string;
  /** What each side of the pool is worth, in US dollars. */
  usdValue: string;
  /** The HBAR/USD price used. */
  hbarUsd: string;
  confidenceUsd: string;
  publishTime: string;
  priceAgeSeconds: number;
  /** `posted` when this run posted a fresh update, `on-chain` when it used the price already there. */
  source: "posted" | "on-chain";
  pythContractId: string;
  /** The price update this run posted; empty when it used the price already on-chain. */
  updateTransactionId: string;
};

export const DEFAULT_MAX_PRICE_AGE_SECONDS = 120;
export const DEFAULT_MAX_CONFIDENCE_BPS = 100;

/**
 * How much HBAR to pair with a token deposit so the pool opens at a US dollar
 * price, from Pyth's HBAR/USD feed on Hedera. With a price source (a Hermes
 * API key), it posts a fresh update first, so the price is seconds old;
 * without one, it uses the price already on-chain, subject to `maxAgeSeconds`.
 */
export async function priceInUsd(
  hedera: HederaContext,
  params: PriceInUsdParams,
  signal?: AbortSignal,
): Promise<PriceInUsdResult> {
  const { contractId } = pythFor(hedera.network);
  const maxAge = params.maxAgeSeconds ?? DEFAULT_MAX_PRICE_AGE_SECONDS;
  const maxConfidenceBps = params.maxConfidenceBps ?? DEFAULT_MAX_CONFIDENCE_BPS;
  const tokens = parseDecimal(params.tokenAmount, "Tokens to deposit");
  const unitPrice = parseDecimal(params.tokenPriceUsd, "Opening price (USD)");
  if (tokens.value === 0n || unitPrice.value === 0n) {
    throw new LaunchBlocksError("AMOUNT_INVALID", "The token amount and the opening price must be greater than zero");
  }

  let updateTransactionId: string | undefined;
  if (hedera.pythPriceUpdates) {
    const startedAt = Date.now();
    updateTransactionId = (await postPythUpdate(hedera, [PYTH_FEEDS.hbarUsd], signal)).transactionId;
    await waitForMirror(hedera, startedAt, signal ? { signal } : {});
  }
  const price = await readPythPrice(hedera, PYTH_FEEDS.hbarUsd, signal);

  const age = Math.max(0, Math.floor(Date.now() / 1000) - price.publishTime);
  if (maxAge > 0 && age > maxAge) {
    throw new LaunchBlocksError(
      "PYTH_PRICE_STALE",
      `Pyth's HBAR/USD on ${hedera.network} was last posted ${describeAge(age)} ago, over the ${maxAge} s limit`,
      {
        hint: updateTransactionId
          ? "A fresh update was posted, but the mirror node still shows the old price: run again in a few seconds."
          : "Set PYTH_API_KEY (a Hermes key from Pyth Terminal) so this step posts a fresh price first, or raise Max age (s); 0 accepts any age.",
      },
    );
  }
  if (price.conf * 10_000n > price.price * BigInt(maxConfidenceBps)) {
    throw new LaunchBlocksError(
      "PYTH_PRICE_UNCERTAIN",
      `Pyth's HBAR/USD confidence interval is wider than ${maxConfidenceBps / 100}% of the price`,
      { hint: "Markets may be moving fast: run again later, or raise Max confidence (bps)." },
    );
  }

  const hbarUsd = scaled(price.price, price.expo);
  const usdValue = { value: tokens.value * unitPrice.value, scale: tokens.scale + unitPrice.scale };
  // tinybar = usdValue / hbarUsd × 10^8, rounded down to a whole tinybar.
  const tinybar =
    (usdValue.value * 10n ** BigInt(hbarUsd.scale) * 10n ** 8n) / (hbarUsd.value * 10n ** BigInt(usdValue.scale));

  return {
    tokenAmount: format(tokens),
    tokenPriceUsd: format(unitPrice),
    hbarAmount: fromUnits(tinybar, 8),
    usdValue: format(usdValue),
    hbarUsd: format(hbarUsd),
    confidenceUsd: format(scaled(price.conf, price.expo)),
    publishTime: new Date(price.publishTime * 1000).toISOString(),
    priceAgeSeconds: age,
    source: updateTransactionId ? "posted" : "on-chain",
    pythContractId: contractId,
    updateTransactionId: updateTransactionId ?? "",
  };
}

type Scaled = { value: bigint; scale: number };

/** An exact decimal, without the HTS 64-bit cap that token amounts have. */
function parseDecimal(amount: DecimalAmount, label: string): Scaled {
  const text = typeof amount === "number" ? numberToDecimalString(amount) : amount.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new LaunchBlocksError("AMOUNT_INVALID", `${label} "${amount}" must be a non-negative decimal`);
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return { value: BigInt(`${match[1]}${fraction}`), scale: fraction.length };
}

function scaled(value: bigint, expo: number): Scaled {
  return expo >= 0 ? { value: value * 10n ** BigInt(expo), scale: 0 } : { value, scale: -expo };
}

function format({ value, scale }: Scaled): string {
  if (scale === 0) return value.toString();
  const text = value.toString().padStart(scale + 1, "0");
  const whole = text.slice(0, -scale);
  const fraction = text.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function describeAge(seconds: number): string {
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86_400)} days`;
}
