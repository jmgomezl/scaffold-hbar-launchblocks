import { afterEach, describe, expect, it, vi } from "vitest";
import { MIRROR_BASE_URL } from "../../src/hedera/client";
import { readLaunch } from "../../src/launches/read";

afterEach(() => vi.restoreAllMocks());

const hedera = { network: "testnet" as const, mirrorBaseUrl: MIRROR_BASE_URL.testnet };
const WHBAR = "0.0.15058";
const b64 = (value: unknown) =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64");

/** Mirror node routes by URL fragment; anything else is a 404. */
function mirror(routes: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async input => {
    const url = String(input);
    const hit = Object.entries(routes).find(([fragment]) => url.includes(fragment));
    return hit
      ? new Response(JSON.stringify(hit[1]), { headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ _status: "not found" }), { status: 404 });
  });
}

const message = (sequence: number, seconds: number, body: unknown) => ({
  sequence_number: sequence,
  consensus_timestamp: `${seconds}.000000001`,
  payer_account_id: "0.0.1001",
  message: b64(body),
});

describe("readLaunch()", () => {
  it("rebuilds a launch from its log and adds the pool's and lock's state now", async () => {
    mirror({
      "/topics/0.0.500/messages": {
        messages: [
          message(1, 1790000000, { event: "token.launched", tokenId: "0.0.501", symbol: "LBL" }),
          message(2, 1790000030, {
            event: "liquidity.locked",
            pairId: "0.0.502",
            lpTokenId: "0.0.503",
            lock: "0.0.504",
            releaseTime: "1792592031",
          }),
          message(3, 1790000040, "a plain note"),
        ],
      },
      "/topics/0.0.500": { topic_id: "0.0.500", memo: "LBL launch log", created_timestamp: "1789999999.1" },
      "/tokens/0.0.501": {
        token_id: "0.0.501",
        name: "Locked Demo",
        symbol: "LBL",
        decimals: "8",
        total_supply: "100000000000000",
        treasury_account_id: "0.0.1001",
      },
      "/accounts/0.0.502/tokens": {
        tokens: [
          { token_id: "0.0.501", balance: 5000000000000 },
          { token_id: WHBAR, balance: 1000000000 },
        ],
      },
      "/accounts/0.0.504/tokens": { tokens: [{ token_id: "0.0.503", balance: 70710677118 }] },
    });

    const launch = await readLaunch(hedera, "0.0.500");
    expect(launch).toMatchObject({
      topicId: "0.0.500",
      memo: "LBL launch log",
      createdAt: "2026-09-21T14:13:19.100Z",
      token: { tokenId: "0.0.501", symbol: "LBL", totalSupply: "1000000", treasuryAccountId: "0.0.1001" },
      pool: {
        pairId: "0.0.502",
        tokenReserve: "50000",
        hbarReserve: "10",
        priceHbar: "0.0002",
        openingPriceHbar: null,
      },
      lock: {
        contractId: "0.0.504",
        lpTokenId: "0.0.503",
        lockedLp: "707.10677118",
        releaseAt: "2026-10-21T14:13:51.000Z",
        released: false,
      },
      schedules: [],
    });
    expect(launch.entries.map(entry => [entry.sequence, entry.data?.event ?? entry.text])).toEqual([
      [1, "token.launched"],
      [2, "liquidity.locked"],
      [3, "a plain note"],
    ]);
    expect(launch.entries[0]).toMatchObject({ consensusAt: "2026-09-21T14:13:20.000Z", payerAccountId: "0.0.1001" });
  });

  it("reports each schedule the log names, and whether the network has run it", async () => {
    mirror({
      "/topics/0.0.600/messages": {
        messages: [
          message(1, 1790000000, {
            event: "unlocks.scheduled",
            tokenId: "0.0.601",
            month1: { schedule: "0.0.602", at: "2026-10-23T05:02:15.046Z", amount: "250000" },
            month2: { schedule: "0.0.603", at: "2026-11-22T05:02:16.945Z", amount: "250000" },
          }),
        ],
      },
      "/topics/0.0.600": { topic_id: "0.0.600", memo: "", created_timestamp: null },
      "/schedules/0.0.602": { schedule_id: "0.0.602", executed_timestamp: "1792645335.5", deleted: false },
      "/schedules/0.0.603": { schedule_id: "0.0.603", executed_timestamp: null, deleted: false },
    });
    const launch = await readLaunch(hedera, "0.0.600");
    expect(launch.token).toBeNull();
    expect(launch.schedules).toEqual([
      {
        scheduleId: "0.0.602",
        label: "month1",
        executedAt: "2026-10-22T05:02:15.500Z",
        executesAt: "2026-10-23T05:02:15.046Z",
        amount: "250000",
        deleted: false,
      },
      {
        scheduleId: "0.0.603",
        label: "month2",
        executedAt: null,
        executesAt: "2026-11-22T05:02:16.945Z",
        amount: "250000",
        deleted: false,
      },
    ]);
  });

  it("on a topic anyone can post to, builds the page only from the launcher's messages", async () => {
    const stranger = {
      ...message(3, 1790000050, { event: "market.opened", pairId: "0.0.666", poolUrl: "https://evil.example" }),
      payer_account_id: "0.0.6666",
    };
    mirror({
      "/topics/0.0.500/messages": {
        messages: [
          message(1, 1790000000, { event: "token.launched", tokenId: "0.0.501" }),
          message(2, 1790000030, {
            event: "liquidity.locked",
            lock: "0.0.504",
            lpTokenId: "0.0.503",
            releaseTime: "1e20",
          }),
          stranger,
        ],
      },
      "/topics/0.0.500": { topic_id: "0.0.500", memo: "open log", created_timestamp: "1789999999.1", submit_key: null },
      "/accounts/0.0.504/tokens": { tokens: [] },
    });
    const launch = await readLaunch(hedera, "0.0.500");
    expect(launch).toMatchObject({ openToAll: true, launcherAccountId: "0.0.1001", pool: null });
    expect(launch.entries.map(entry => entry.fromLauncher)).toEqual([true, true, false]);
    // A release time no date can hold is left out rather than failing the page.
    expect(launch.lock).toMatchObject({ contractId: "0.0.504", releaseAt: null });
  });

  it("trusts every message on a topic with a submit key", async () => {
    mirror({
      "/topics/0.0.500/messages": {
        messages: [
          message(1, 1790000000, "hello"),
          { ...message(2, 1790000001, "scheduled"), payer_account_id: "0.0.7" },
        ],
      },
      "/topics/0.0.500": { topic_id: "0.0.500", memo: "", submit_key: { _type: "ED25519", key: "ab" } },
    });
    const launch = await readLaunch(hedera, "0.0.500");
    expect(launch.openToAll).toBe(false);
    expect(launch.entries.every(entry => entry.fromLauncher)).toBe(true);
  });

  it("refuses an id that is not a topic id, and reports a topic that does not exist", async () => {
    const fetch = mirror({});
    await expect(readLaunch(hedera, "../0.0.1")).rejects.toMatchObject({ code: "ENTITY_ID_INVALID" });
    expect(fetch).not.toHaveBeenCalled();
    await expect(readLaunch(hedera, "0.0.9")).rejects.toMatchObject({ code: "LAUNCH_NOT_FOUND" });
  });

  it("calls an id the mirror node finds out of range invalid, not a mirror failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 400 }));
    await expect(readLaunch(hedera, "0.0.999999999999")).rejects.toMatchObject({ code: "ENTITY_ID_INVALID" });
  });
});
