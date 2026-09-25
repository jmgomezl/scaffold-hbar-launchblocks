import { describe, expect, it } from "vitest";
import {
  eventTitle,
  fieldLabel,
  formatAmount,
  linkFor,
  loggedDate,
  priceChange,
  relativeTime,
} from "~~/app/launches/_lib/format";

describe("launch page formatting", () => {
  it("names events and fields for people", () => {
    expect(eventTitle("token.launched")).toBe("Token launched");
    expect(eventTitle(undefined)).toBe("Message");
    expect(fieldLabel("openingPriceHbar")).toBe("Opening price HBAR");
    expect(fieldLabel("lpTokenId")).toBe("LP token id");
    expect(fieldLabel("firstTradeTx")).toBe("First trade transaction");
    expect(fieldLabel("month1")).toBe("Month 1");
  });

  it("links ids to HashScan by what the key says they are, and only https URLs as they are", () => {
    expect(linkFor("testnet", "tokenId", "0.0.5")).toBe("https://hashscan.io/testnet/token/0.0.5");
    expect(linkFor("testnet", "pairId", "0.0.5")).toBe("https://hashscan.io/testnet/contract/0.0.5");
    expect(linkFor("testnet", "lock", "0.0.5")).toBe("https://hashscan.io/testnet/contract/0.0.5");
    expect(linkFor("testnet", "schedule", "0.0.5")).toBe("https://hashscan.io/testnet/schedule/0.0.5");
    expect(linkFor("testnet", "treasury", "0.0.5")).toBe("https://hashscan.io/testnet/account/0.0.5");
    expect(linkFor("mainnet", "poolTx", "0.0.7@1790127888.310486314")).toMatch(
      /^https:\/\/hashscan\.io\/mainnet\/transaction\//,
    );
    expect(linkFor("testnet", "poolUrl", "https://testnet.saucerswap.finance/liquidity/0.0.5")).toBe(
      "https://testnet.saucerswap.finance/liquidity/0.0.5",
    );
    // Anyone can write to their own topic: nothing else becomes a link.
    expect(linkFor("testnet", "url", "javascript:alert(1)")).toBeNull();
    expect(linkFor("testnet", "url", "http://example.org")).toBeNull();
    expect(linkFor("testnet", "symbol", "LBD")).toBeNull();
  });

  it("shows logged ISO dates and Unix times as dates, and nothing else", () => {
    expect(loggedDate("at", "2026-10-23T05:02:15.046Z")).toBe("Oct 23, 2026, 5:02 AM UTC");
    expect(loggedDate("releaseTime", "1792731271")).toBe("Oct 23, 2026, 4:54 AM UTC");
    expect(loggedDate("lockedUnits", "70710677118")).toBeNull();
    expect(loggedDate("symbol", "LBD")).toBeNull();
  });

  it("describes prices, amounts and times", () => {
    expect(priceChange("0.0002", "0.00025")).toBe("+25.00%");
    expect(priceChange("0.0002", "0.00015")).toBe("-25.00%");
    expect(priceChange(null, "0.0002")).toBeNull();
    expect(formatAmount("45466.9455306")).toBe("45,466.9455306");
    expect(formatAmount("1250000")).toBe("1,250,000");
    const now = Date.parse("2026-09-25T00:00:00Z");
    expect(relativeTime("2026-10-23T00:00:00Z", now)).toBe("in 28 days");
    expect(relativeTime("2026-09-24T21:00:00Z", now)).toBe("3 hours ago");
  });
});
