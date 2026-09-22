import { afterEach, describe, expect, it, vi } from "vitest";

import { effectivePrice, quoteHbarForTokens } from "../../src/saucerswap/swap";
import { offlineHederaContext } from "../helpers/hedera";

afterEach(() => vi.restoreAllMocks());

const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, "0");

function mockContractCall(result: string | null, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => (result === null ? {} : { result }),
    text: async () => "",
  } as Response);
}

describe("quoteHbarForTokens()", () => {
  it("asks the router for getAmountsOut along WHBAR → token and returns amountOut", async () => {
    const spy = mockContractCall(`0x${word(32)}${word(2)}${word(100_000_000)}${word(453_305_446_940n)}`);
    const hedera = offlineHederaContext();
    try {
      const quote = await quoteHbarForTokens(hedera, "0.0.10668801", 100_000_000n);
      expect(quote.tokensOutUnits).toBe(453_305_446_940n);

      const body = JSON.parse(String((spy.mock.calls[0]?.[1] as RequestInit).body)) as { to: string; data: string };
      expect(body.to).toBe("0x0000000000000000000000000000000000004b40"); // testnet router 0.0.19264
      expect(body.data.slice(0, 10)).toBe("0xd06ca61f");
      const words = body.data.slice(10).match(/.{64}/g) ?? [];
      expect(words.map(w => BigInt(`0x${w}`))).toEqual([100_000_000n, 64n, 2n, 15058n, 10668801n]);
    } finally {
      hedera.client.close();
    }
  });

  it("retries while the mirror node has not seen the pool's liquidity yet", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}), text: async () => "" } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: `0x${word(32)}${word(2)}${word(1)}${word(5)}` }),
        text: async () => "",
      } as Response);
    const hedera = offlineHederaContext();
    try {
      const quote = await quoteHbarForTokens(hedera, "0.0.5", 1n, { attempts: 3, delayMs: 1 });
      expect(quote.tokensOutUnits).toBe(5n);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      hedera.client.close();
    }
  });

  it("refuses a quote of zero", async () => {
    mockContractCall(`0x${word(32)}${word(2)}${word(1)}${word(0)}`);
    const hedera = offlineHederaContext();
    try {
      await expect(quoteHbarForTokens(hedera, "0.0.5", 1n)).rejects.toMatchObject({ code: "SWAP_NO_LIQUIDITY" });
    } finally {
      hedera.client.close();
    }
  });

  it("explains a failed quote as a missing pool", async () => {
    mockContractCall(null, 400);
    const hedera = offlineHederaContext();
    try {
      await expect(quoteHbarForTokens(hedera, "0.0.5", 1n)).rejects.toMatchObject({
        code: "SWAP_QUOTE_FAILED",
        hint: expect.stringContaining("mirror node may not have caught up"),
      });
    } finally {
      hedera.client.close();
    }
  });
});

describe("effectivePrice()", () => {
  it("is HBAR per whole token", () => {
    // 1 HBAR for 4,533.0544694 tokens (8 decimals)
    expect(effectivePrice(100_000_000n, 453_305_446_940n, 8)).toBe("0.0002206");
  });

  it("is zero for an empty fill", () => {
    expect(effectivePrice(1n, 0n, 8)).toBe("0");
  });
});
