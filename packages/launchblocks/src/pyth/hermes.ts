import { LaunchBlocksError } from "../errors";
import type { PythPriceUpdates } from "../hedera/context";
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
      throw new LaunchBlocksError("PYTH_UNREACHABLE", `Could not reach Pyth's price service at ${base}`, { cause });
    }
    if (response.status === 401 || response.status === 403) {
      throw new LaunchBlocksError("PYTH_API_KEY_REJECTED", "Pyth's price service refused the API key", {
        hint: "Check PYTH_API_KEY: Hermes keys come from Pyth Terminal (https://docs.pyth.network/price-feeds/core/upgrade/preparing).",
      });
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
