import { LaunchBlocksError } from "../errors";
import type { DecimalAmount } from "../hedera/amounts";
import { fromUnits, numberToDecimalString } from "../hedera/amounts";

/** An exact decimal: `value × 10^-scale`, without the HTS 64-bit cap that token amounts have. */
export type Scaled = { value: bigint; scale: number };

/** Parse a non-negative decimal amount exactly. */
export function parseDecimal(amount: DecimalAmount, label: string): Scaled {
  const text = typeof amount === "number" ? numberToDecimalString(amount) : amount.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new LaunchBlocksError("AMOUNT_INVALID", `${label} "${amount}" must be a non-negative decimal`);
  const fraction = (match[2] ?? "").replace(/0+$/, "");
  return { value: BigInt(`${match[1]}${fraction}`), scale: fraction.length };
}

/** `value × 10^expo` as a `Scaled`, for feeds that store a price with an exponent. */
export function scaled(value: bigint, expo: number): Scaled {
  return expo >= 0 ? { value: value * 10n ** BigInt(expo), scale: 0 } : { value, scale: -expo };
}

export function formatDecimal({ value, scale }: Scaled): string {
  if (scale === 0) return value.toString();
  const text = value.toString().padStart(scale + 1, "0");
  const whole = text.slice(0, -scale);
  const fraction = text.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/** The HBAR, rounded down to a tinybar, worth `usd` at `hbarUsd` dollars per HBAR. */
export function hbarForUsd(usd: Scaled, hbarUsd: Scaled): string {
  const tinybar = (usd.value * 10n ** BigInt(hbarUsd.scale) * 10n ** 8n) / (hbarUsd.value * 10n ** BigInt(usd.scale));
  return fromUnits(tinybar, 8);
}

export function describeAge(seconds: number): string {
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86_400)} days`;
}
