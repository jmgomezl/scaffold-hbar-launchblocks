import { chainlinkHbarUsdFor } from "../chainlink/config";
import type { ChainlinkRound } from "../chainlink/price";
import { readChainlinkRound } from "../chainlink/price";
import { LaunchBlocksError } from "../errors";
import type { DecimalAmount } from "../hedera/amounts";
import type { HederaContext } from "../hedera/context";
import { PYTH_FEEDS, pythFor } from "../pyth/config";
import type { PythPrice } from "../pyth/price";
import { readPythPrice } from "../pyth/price";
import type { Scaled } from "./decimal";
import { describeAge, formatDecimal, hbarForUsd, parseDecimal, scaled } from "./decimal";

export type OraclePriceInUsdParams = {
  /** Tokens that will go into the pool. */
  tokenAmount: DecimalAmount;
  /** The opening price of one token, in US dollars. */
  tokenPriceUsd: DecimalAmount;
  /** Refuse a Chainlink price older than this; 0 accepts any age. */
  maxAgeSeconds?: number | undefined;
  /** When Pyth's price is fresh too, refuse if the two differ by more than this, in basis points. */
  maxDeviationBps?: number | undefined;
};

export type OraclePriceInUsdResult = {
  tokenAmount: string;
  tokenPriceUsd: string;
  /** HBAR that, next to `tokenAmount` tokens, opens a pool at `tokenPriceUsd`. */
  hbarAmount: string;
  /** What each side of the pool is worth, in US dollars. */
  usdValue: string;
  /** The HBAR/USD price used. */
  hbarUsd: string;
  /** `chainlink`, or `pyth` when Chainlink was stale and Pyth's on-chain price was fresh. */
  source: "chainlink" | "pyth";
  /** The contract the price was read from. */
  feedContractId: string;
  /** Chainlink's round id; empty for a Pyth price. */
  roundId: string;
  /** When the price was written on-chain. */
  updatedAt: string;
  priceAgeSeconds: number;
  /** Pyth's HBAR/USD when it was fresh enough to cross-check, else empty. */
  crossCheckHbarUsd: string;
};

/** Chainlink's HBAR/USD heartbeat is a day; an hour more allows for a late round. */
export const DEFAULT_ORACLE_MAX_AGE_SECONDS = 90_000;
export const DEFAULT_MAX_DEVIATION_BPS = 100;
/** Pyth on Hedera is only as fresh as the last update someone posted: count it from ten minutes. */
export const PYTH_FRESH_SECONDS = 600;
const PYTH_MAX_CONFIDENCE_BPS = 100n;

/**
 * How much HBAR to pair with a token deposit so the pool opens at a US dollar price. Reads
 * Chainlink's HBAR/USD feed on Hedera, a push oracle that is always current, for free. When Pyth's
 * on-chain price is fresh too, the two must agree within `maxDeviationBps`; when Chainlink is stale,
 * a fresh Pyth price is used instead.
 */
export async function oraclePriceInUsd(
  hedera: HederaContext,
  params: OraclePriceInUsdParams,
  signal?: AbortSignal,
): Promise<OraclePriceInUsdResult> {
  const feed = chainlinkHbarUsdFor(hedera.network);
  const maxAge = params.maxAgeSeconds ?? DEFAULT_ORACLE_MAX_AGE_SECONDS;
  const maxDeviationBps = params.maxDeviationBps ?? DEFAULT_MAX_DEVIATION_BPS;
  const tokens = parseDecimal(params.tokenAmount, "Tokens to deposit");
  const unitPrice = parseDecimal(params.tokenPriceUsd, "Opening price (USD)");
  if (tokens.value === 0n || unitPrice.value === 0n) {
    throw new LaunchBlocksError("AMOUNT_INVALID", "The token amount and the opening price must be greater than zero");
  }

  const now = Math.floor(Date.now() / 1000);
  const [round, pyth] = await Promise.all([
    readChainlinkRound(hedera, feed, signal).catch((cause: unknown) => {
      if (cause instanceof LaunchBlocksError && cause.code === "CHAINLINK_NO_PRICE") return undefined;
      throw cause;
    }),
    freshPyth(hedera, now, signal),
  ]);

  const chainlinkAge = round ? Math.max(0, now - round.updatedAt) : undefined;
  const chainlinkFresh = round !== undefined && (maxAge === 0 || (chainlinkAge as number) <= maxAge);
  let chosen: { price: Scaled; source: "chainlink" | "pyth"; age: number; updatedAt: number };
  let crossCheck: Scaled | undefined;
  if (chainlinkFresh) {
    const price = scaled(round.answer, -round.decimals);
    if (pyth) {
      crossCheck = scaled(pyth.price, pyth.expo);
      const bps = deviationBps(price, crossCheck);
      if (bps > BigInt(maxDeviationBps)) {
        throw new LaunchBlocksError(
          "ORACLES_DISAGREE",
          `Chainlink (${formatDecimal(price)}) and Pyth (${formatDecimal(crossCheck)}) disagree on HBAR/USD by ${Number(bps) / 100}%, over the ${maxDeviationBps / 100}% limit`,
          { hint: "Markets may be moving fast: run again in a minute, or raise Max deviation (bps)." },
        );
      }
    }
    chosen = { price, source: "chainlink", age: chainlinkAge as number, updatedAt: round.updatedAt };
  } else if (pyth) {
    chosen = {
      price: scaled(pyth.price, pyth.expo),
      source: "pyth",
      age: Math.max(0, now - pyth.publishTime),
      updatedAt: pyth.publishTime,
    };
  } else {
    throw new LaunchBlocksError(
      "ORACLE_PRICE_STALE",
      round
        ? `Chainlink's HBAR/USD on ${hedera.network} was last updated ${describeAge(chainlinkAge as number)} ago, over the ${maxAge} s limit, and Pyth has no fresh price`
        : `Chainlink's HBAR/USD on ${hedera.network} has no price, and Pyth has no fresh price`,
      { hint: "Chainlink updates at least daily: try again later, or raise Max age (s); 0 accepts any age." },
    );
  }

  const usdValue = { value: tokens.value * unitPrice.value, scale: tokens.scale + unitPrice.scale };
  return {
    tokenAmount: formatDecimal(tokens),
    tokenPriceUsd: formatDecimal(unitPrice),
    hbarAmount: hbarForUsd(usdValue, chosen.price),
    usdValue: formatDecimal(usdValue),
    hbarUsd: formatDecimal(chosen.price),
    source: chosen.source,
    feedContractId: chosen.source === "chainlink" ? feed.contractId : pythFor(hedera.network).contractId,
    roundId: chosen.source === "chainlink" ? (round as ChainlinkRound).roundId.toString() : "",
    updatedAt: new Date(chosen.updatedAt * 1000).toISOString(),
    priceAgeSeconds: chosen.age,
    crossCheckHbarUsd: crossCheck ? formatDecimal(crossCheck) : "",
  };
}

/** Pyth's on-chain HBAR/USD when it is fresh and tight enough to rely on, else undefined. */
async function freshPyth(hedera: HederaContext, now: number, signal?: AbortSignal): Promise<PythPrice | undefined> {
  let price: PythPrice;
  try {
    price = await readPythPrice(hedera, PYTH_FEEDS.hbarUsd, signal);
  } catch (cause) {
    // No Pyth deployment or no price is not an error here: Pyth is only the second source.
    if (cause instanceof LaunchBlocksError && ["PYTH_UNAVAILABLE", "PYTH_NO_PRICE"].includes(cause.code)) {
      return undefined;
    }
    throw cause;
  }
  const fresh = now - price.publishTime <= PYTH_FRESH_SECONDS;
  const tight = price.conf * 10_000n <= price.price * PYTH_MAX_CONFIDENCE_BPS;
  return fresh && tight ? price : undefined;
}

/** |a - b| / a, in basis points. */
function deviationBps(a: Scaled, b: Scaled): bigint {
  const scale = Math.max(a.scale, b.scale);
  const av = a.value * 10n ** BigInt(scale - a.scale);
  const bv = b.value * 10n ** BigInt(scale - b.scale);
  const diff = av > bv ? av - bv : bv - av;
  return (diff * 10_000n) / av;
}
