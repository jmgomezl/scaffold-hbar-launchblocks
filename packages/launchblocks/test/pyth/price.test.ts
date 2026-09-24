import { ContractExecuteTransaction, Transaction } from "@hiero-ledger/sdk";
import { encodeFunctionResult, parseAbi, toFunctionSelector, toHex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createHederaContext } from "../../src/hedera/client";
import type { HederaContext } from "../../src/hedera/context";
import { PYTH_FEEDS } from "../../src/pyth/config";
import { hermesPriceUpdates } from "../../src/pyth/hermes";
import { priceInUsd, readPythPrice } from "../../src/pyth/price";
import { offlineHederaContext } from "../helpers/hedera";

afterEach(() => vi.restoreAllMocks());

const ABI = parseAbi([
  "function getPriceUnsafe(bytes32 id) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime))",
  "function getUpdateFee(bytes[] updateData) view returns (uint256 feeAmount)",
  "function updatePriceFeeds(bytes[] updateData) payable",
]);
const now = () => Math.floor(Date.now() / 1000);

type OnChain = { price: bigint; conf: bigint; expo: number; publishTime: bigint };
const json = (body: unknown, status = 200) =>
  ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

/** The mirror node and Pyth's contract, as far as these steps use them. */
function mockPyth(prices: OnChain[], fee = 1n) {
  const reads: string[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/api/v1/contracts/call")) {
      const { data, to } = JSON.parse(String(init?.body)) as { data: string; to: string };
      expect(to).toBe("0xa2aa501b19aff244d90cc15a4cf739d2725b5729");
      if (data.startsWith(toFunctionSelector(ABI[0]))) {
        reads.push("getPriceUnsafe");
        const price = prices.length > 1 ? prices.shift()! : prices[0]!;
        return json({ result: encodeFunctionResult({ abi: ABI, functionName: "getPriceUnsafe", result: price }) });
      }
      if (data.startsWith(toFunctionSelector(ABI[1]))) {
        reads.push("getUpdateFee");
        return json({ result: encodeFunctionResult({ abi: ABI, functionName: "getUpdateFee", result: fee }) });
      }
    }
    if (url.includes("/api/v1/blocks")) return json({ blocks: [{ timestamp: { to: String(now() + 5) } }] });
    throw new Error(`unexpected fetch ${url}`);
  });
  return { spy, reads };
}

/** HBAR at $0.08055012, as Pyth stores it: price × 10^-8. */
const HBAR_USD = (publishTime: number, conf = 5_531n): OnChain => ({
  price: 8_055_012n,
  conf,
  expo: -8,
  publishTime: BigInt(publishTime),
});

describe("priceInUsd() without a price source", () => {
  it("pairs a token deposit with the HBAR worth the same in dollars, rounded down to a tinybar", async () => {
    mockPyth([HBAR_USD(now() - 10)]);
    const hedera = offlineHederaContext();
    try {
      const result = await priceInUsd(hedera, { tokenAmount: "50000", tokenPriceUsd: "0.00002" });
      // $1 at $0.08055012 per HBAR is 12.414630792… HBAR.
      expect(result).toMatchObject({
        tokenAmount: "50000",
        usdValue: "1",
        hbarAmount: "12.41463079",
        hbarUsd: "0.08055012",
        confidenceUsd: "0.00005531",
        source: "on-chain",
        pythContractId: "0.0.3042133",
      });
      expect(result.updateTransactionId).toBe("");
      expect(result.tokenPriceUsd).toBe("0.00002");
      expect(result.priceAgeSeconds).toBeGreaterThanOrEqual(10);
    } finally {
      hedera.client.close();
    }
  });

  it("keeps full precision for large supplies and tiny prices, beyond the 64-bit token limit", async () => {
    mockPyth([HBAR_USD(now())]);
    const hedera = offlineHederaContext();
    try {
      const result = await priceInUsd(hedera, {
        tokenAmount: "1000000000000.123456789",
        tokenPriceUsd: 2e-9,
        maxAgeSeconds: 0,
      });
      expect(result.usdValue).toBe("2000.000000000246913578");
      expect(result.hbarAmount).toBe("24829.26158272"); // 24829.2615827294…, rounded down
    } finally {
      hedera.client.close();
    }
  });

  it("refuses a stale price, pointing at PYTH_API_KEY, unless any age is allowed", async () => {
    mockPyth([HBAR_USD(now() - 32 * 86_400)]);
    const hedera = offlineHederaContext();
    try {
      await expect(priceInUsd(hedera, { tokenAmount: "1", tokenPriceUsd: "1" })).rejects.toMatchObject({
        code: "PYTH_PRICE_STALE",
        message: expect.stringContaining("32 days ago"),
        hint: expect.stringContaining("PYTH_API_KEY"),
      });
      await expect(
        priceInUsd(hedera, { tokenAmount: "1", tokenPriceUsd: "1", maxAgeSeconds: 0 }),
      ).resolves.toMatchObject({ source: "on-chain" });
    } finally {
      hedera.client.close();
    }
  });

  it("refuses a price whose confidence interval is too wide", async () => {
    mockPyth([HBAR_USD(now(), 200_000n)]); // ±2.5%
    const hedera = offlineHederaContext();
    try {
      await expect(priceInUsd(hedera, { tokenAmount: "1", tokenPriceUsd: "1" })).rejects.toMatchObject({
        code: "PYTH_PRICE_UNCERTAIN",
      });
      await expect(
        priceInUsd(hedera, { tokenAmount: "1", tokenPriceUsd: "1", maxConfidenceBps: 300 }),
      ).resolves.toBeDefined();
    } finally {
      hedera.client.close();
    }
  });

  it("reports a feed the contract has never priced", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ _status: { messages: [{ message: "revert" }] } }, 400));
    const hedera = offlineHederaContext();
    try {
      await expect(readPythPrice(hedera, PYTH_FEEDS.hbarUsd)).rejects.toMatchObject({ code: "PYTH_NO_PRICE" });
    } finally {
      hedera.client.close();
    }
  });
});

describe("priceInUsd() with a price source", () => {
  it("posts the signed update with the contract's fee, then reads the fresh price", async () => {
    const { reads } = mockPyth([HBAR_USD(now())], 1n);
    const updates = vi.fn(async () => ["0xdeadbeef"] as `0x${string}`[]);
    const hedera: HederaContext = { ...offlineHederaContext(), pythPriceUpdates: updates };
    const sent: Transaction[] = [];
    vi.spyOn(Transaction.prototype, "execute").mockImplementation(async function (this: Transaction) {
      sent.push(this);
      return {
        transactionId: { toString: () => "0.0.4242@1790000000.000000001" },
        getRecord: async () => ({
          receipt: { status: { toString: () => "SUCCESS" } },
          contractFunctionResult: { bytes: new Uint8Array(), gasUsed: 812_345 },
        }),
      } as never;
    });
    try {
      const result = await priceInUsd(hedera, { tokenAmount: "50000", tokenPriceUsd: "0.00002" });
      expect(updates).toHaveBeenCalledWith([PYTH_FEEDS.hbarUsd], undefined);
      expect(reads).toEqual(["getUpdateFee", "getPriceUnsafe"]);
      const [update] = sent as ContractExecuteTransaction[];
      expect(update).toBeInstanceOf(ContractExecuteTransaction);
      expect(update?.contractId?.toString()).toBe("0.0.3042133");
      expect(update?.payableAmount?.toTinybars().toString()).toBe("1");
      expect(toHex(update?.functionParameters ?? new Uint8Array()).slice(0, 10)).toBe(toFunctionSelector(ABI[2]));
      expect(result).toMatchObject({ source: "posted", updateTransactionId: "0.0.4242@1790000000.000000001" });
    } finally {
      hedera.client.close();
    }
  });
});

describe("hermesPriceUpdates()", () => {
  it("sends the API key as a Bearer token and returns 0x-prefixed updates", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ binary: { encoding: "hex", data: ["504e4155"] } }));
    const updates = await hermesPriceUpdates({ apiKey: "test-key" })([PYTH_FEEDS.hbarUsd]);
    expect(updates).toEqual(["0x504e4155"]);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${PYTH_FEEDS.hbarUsd}`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");
    expect(init.redirect).toBe("error");
  });

  it("names the feed when the key's plan does not cover it", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () =>
        "Not entitled: feed 3728e5… (no grant accepts this feed (asset type 'crypto', instrument type 'spot'))",
    } as Response);
    await expect(hermesPriceUpdates({ apiKey: "k" })([PYTH_FEEDS.hbarUsd])).rejects.toMatchObject({
      code: "PYTH_NOT_ENTITLED",
      message: expect.stringContaining("instrument type 'spot'"),
      hint: expect.stringContaining("crypto spot"),
    });
  });

  it("explains a rejected key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json("unauthorized", 401));
    await expect(hermesPriceUpdates({ apiKey: "wrong" })([PYTH_FEEDS.hbarUsd])).rejects.toMatchObject({
      code: "PYTH_API_KEY_REJECTED",
      hint: expect.stringContaining("Pyth Terminal"),
    });
  });

  it("is what an operator context uses when PYTH_API_KEY is set, and only then", () => {
    const base = {
      network: "testnet" as const,
      operatorId: "0.0.4242",
      operatorKey: "302e020100300506032b657004220420" + "11".repeat(32),
    };
    const withKey = createHederaContext({ ...base, pythApiKey: "k" });
    const withoutKey = createHederaContext({ ...base, pythApiKey: "  " });
    try {
      expect(typeof withKey.pythPriceUpdates).toBe("function");
      expect(withoutKey.pythPriceUpdates).toBeUndefined();
    } finally {
      withKey.client.close();
      withoutKey.client.close();
    }
  });
});
