import { NextResponse } from "next/server";
import { PYTH_FEEDS, hermesPriceUpdates } from "@sh/launchblocks";
import { errorResponse } from "~~/services/launchblocks/server";

export const runtime = "nodejs";

const SERVED_FEEDS = new Set<string>(Object.values(PYTH_FEEDS));
/** Updates stay valid on Pyth's contract for 60 s; reusing one for a few seconds bounds the key's use. */
const REUSE_MS = 3_000;
let latest: { ids: string; at: number; updates: readonly string[] } | null = null;

/**
 * Signed Pyth price updates for wallet runs in the browser, fetched with the
 * server's Hermes key, so the key never reaches the page. Without `ids` it
 * says whether a key is configured. Only the feeds LaunchBlocks uses are
 * served, and an answer is reused for a few seconds, so the route cannot
 * spend the key's quota on anything else.
 */
export async function GET(req: Request) {
  const apiKey = process.env.PYTH_API_KEY?.trim();
  const ids = new URL(req.url).searchParams.getAll("ids");
  if (!ids.length) return NextResponse.json({ configured: !!apiKey });
  if (!apiKey) {
    return NextResponse.json(
      { error: { code: "PYTH_NOT_CONFIGURED", message: "This app has no Pyth API key" } },
      { status: 404 },
    );
  }
  if (ids.some(id => !SERVED_FEEDS.has(id))) {
    return NextResponse.json(
      { error: { code: "PYTH_FEED_NOT_SERVED", message: "This app serves only the Pyth feeds its steps use" } },
      { status: 400 },
    );
  }
  try {
    const key = ids.join(",");
    if (!latest || latest.ids !== key || Date.now() - latest.at > REUSE_MS) {
      const updates = await hermesPriceUpdates({ apiKey, baseUrl: process.env.PYTH_HERMES_URL })(ids);
      latest = { ids: key, at: Date.now(), updates };
    }
    return NextResponse.json({ updates: latest.updates });
  } catch (error) {
    return errorResponse(error);
  }
}
