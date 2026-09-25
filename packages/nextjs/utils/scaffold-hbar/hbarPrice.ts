export const HBAR_PRICE_CACHE_DURATION_MS = 60 * 1000;
/**
 * The network's own HBAR/USD rate, the one Hedera prices fees with. The public
 * mirror node allows cross-origin reads and needs no key; CoinGecko, used
 * before, rate-limits browsers with responses that lack CORS headers.
 */
export const HBAR_PRICE_URL = "https://mainnet.mirrornode.hedera.com/api/v1/network/exchangerate";

type HbarPriceCache = {
  price: number;
  timestamp: number;
};

let cache: HbarPriceCache | null = null;

export async function fetchHbarPrice(): Promise<number> {
  const now = Date.now();
  if (cache && now - cache.timestamp < HBAR_PRICE_CACHE_DURATION_MS) {
    return cache.price;
  }

  try {
    const response = await fetch(HBAR_PRICE_URL);
    const data = (await response.json()) as { current_rate?: { cent_equivalent?: number; hbar_equivalent?: number } };
    const rate = data.current_rate;
    // cent_equivalent cents buy hbar_equivalent HBAR.
    const price = rate?.cent_equivalent && rate.hbar_equivalent ? rate.cent_equivalent / rate.hbar_equivalent / 100 : 0;
    cache = { price, timestamp: now };
    return price;
  } catch {
    // The price chip is decoration: without a price it stays hidden, and the console stays quiet.
    return cache?.price ?? 0;
  }
}
