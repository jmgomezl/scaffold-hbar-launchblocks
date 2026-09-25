import { LaunchBlocksError } from "../errors";
import type { PythPriceUpdates } from "../hedera/context";
import { hostOf } from "../hedera/mirror";
import { HERMES_BASE_URL } from "./config";

export type HermesOptions = {
  /** A Hermes API key, from Pyth Terminal. Sent as a Bearer token, never logged. */
  apiKey: string;
  /** Another Hermes provider; defaults to Pyth's own. */
  baseUrl?: string | undefined;
};

type HermesLatest = { binary?: { encoding?: string; data?: string[] } };

/**
 * Signed price updates from Hermes, Pyth's price service. The key only ever
 * travels in the Authorization header of an HTTPS request to Hermes.
 */
export function hermesPriceUpdates(options: HermesOptions): PythPriceUpdates {
  const base = (options.baseUrl?.trim() || HERMES_BASE_URL).replace(/\/+$/, "");
  if (!base.startsWith("https://")) {
    // The API key rides in a header: never send it in the clear.
    throw new LaunchBlocksError("PYTH_URL_INVALID", "PYTH_HERMES_URL must be an https:// URL");
  }
  return async (feedIds, signal) => {
    const query = feedIds.map(id => `ids[]=${encodeURIComponent(id)}`).join("&");
    const url = `${base}/v2/updates/price/latest?${query}&encoding=hex&parsed=false`;
    let response: Response;
    try {
      response = await fetch(url, {
        ...(signal ? { signal } : {}),
        redirect: "error",
        headers: { accept: "application/json", authorization: `Bearer ${options.apiKey}` },
      });
    } catch (cause) {
      throw new LaunchBlocksError("PYTH_UNREACHABLE", `Could not reach Pyth's price service at ${hostOf(base)}`, {
        cause,
      });
    }
    if (response.status === 401 || response.status === 403) {
      // Hermes says why in plain text, e.g. which feed the key's plan does not cover. It never echoes the key.
      const reason = (await response.text().catch(() => "")).trim().slice(0, 300);
      if (/not entitled/i.test(reason)) {
        throw new LaunchBlocksError(
          "PYTH_NOT_ENTITLED",
          `Your Pyth API key's plan does not cover this feed: ${reason}`,
          {
            hint: "In Pyth Terminal, add crypto spot feeds (HBAR/USD) to the key's plan, or unset PYTH_API_KEY to use the price already on Hedera.",
          },
        );
      }
      throw new LaunchBlocksError(
        "PYTH_API_KEY_REJECTED",
        `Pyth's price service refused the API key${reason ? `: ${reason}` : ""}`,
        {
          hint: "Check PYTH_API_KEY: Hermes keys come from Pyth Terminal (https://docs.pyth.network/price-feeds/core/upgrade/preparing).",
        },
      );
    }
    if (!response.ok) {
      throw new LaunchBlocksError("PYTH_UPDATE_FAILED", `Pyth's price service answered ${response.status}`);
    }
    const body = (await response.json()) as HermesLatest;
    const data = body.binary?.data ?? [];
    if (!data.length) throw new LaunchBlocksError("PYTH_UPDATE_FAILED", "Pyth's price service returned no update");
    return data.map(hex => (hex.startsWith("0x") ? hex : `0x${hex}`) as `0x${string}`);
  };
}
