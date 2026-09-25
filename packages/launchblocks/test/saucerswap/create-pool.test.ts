import { afterEach, describe, expect, it, vi } from "vitest";

import type * as Submit from "../../src/hedera/ops/submit";
import type * as Tokens from "../../src/hedera/ops/tokens";
import { SELECTORS } from "../../src/saucerswap/config";
import { createPoolWithHbar } from "../../src/saucerswap/pool";
import { offlineHederaContext } from "../helpers/hedera";

/**
 * createPoolWithHbar pays SaucerSwap's pair fee before it deposits, so what
 * it can check first, it must: these runs stop before anything is sent.
 */

vi.mock("../../src/hedera/ops/tokens", async original => ({
  ...(await original<typeof Tokens>()),
  getTokenInfo: vi.fn(async (_hedera: unknown, tokenId: string) => ({
    tokenId,
    name: "Demo",
    symbol: "DMO",
    decimals: 2,
    totalSupplyUnits: "100000",
    treasuryAccountId: "0.0.4242",
  })),
}));
const sent = vi.hoisted(() => vi.fn());
vi.mock("../../src/hedera/ops/submit", async original => ({
  ...(await original<typeof Submit>()),
  send: sent,
  sendContract: sent,
}));

afterEach(() => {
  vi.restoreAllMocks();
  sent.mockReset();
});

const WHBAR = "0.0.15058";
const PAIR = "fe7cc3ceb7b1128bfc3889184e2d5561bf74bfb3";
const word = (hex: string) => `0x${hex.padStart(64, "0")}`;

/** The mirror node: a pair (or none) for the token, a 20-billion-tinycent fee, and the given balances. */
function mirror(options: { pair?: boolean; pairHolds?: [string, number][]; tokens?: number; hbar?: number }) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const ok = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    if (url.endsWith("/contracts/call") && init?.method === "POST") {
      const data = JSON.parse(String(init.body)).data as string;
      if (data.startsWith(SELECTORS.pairCreateFee)) return ok({ result: word((20_000_000_000).toString(16)) });
      return ok({ result: word(options.pair ? PAIR : "0") });
    }
    if (url.includes("/network/exchangerate")) {
      return ok({ current_rate: { hbar_equivalent: 30000, cent_equivalent: 231199 } });
    }
    if (url.includes(`/contracts/0x${PAIR}`)) return ok({ contract_id: "0.0.777" });
    if (url.includes("/accounts/0.0.777/tokens")) {
      return ok({ tokens: (options.pairHolds ?? []).map(([token_id, balance]) => ({ token_id, balance })) });
    }
    if (url.includes("/accounts/0.0.4242/tokens")) {
      return ok({ tokens: options.tokens === undefined ? [] : [{ token_id: "0.0.500", balance: options.tokens }] });
    }
    if (url.includes("/accounts/0.0.4242")) return ok({ account: "0.0.4242", balance: { balance: options.hbar ?? 0 } });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const params = { tokenId: "0.0.500", tokenAmount: "500", hbarAmount: "10", slippageBps: 100, deadlineSeconds: 120 };

async function attempt() {
  const hedera = offlineHederaContext();
  try {
    return await createPoolWithHbar(hedera, params).catch((error: unknown) => error);
  } finally {
    hedera.client.close();
  }
}

describe("createPoolWithHbar() before it pays anything", () => {
  it("refuses a deposit of more tokens than the account holds", async () => {
    mirror({ tokens: 40_000, hbar: 100e8 }); // 400.00 held, 500 asked
    expect(await attempt()).toMatchObject({ code: "POOL_TOKENS_SHORT" });
    expect(sent).not.toHaveBeenCalled();
  });

  it("refuses when the HBAR cannot cover the deposit and the pair fee", async () => {
    mirror({ tokens: 100_000, hbar: 20e8 }); // 10 ℏ to deposit plus a ~26 ℏ fee
    expect(await attempt()).toMatchObject({ code: "POOL_HBAR_SHORT" });
    expect(sent).not.toHaveBeenCalled();
  });

  it("refuses a pool that already holds liquidity", async () => {
    mirror({
      pair: true,
      pairHolds: [
        ["0.0.500", 1],
        [WHBAR, 1],
      ],
      tokens: 100_000,
      hbar: 100e8,
    });
    expect(await attempt()).toMatchObject({ code: "POOL_EXISTS" });
    expect(sent).not.toHaveBeenCalled();
  });

  it("deposits into a pair an earlier attempt left empty, without paying for it again", async () => {
    mirror({ pair: true, pairHolds: [], tokens: 100_000, hbar: 15e8 }); // enough for the deposit, not for a new pair
    sent.mockRejectedValue(new Error("stop after the first send"));
    await attempt();
    // The first transaction is the router allowance, not createPair.
    expect(sent).toHaveBeenCalledTimes(1);
    expect(String(sent.mock.calls[0]?.[2])).not.toMatch(/Creating the SaucerSwap pair/);
  });
});
