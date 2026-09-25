import type { Network } from "@sh/launchblocks";
import { hashscanUrl, secondsToIso } from "@sh/launchblocks";

/**
 * Formatting for launch pages. A launch log is whatever its flow wrote, and
 * anyone can write to their own topic, so values are only ever shown as text
 * (React escapes it) or linked when they are an https URL or an id HashScan knows.
 */

/** `token.launched` → "Token launched". */
export function eventTitle(event: unknown): string {
  if (typeof event !== "string" || !event.trim()) return "Message";
  const words = event.replace(/[._-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `openingPriceHbar` → "Opening price HBAR"; `lpTokenId` → "LP token id"; `month1` → "Month 1". */
export function fieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .toLowerCase()
    .replace(/\blp\b/g, "LP")
    .replace(/\bhbar\b/g, "HBAR")
    .replace(/\busd\b/g, "USD")
    .replace(/\btx\b/g, "transaction")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const TRANSACTION_ID = /^\d+\.\d+\.\d+[@-]\d+[.-]\d+$/;
const ENTITY_ID = /^\d+\.\d+\.\d+$/;

/** Where a logged value leads: HashScan for ids (the key says which kind), the URL itself for https links. */
export function linkFor(network: Network, key: string, value: string): string | null {
  if (/^https:\/\/[^\s]+$/.test(value)) return value;
  if (TRANSACTION_ID.test(value)) return hashscanUrl(network, "transaction", value);
  if (!ENTITY_ID.test(value)) return null;
  const name = key.toLowerCase();
  if (name.includes("schedule")) return hashscanUrl(network, "schedule", value);
  if (name.includes("topic")) return hashscanUrl(network, "topic", value);
  if (name.includes("token")) return hashscanUrl(network, "token", value);
  if (/(pair|pool|lock|contract)/.test(name)) return hashscanUrl(network, "contract", value);
  return hashscanUrl(network, "account", value);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

/**
 * A logged date shown for people: an ISO date, or Unix seconds under a key
 * that names a time (`releaseTime`). Null for anything else, which is shown as logged.
 */
export function loggedDate(key: string, value: unknown): string | null {
  if (typeof value === "string" && ISO_DATE.test(value)) return formatDate(value);
  if (!/(time|at)$/i.test(key)) return null;
  // From 2001 on: smaller numbers under such a key are more likely counts than dates.
  const plausible = typeof value === "number" ? value >= 1e9 : typeof value === "string" && /^\d{10,11}$/.test(value);
  const iso = plausible ? secondsToIso(value) : null;
  return iso ? formatDate(iso) : null;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return `${date.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" })} UTC`;
}

/** "in 28 days", "3 hours ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = (Date.parse(iso) - now) / 1000;
  if (!Number.isFinite(seconds)) return "";
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(Math.round(seconds), "second");
}

/** "+20.97%" from the opening price to now, or null when either is missing. */
export function priceChange(opening: string | null, now: string): string | null {
  const from = Number(opening);
  const to = Number(now);
  if (!opening || !Number.isFinite(from) || from <= 0 || !Number.isFinite(to)) return null;
  const change = ((to - from) / from) * 100;
  return `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
}

/** 1250000 → "1,250,000"; keeps every decimal the value has. */
export function formatAmount(value: string): string {
  const [whole = "0", fraction] = value.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fraction ? `${grouped}.${fraction}` : grouped;
}
