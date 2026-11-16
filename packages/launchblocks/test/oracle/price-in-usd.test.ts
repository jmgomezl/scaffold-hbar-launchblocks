import { encodeFunctionResult, parseAbi, toFunctionSelector } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CHAINLINK_HBAR_USD } from "../../src/chainlink/config";
import { LaunchBlocksError } from "../../src/errors";
import { oraclePriceInUsd } from "../../src/oracle/price-in-usd";
import { PYTH_DEPLOYMENTS } from "../../src/pyth/config";
import { offlineHederaContext } from "../helpers/hedera";

afterEach(() => vi.restoreAllMocks());

const CHAINLINK_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);
const PYTH_ABI = parseAbi([
  "function getPriceUnsafe(bytes32 id) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime))",
]);
const CHAINLINK = CHAINLINK_HBAR_USD.testnet!.evmAddress.toLowerCase();
const PYTH = PYTH_DEPLOYMENTS.testnet!.evmAddress.toLowerCase();
const now = () => Math.floor(Date.now() / 1000);
const json = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

type Round = { answer: bigint; updatedAt: number; roundId?: bigint; answeredInRound?: bigint };
type PythPrice = { price: bigint; conf?: bigint; publishTime: number };

/** Chainlink's and Pyth's HBAR/USD contracts, read through the mirror node. */
function mockFeeds(round: Round, pyth: PythPrice) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.endsWith("/api/v1/contracts/call")) throw new Error(`unexpected fetch ${url}`);
    const { to, data } = JSON.parse(String(init?.body)) as { to: string; data: string };
    if (to.toLowerCase() === CHAINLINK) {
      if (data.startsWith(toFunctionSelector(CHAINLINK_ABI[0])))
        return json({ result: encodeFunctionResult({ abi: CHAINLINK_ABI, functionName: "decimals", result: 8 }) });
      const roundId = round.roundId ?? 777n;
      return json({
        result: encodeFunctionResult({
          abi: CHAINLINK_ABI,
          functionName: "latestRoundData",
          result: [
            roundId,
            round.answer,
            BigInt(round.updatedAt),
            BigInt(round.updatedAt),
            round.answeredInRound ?? roundId,
          ],
        }),
      });
    }
    if (to.toLowerCase() === PYTH) {
      return json({
        result: encodeFunctionResult({
          abi: PYTH_ABI,
          functionName: "getPriceUnsafe",
          result: { price: pyth.price, conf: pyth.conf ?? 5_000n, expo: -8, publishTime: BigInt(pyth.publishTime) },
        }),
      });
    }
    throw new Error(`unexpected contract ${to}`);
  });
}

const params = { tokenAmount: "50000", tokenPriceUsd: "0.00002" };
/** Pyth's price on Hedera today: last posted in August. */
const STALE_PYTH = { price: 8_055_012n, publishTime: now() - 60 * 86_400 };

async function failure(promise: Promise<unknown>): Promise<LaunchBlocksError> {
  const error = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(LaunchBlocksError);
  return error as LaunchBlocksError;
}

describe("oraclePriceInUsd()", () => {
  it("prices the pool from Chainlink, exact to the tinybar, when Pyth has nothing fresh", async () => {
    mockFeeds({ answer: 8_018_123n, updatedAt: now() - 640 }, STALE_PYTH);
    const result = await oraclePriceInUsd(offlineHederaContext(), params);
    // $1 at $0.08018123 per HBAR is 12.471746816… HBAR, rounded down to the tinybar.
    expect(result).toMatchObject({
      tokenAmount: "50000",
      usdValue: "1",
      hbarAmount: "12.47174681",
      hbarUsd: "0.08018123",
      source: "chainlink",
      feedContractId: "0.0.4870176",
      roundId: "777",
      crossCheckHbarUsd: "",
    });
    expect(result.priceAgeSeconds).toBeGreaterThanOrEqual(640);
  });

  it("cross-checks with a fresh Pyth price and keeps Chainlink's when they agree", async () => {
    mockFeeds({ answer: 8_100_000n, updatedAt: now() - 30 }, { price: 8_120_000n, publishTime: now() - 20 });
    const result = await oraclePriceInUsd(offlineHederaContext(), params);
    expect(result).toMatchObject({ source: "chainlink", hbarUsd: "0.081", hbarAmount: "12.34567901" });
    expect(result.crossCheckHbarUsd).toBe("0.0812");
  });

  it("refuses when the two disagree by more than the limit", async () => {
    mockFeeds({ answer: 8_000_000n, updatedAt: now() - 30 }, { price: 8_200_000n, publishTime: now() - 20 });
    const error = await failure(oraclePriceInUsd(offlineHederaContext(), { ...params, maxDeviationBps: 100 }));
    expect(error.code).toBe("ORACLES_DISAGREE");
    expect(error.message).toContain("2.5%");
  });

  it("falls back to a fresh Pyth price when Chainlink is stale", async () => {
    mockFeeds({ answer: 8_000_000n, updatedAt: now() - 2 * 86_400 }, { price: 8_100_000n, publishTime: now() - 20 });
    const result = await oraclePriceInUsd(offlineHederaContext(), params);
    expect(result).toMatchObject({ source: "pyth", hbarUsd: "0.081", feedContractId: "0.0.3042133", roundId: "" });
  });

  it("ignores a fresh Pyth price whose confidence interval is too wide", async () => {
    mockFeeds(
      { answer: 8_000_000n, updatedAt: now() - 2 * 86_400 },
      { price: 8_100_000n, conf: 200_000n, publishTime: now() - 20 },
    );
    const error = await failure(oraclePriceInUsd(offlineHederaContext(), params));
    expect(error.code).toBe("ORACLE_PRICE_STALE");
  });

  it("refuses when neither source is fresh, saying how old Chainlink's price is", async () => {
    mockFeeds({ answer: 8_000_000n, updatedAt: now() - 2 * 86_400 }, STALE_PYTH);
    const error = await failure(oraclePriceInUsd(offlineHederaContext(), params));
    expect(error.code).toBe("ORACLE_PRICE_STALE");
    expect(error.message).toContain("last updated 2 days ago");
  });

  it("accepts any age with a Max age of 0", async () => {
    mockFeeds({ answer: 8_000_000n, updatedAt: now() - 2 * 86_400 }, STALE_PYTH);
    const result = await oraclePriceInUsd(offlineHederaContext(), { ...params, maxAgeSeconds: 0 });
    expect(result.source).toBe("chainlink");
  });

  it("treats an incomplete round as no price", async () => {
    mockFeeds({ answer: 8_000_000n, updatedAt: now() - 30, roundId: 9n, answeredInRound: 8n }, STALE_PYTH);
    const error = await failure(oraclePriceInUsd(offlineHederaContext(), params));
    expect(error.code).toBe("ORACLE_PRICE_STALE");
    expect(error.message).toContain("has no price");
  });

  it("refuses a zero amount or price before reading anything", async () => {
    const spy = mockFeeds({ answer: 8_000_000n, updatedAt: now() }, STALE_PYTH);
    const error = await failure(oraclePriceInUsd(offlineHederaContext(), { tokenAmount: "0", tokenPriceUsd: "1" }));
    expect(error.code).toBe("AMOUNT_INVALID");
    expect(spy).not.toHaveBeenCalled();
  });
});
