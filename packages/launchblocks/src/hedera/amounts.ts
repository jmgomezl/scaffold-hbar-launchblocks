import { Long } from "@hiero-ledger/sdk";

import { LaunchBlocksError } from "../errors";

/** HTS stores supplies and balances as signed 64-bit integers in the smallest unit. */
export const MAX_UNITS = 2n ** 63n - 1n;
export const MAX_DECIMALS = 18;

export type DecimalAmount = string | number;

/**
 * Convert a human amount ("1000000.5") into smallest units for `decimals`.
 * Rejects negatives, more fractional digits than the token supports, and
 * anything above the HTS 64-bit limit.
 */
export function toUnits(amount: DecimalAmount, decimals: number): bigint {
  assertDecimals(decimals);
  const text = typeof amount === "number" ? numberToDecimalString(amount) : amount.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) {
    throw new LaunchBlocksError("AMOUNT_INVALID", `Amount "${amount}" must be a non-negative decimal number`);
  }
  const whole = match[1] as string;
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  if (fraction.length > decimals) {
    throw new LaunchBlocksError(
      "AMOUNT_TOO_PRECISE",
      `Amount "${amount}" has ${fraction.length} fractional digits but the token has ${decimals} decimals`,
    );
  }
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (units > MAX_UNITS) {
    throw new LaunchBlocksError(
      "AMOUNT_TOO_LARGE",
      `Amount "${amount}" with ${decimals} decimals exceeds the HTS maximum of ${MAX_UNITS} units`,
    );
  }
  return units;
}

/** Format smallest units as a human decimal string without trailing zeros. */
export function fromUnits(units: bigint | string | number, decimals: number): string {
  assertDecimals(decimals);
  const value = BigInt(units);
  if (value < 0n) throw new LaunchBlocksError("AMOUNT_INVALID", "Units must be non-negative");
  if (decimals === 0) return value.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/** The SDK's 64-bit integer type, built without going through a JavaScript number. */
export function toLong(units: bigint): Long {
  if (units < 0n || units > MAX_UNITS) {
    throw new LaunchBlocksError("AMOUNT_TOO_LARGE", `${units} does not fit in a signed 64-bit integer`);
  }
  return Long.fromString(units.toString());
}

export function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) {
    throw new LaunchBlocksError("DECIMALS_INVALID", `Decimals must be an integer between 0 and ${MAX_DECIMALS}`);
  }
}

/**
 * Numbers like 1e21 and 2e-9 stringify in exponent form; render them
 * positionally instead. JavaScript's shortest round-trip form is the decimal
 * the author wrote, so shifting its point is exact.
 */
export function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value) && Number.isSafeInteger(value)) return value.toString();
  const text = value.toString();
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(text);
  if (!match) return text;
  const [, sign = "", whole = "0", fraction = "", exponentText = "0"] = match;
  const digits = `${whole}${fraction}`;
  const point = whole.length + Number(exponentText);
  const positional =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${"0".repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return `${sign}${positional.replace(/^0+(?=\d)/, "")}`;
}
