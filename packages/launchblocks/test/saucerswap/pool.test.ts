import { afterEach, describe, expect, it, vi } from "vitest";

import { entityIdToEvmAddress } from "../../src/hedera/abi";
import { tinycentsToTinybars } from "../../src/hedera/mirror";
import { SAUCERSWAP_DEPLOYMENTS, saucerswapFor } from "../../src/saucerswap/config";
import { applySlippage, findPool, openingPrice, quotePoolCreation, withBuffer } from "../../src/saucerswap/pool";
import { offlineHederaContext } from "../helpers/hedera";

afterEach(() => vi.restoreAllMocks());

/** Respond to the mirror node endpoints quotePoolCreation/findPool touch. */
function mockMirror(handlers: { contractCall?: string; exchangeRate?: unknown; contract?: unknown }) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
    if (url.endsWith("/contracts/call") && init?.method === "POST") return ok({ result: handlers.contractCall });
    if (url.includes("/network/exchangerate")) {
      return ok(handlers.exchangeRate ?? { current_rate: { hbar_equivalent: 30000, cent_equivalent: 231199 } });
    }
    if (url.includes("/contracts/0x")) {
      if (handlers.contract === null) return { ok: false, status: 404, json: async () => ({}) } as Response;
      return ok(handlers.contract ?? { contract_id: "0.0.2656382" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

describe("saucerswapFor()", () => {
  it("returns the documented testnet deployment", () => {
    expect(saucerswapFor("testnet")).toMatchObject({
      v1Factory: "0.0.9959",
      v1Router: "0.0.19264",
      whbarToken: "0.0.15058",
    });
  });

  it("returns the documented mainnet deployment", () => {
    expect(saucerswapFor("mainnet").v1Router).toBe("0.0.3045981");
  });

  it("refuses networks where SaucerSwap is not deployed", () => {
    expect(() => saucerswapFor("localnet")).toThrow(/not deployed on localnet/);
  });

  it("keeps mainnet and testnet addresses distinct", () => {
    const main = SAUCERSWAP_DEPLOYMENTS.mainnet;
    const test = SAUCERSWAP_DEPLOYMENTS.testnet;
    expect(main?.v1Router).not.toBe(test?.v1Router);
    expect(main?.whbarToken).not.toBe(test?.whbarToken);
  });
});

describe("quotePoolCreation()", () => {
  it("converts the factory's tinycent fee with the live exchange rate", async () => {
    // 20_000_000_000 tinycents, the value the testnet factory returns.
    mockMirror({ contractCall: `0x${(20_000_000_000).toString(16).padStart(64, "0")}` });
    const hedera = offlineHederaContext();
    try {
      const quote = await quotePoolCreation(hedera);
      expect(quote.creationFeeTinycents).toBe("20000000000");
      expect(quote.creationFeeTinybar).toBe(
        tinycentsToTinybars(20_000_000_000n, { hbarEquivalent: 30000, centEquivalent: 231199 }),
      );
      expect(quote.creationFeeHbar).toBe("25.95166934");
    } finally {
      hedera.client.close();
    }
  });

  it("quotes at whichever listed rate gives the larger fee", async () => {
    // Observed on testnet: consensus charged at next_rate while current_rate had expired.
    mockMirror({
      contractCall: `0x${(20_000_000_000).toString(16).padStart(64, "0")}`,
      exchangeRate: {
        current_rate: { hbar_equivalent: 30000, cent_equivalent: 234084 },
        next_rate: { hbar_equivalent: 30000, cent_equivalent: 231199 },
      },
    });
    const hedera = offlineHederaContext();
    try {
      const quote = await quotePoolCreation(hedera);
      expect(quote.creationFeeHbar).toBe("25.95166934");
      expect(quote.exchangeRate.centEquivalent).toBe(231199);
    } finally {
      hedera.client.close();
    }
  });

  it("tracks the exchange rate: a cheaper HBAR means a larger fee", async () => {
    mockMirror({
      contractCall: `0x${(20_000_000_000).toString(16).padStart(64, "0")}`,
      exchangeRate: { current_rate: { hbar_equivalent: 30000, cent_equivalent: 115599 } },
    });
    const hedera = offlineHederaContext();
    try {
      expect(Number((await quotePoolCreation(hedera)).creationFeeHbar)).toBeGreaterThan(50);
    } finally {
      hedera.client.close();
    }
  });
});

describe("findPool()", () => {
  it("returns null when the factory reports the zero address", async () => {
    mockMirror({ contractCall: `0x${"0".repeat(64)}` });
    const hedera = offlineHederaContext();
    try {
      expect(await findPool(hedera, "0.0.6512345")).toBeNull();
    } finally {
      hedera.client.close();
    }
  });

  it("resolves an aliased CREATE2 pair address to its contract id", async () => {
    const pair = "fe7cc3ceb7b1128bfc3889184e2d5561bf74bfb3";
    mockMirror({ contractCall: `0x${pair.padStart(64, "0")}`, contract: { contract_id: "0.0.2656382" } });
    const hedera = offlineHederaContext();
    try {
      expect(await findPool(hedera, "0.0.1183558")).toEqual({
        evmAddress: `0x${pair}`,
        contractId: "0.0.2656382",
      });
    } finally {
      hedera.client.close();
    }
  });

  it("still reports the pair when the mirror node cannot resolve the contract id", async () => {
    const pair = "fe7cc3ceb7b1128bfc3889184e2d5561bf74bfb3";
    mockMirror({ contractCall: `0x${pair.padStart(64, "0")}`, contract: null });
    const hedera = offlineHederaContext();
    try {
      expect(await findPool(hedera, "0.0.1183558")).toEqual({ evmAddress: `0x${pair}`, contractId: null });
    } finally {
      hedera.client.close();
    }
  });
});

describe("applySlippage()", () => {
  it("reduces by the given basis points, rounding down", () => {
    expect(applySlippage(1_000_000n, 100)).toBe(990_000n);
    expect(applySlippage(1_000_000n, 0)).toBe(1_000_000n);
    expect(applySlippage(7n, 5000)).toBe(3n);
  });

  it("rejects out-of-range slippage", () => {
    expect(() => applySlippage(100n, -1)).toThrow(/between 0 and 9999/);
    expect(() => applySlippage(100n, 10_000)).toThrow(/between 0 and 9999/);
  });
});

describe("withBuffer()", () => {
  it("adds basis points and rounds up so the fee is never short", () => {
    expect(withBuffer(10_000n, 200)).toBe(10_200n);
    expect(withBuffer(1n, 1)).toBe(2n);
    expect(withBuffer(2_595_166_934n, 0)).toBe(2_595_166_934n);
  });

  it("rejects out-of-range buffers", () => {
    expect(() => withBuffer(1n, -1)).toThrow(/between 0 and 10000/);
    expect(() => withBuffer(1n, 10_001)).toThrow(/between 0 and 10000/);
  });
});

describe("openingPrice()", () => {
  it("expresses HBAR per whole token", () => {
    // 20 HBAR against 100,000 tokens of 8 decimals → 0.0002 HBAR each.
    expect(openingPrice(2_000_000_000n, 10_000_000_000_000n, 8)).toBe("0.0002");
  });

  it("is zero when no tokens were deposited", () => {
    expect(openingPrice(100n, 0n, 8)).toBe("0");
  });
});

describe("entityIdToEvmAddress()", () => {
  it("matches the addresses the factory expects", () => {
    expect(entityIdToEvmAddress("0.0.15058")).toBe("0x0000000000000000000000000000000000003ad2");
    expect(entityIdToEvmAddress("0.0.9959")).toBe("0x00000000000000000000000000000000000026e7");
  });
});
