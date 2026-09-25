import { PYTH_FEEDS } from "@sh/launchblocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearServerEnv, fresh, json } from "~~/test/helpers";

const HBAR = PYTH_FEEDS.hbarUsd;
const loadRoute = () => fresh(() => import("~~/app/api/launchblocks/pyth/updates/route"));
const get = (query = "") => new Request(`http://localhost/api/launchblocks/pyth/updates${query}`);

/** Hermes answering with one signed update, after `delayMs`. */
function hermes(delayMs = 0) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return new Response(JSON.stringify({ binary: { encoding: "hex", data: ["abcd"] } }), {
      headers: { "content-type": "application/json" },
    });
  });
}

beforeEach(() => {
  clearServerEnv();
  vi.stubEnv("PYTH_API_KEY", "test-key");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("GET /api/launchblocks/pyth/updates", () => {
  it("says whether the server has a Hermes key, without calling Hermes", async () => {
    const fetch = hermes();
    const { GET } = await loadRoute();
    expect(await json(await GET(get()))).toEqual({ status: 200, body: { configured: true } });

    vi.stubEnv("PYTH_API_KEY", undefined);
    expect(await json(await GET(get()))).toEqual({ status: 200, body: { configured: false } });
    expect(await json(await GET(get(`?ids=${HBAR}`)))).toMatchObject({
      status: 404,
      body: { error: { code: "PYTH_NOT_CONFIGURED" } },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serves only the feeds the steps use, so the key's quota goes to nothing else", async () => {
    const fetch = hermes();
    const { GET } = await loadRoute();
    const other = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43"; // BTC/USD
    expect(await json(await GET(get(`?ids=${HBAR}&ids=${other}`)))).toMatchObject({
      status: 400,
      body: { error: { code: "PYTH_FEED_NOT_SERVED" } },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shares one Hermes call between concurrent requests for the same feeds", async () => {
    const fetch = hermes(20);
    const { GET } = await loadRoute();
    const requests = [GET(get(`?ids=${HBAR}`)), GET(get(`?ids=${HBAR}&ids=${HBAR}`))];
    const answers = await Promise.all(requests.map(async pending => json(await pending)));
    expect(answers).toEqual([
      { status: 200, body: { updates: ["0xabcd"] } },
      { status: 200, body: { updates: ["0xabcd"] } },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    // The repeated id reached Hermes once, with the key as a Bearer token.
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url).match(/ids\[\]=/g)).toHaveLength(1);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-key");
  });

  it("reuses an answer for three seconds, then asks Hermes again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetch = hermes();
    const { GET } = await loadRoute();
    await GET(get(`?ids=${HBAR}`));
    vi.setSystemTime(Date.now() + 2_000);
    await GET(get(`?ids=${HBAR}`));
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2_000);
    await GET(get(`?ids=${HBAR}`));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a failed call", async () => {
    const fetch = hermes().mockRejectedValueOnce(new TypeError("fetch failed"));
    const { GET } = await loadRoute();
    expect(await json(await GET(get(`?ids=${HBAR}`)))).toMatchObject({
      status: 502,
      body: { error: { code: "PYTH_UNREACHABLE" } },
    });
    expect(await json(await GET(get(`?ids=${HBAR}`)))).toEqual({ status: 200, body: { updates: ["0xabcd"] } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses to send the key to a Hermes URL that is not https", async () => {
    vi.stubEnv("PYTH_HERMES_URL", "http://hermes.example");
    const fetch = hermes();
    const { GET } = await loadRoute();
    expect(await json(await GET(get(`?ids=${HBAR}`)))).toMatchObject({
      status: 500,
      body: { error: { code: "PYTH_URL_INVALID" } },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
