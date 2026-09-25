import { DEFAULT_PUBLIC_RUN_LIMITS, GALLERY, publicRunHbarEstimate } from "@sh/launchblocks";
import type { Flow } from "@sh/launchblocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunGuard } from "~~/services/launchblocks/server";
import { OUTSIDE_TRANSFER, clearServerEnv, fresh, galleryFlow, json, validFlow } from "~~/test/helpers";

const loadGuard = () => fresh(async () => (await import("~~/services/launchblocks/server")).guardRun);

function runRequest(ip = "203.0.113.7", headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/launchblocks/flows/run", {
    method: "POST",
    headers: { "x-real-ip": ip, ...headers },
  });
}

async function refusal(guard: RunGuard) {
  if (!("refused" in guard)) throw new Error("expected the run to be refused");
  return json(guard.refused);
}

function allowed(guard: RunGuard) {
  if ("refused" in guard) throw new Error(`expected the run to start, got ${guard.refused.status}`);
  return guard;
}

beforeEach(clearServerEnv);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("guardRun on any deployment", () => {
  it("refuses mainnet flows unless LAUNCHBLOCKS_ALLOW_MAINNET is true", async () => {
    const flow: Flow = { ...galleryFlow(), network: "mainnet" };
    const guardRun = await loadGuard();
    expect(await refusal(guardRun(runRequest(), flow))).toMatchObject({
      status: 403,
      body: { error: { code: "MAINNET_DISABLED" } },
    });

    vi.stubEnv("LAUNCHBLOCKS_ALLOW_MAINNET", "true");
    allowed(guardRun(runRequest(), flow));
  });

  it("asks for the shared run token when one is set", async () => {
    vi.stubEnv("LAUNCHBLOCKS_RUN_TOKEN", "s3cret");
    const guardRun = await loadGuard();
    expect(await refusal(guardRun(runRequest(), galleryFlow()))).toMatchObject({
      status: 401,
      body: { error: { code: "RUN_TOKEN_REQUIRED" } },
    });
    expect(
      await refusal(guardRun(runRequest("203.0.113.7", { "x-launchblocks-token": "guess" }), galleryFlow())),
    ).toMatchObject({ status: 401 });
    allowed(guardRun(runRequest("203.0.113.7", { "x-launchblocks-token": "s3cret" }), galleryFlow()));
  });

  it("counts runs per visitor and hour, by the address the proxy set", async () => {
    vi.stubEnv("LAUNCHBLOCKS_RUNS_PER_HOUR", "2");
    const guardRun = await loadGuard();
    allowed(guardRun(runRequest("198.51.100.1"), galleryFlow()));
    allowed(guardRun(runRequest("198.51.100.1"), galleryFlow()));

    const third = await refusal(guardRun(runRequest("198.51.100.1"), galleryFlow()));
    expect(third).toMatchObject({ status: 429, body: { error: { code: "RATE_LIMITED" } } });
    expect(third.body.error.hint).toMatch(/Try again in \d+ seconds/);

    // A forged X-Forwarded-For does not make a new visitor: nginx sets X-Real-IP.
    const forged = runRequest("198.51.100.1", { "x-forwarded-for": "10.9.8.7" });
    expect(await refusal(guardRun(forged, galleryFlow()))).toMatchObject({ status: 429 });
    allowed(guardRun(runRequest("198.51.100.2"), galleryFlow()));
  });

  it("counts one IPv6 /64 as one visitor", async () => {
    vi.stubEnv("LAUNCHBLOCKS_RUNS_PER_HOUR", "1");
    const guardRun = await loadGuard();
    allowed(guardRun(runRequest("2001:db8:1:2::10"), galleryFlow()));
    expect(await refusal(guardRun(runRequest("2001:db8:1:2::99"), galleryFlow()))).toMatchObject({ status: 429 });
    allowed(guardRun(runRequest("2001:db8:1:3::10"), galleryFlow()));
  });

  it("keeps a private deployment free of the public-demo policy", async () => {
    const guardRun = await loadGuard();
    const guard = allowed(guardRun(runRequest(), galleryFlow("hts-launch-saucerswap")));
    expect(guard.beforeStep).toBeUndefined();
    // No one-run-at-a-time rule either.
    allowed(guardRun(runRequest(), galleryFlow()));
  });
});

describe("guardRun on a public demo", () => {
  beforeEach(() => vi.stubEnv("LAUNCHBLOCKS_PUBLIC_DEMO", "true"));

  it("refuses a flow that sends value to something the launch did not create", async () => {
    const guardRun = await loadGuard();
    const { status, body } = await refusal(guardRun(runRequest(), validFlow(OUTSIDE_TRANSFER)));
    expect(status).toBe(403);
    expect(body.error.code).toBe("PUBLIC_RUN_REFUSED");
    expect(body.error.issues).toEqual([expect.objectContaining({ stepId: "send", path: "steps[0].params.tokenId" })]);
  });

  it("runs every gallery flow, with a per-step check", async () => {
    const guardRun = await loadGuard();
    for (const { id } of GALLERY) {
      const guard = allowed(guardRun(runRequest(), galleryFlow(id)));
      expect(guard.beforeStep).toBeTypeOf("function");
      guard.release();
    }
  });

  it("lets each visitor run one flow at a time", async () => {
    const guardRun = await loadGuard();
    const first = allowed(guardRun(runRequest(), galleryFlow()));
    expect(await refusal(guardRun(runRequest(), galleryFlow()))).toMatchObject({
      status: 429,
      body: { error: { code: "RUN_IN_PROGRESS" } },
    });
    allowed(guardRun(runRequest("198.51.100.9"), galleryFlow()));

    first.release();
    allowed(guardRun(runRequest(), galleryFlow()));
    // Releasing the finished run again must not free the one now in progress.
    first.release();
    expect(await refusal(guardRun(runRequest(), galleryFlow()))).toMatchObject({ status: 429 });
  });

  it("stops once the hour's HBAR budget is spent, across visitors", async () => {
    const flow = galleryFlow();
    const cost = publicRunHbarEstimate(flow, DEFAULT_PUBLIC_RUN_LIMITS);
    vi.stubEnv("LAUNCHBLOCKS_PUBLIC_HBAR_PER_HOUR", String(cost * 1.5));
    const guardRun = await loadGuard();

    allowed(guardRun(runRequest("198.51.100.1"), flow)).release();
    const { status, body } = await refusal(guardRun(runRequest("198.51.100.2"), flow));
    expect(status).toBe(429);
    expect(body.error).toMatchObject({ code: "PUBLIC_BUDGET_SPENT" });
    expect(body.error.hint).toMatch(/frees up in about \d+ minutes/);
  });
});
