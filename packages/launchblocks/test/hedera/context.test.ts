import { describe, expect, it } from "vitest";

import { hashscanUrl, normalizeTransactionId } from "../../src/hedera/context";

describe("normalizeTransactionId()", () => {
  it("converts SDK format to mirror node format", () => {
    expect(normalizeTransactionId("0.0.1234@1700000000.123456789")).toBe("0.0.1234-1700000000-123456789");
  });

  it("drops the SDK's ?scheduled suffix, which Hashscan does not parse", () => {
    expect(normalizeTransactionId("0.0.7231440@1790139542.291994196?scheduled")).toBe(
      "0.0.7231440-1790139542-291994196",
    );
  });

  it("leaves mirror node format and unknown strings alone", () => {
    expect(normalizeTransactionId("0.0.1234-1700000000-123456789")).toBe("0.0.1234-1700000000-123456789");
    expect(normalizeTransactionId("garbage")).toBe("garbage");
  });
});

describe("hashscanUrl()", () => {
  it("links entities on the right network", () => {
    expect(hashscanUrl("testnet", "token", "0.0.5")).toBe("https://hashscan.io/testnet/token/0.0.5");
    expect(hashscanUrl("mainnet", "topic", "0.0.9")).toBe("https://hashscan.io/mainnet/topic/0.0.9");
  });

  it("normalizes transaction ids in links", () => {
    expect(hashscanUrl("testnet", "transaction", "0.0.1@2.3")).toBe(
      "https://hashscan.io/testnet/transaction/0.0.1-2-3",
    );
  });

  it("falls back to testnet paths for localnet", () => {
    expect(hashscanUrl("localnet", "account", "0.0.2")).toContain("/testnet/account/0.0.2");
  });
});
