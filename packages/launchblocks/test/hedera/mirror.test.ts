import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAccount, fetchTopicMessages, formatHbar } from "../../src/hedera/mirror";

const hedera = { mirrorBaseUrl: "https://testnet.mirrornode.hedera.com" };

function mockFetch(status: number, body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response);
}

afterEach(() => vi.restoreAllMocks());

describe("fetchAccount()", () => {
  it("maps the mirror node payload", async () => {
    mockFetch(200, {
      account: "0.0.4242",
      evm_address: "0x0000000000000000000000000000000000001092",
      deleted: false,
      balance: { balance: 1234500000 },
      key: { _type: "ECDSA_SECP256K1" },
    });
    const account = await fetchAccount(hedera, "0.0.4242");
    expect(account).toEqual({
      accountId: "0.0.4242",
      evmAddress: "0x0000000000000000000000000000000000001092",
      balanceTinybar: 1234500000n,
      keyType: "ECDSA_SECP256K1",
      deleted: false,
    });
  });

  it("returns null for an account that does not exist", async () => {
    mockFetch(404, {});
    expect(await fetchAccount(hedera, "0.0.999999999")).toBeNull();
  });

  it("reports a reachable-but-failing mirror node", async () => {
    mockFetch(500, {});
    await expect(fetchAccount(hedera, "0.0.1")).rejects.toMatchObject({ code: "MIRROR_ERROR" });
  });

  it("reports an unreachable mirror node with a hint", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(fetchAccount(hedera, "0.0.1")).rejects.toMatchObject({ code: "MIRROR_UNREACHABLE" });
  });
});

describe("fetchTopicMessages()", () => {
  it("decodes base64 message contents in order", async () => {
    mockFetch(200, {
      messages: [
        { sequence_number: 1, consensus_timestamp: "1758500000.1", message: Buffer.from('{"a":1}').toString("base64") },
        { sequence_number: 2, consensus_timestamp: "1758500001.2", message: Buffer.from("plain").toString("base64") },
      ],
    });
    const messages = await fetchTopicMessages(hedera, "0.0.5");
    expect(messages.map(m => m.contents)).toEqual(['{"a":1}', "plain"]);
    expect(messages[0]?.sequenceNumber).toBe(1);
  });

  it("returns an empty list for an unknown topic", async () => {
    mockFetch(404, {});
    expect(await fetchTopicMessages(hedera, "0.0.5")).toEqual([]);
  });
});

describe("formatHbar()", () => {
  it("formats tinybars without trailing zeros", () => {
    expect(formatHbar(100_000_000n)).toBe("1");
    expect(formatHbar(1_234_500_000n)).toBe("12.345");
    expect(formatHbar(1n)).toBe("0.00000001");
    expect(formatHbar(0n)).toBe("0");
  });
});
