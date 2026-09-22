import { describe, expect, it } from "vitest";

import { MAX_UNITS, fromUnits, toLong, toUnits } from "../../src/hedera/amounts";

describe("toUnits()", () => {
  it("scales whole and fractional amounts", () => {
    expect(toUnits("1", 8)).toBe(100_000_000n);
    expect(toUnits("1.5", 8)).toBe(150_000_000n);
    expect(toUnits(" 0.00000001 ", 8)).toBe(1n);
    expect(toUnits("1000000000", 8)).toBe(100_000_000_000_000_000n);
    expect(toUnits("7", 0)).toBe(7n);
  });

  it("accepts numbers, including large integers", () => {
    expect(toUnits(2.5, 2)).toBe(250n);
    expect(toUnits(1e18, 0)).toBe(1_000_000_000_000_000_000n);
  });

  it("ignores trailing zeros in the fraction", () => {
    expect(toUnits("1.500", 1)).toBe(15n);
  });

  it("rejects negatives, garbage and excess precision", () => {
    expect(() => toUnits("-1", 8)).toThrow(/non-negative/);
    expect(() => toUnits("1e5", 8)).toThrow(/non-negative decimal/);
    expect(() => toUnits("abc", 8)).toThrow(/non-negative decimal/);
    expect(() => toUnits("1.123", 2)).toThrow(/3 fractional digits but the token has 2/);
  });

  it("rejects amounts above the 64-bit HTS limit", () => {
    expect(toUnits(MAX_UNITS.toString(), 0)).toBe(MAX_UNITS);
    expect(() => toUnits((MAX_UNITS + 1n).toString(), 0)).toThrow(/exceeds the HTS maximum/);
    expect(() => toUnits("100000000000", 8)).toThrow(/exceeds/);
  });

  it("rejects invalid decimals", () => {
    expect(() => toUnits("1", -1)).toThrow(/between 0 and 18/);
    expect(() => toUnits("1", 19)).toThrow(/between 0 and 18/);
    expect(() => toUnits("1", 1.5)).toThrow(/between 0 and 18/);
  });
});

describe("fromUnits()", () => {
  it("formats without trailing zeros", () => {
    expect(fromUnits(150_000_000n, 8)).toBe("1.5");
    expect(fromUnits("100000000", 8)).toBe("1");
    expect(fromUnits(1n, 8)).toBe("0.00000001");
    expect(fromUnits(42, 0)).toBe("42");
    expect(fromUnits(0n, 8)).toBe("0");
  });

  it("round-trips with toUnits", () => {
    for (const amount of ["0", "1", "123.456", "999999999.99999999"]) {
      expect(fromUnits(toUnits(amount, 8), 8)).toBe(amount);
    }
  });

  it("rejects negative units", () => {
    expect(() => fromUnits(-1n, 2)).toThrow(/non-negative/);
  });
});

describe("toLong()", () => {
  it("preserves values beyond Number.MAX_SAFE_INTEGER", () => {
    const units = 123_456_789_012_345_678_901n % MAX_UNITS;
    expect(toLong(units).toString()).toBe(units.toString());
  });

  it("rejects out-of-range values", () => {
    expect(() => toLong(-1n)).toThrow(/64-bit/);
    expect(() => toLong(MAX_UNITS + 1n)).toThrow(/64-bit/);
  });
});
