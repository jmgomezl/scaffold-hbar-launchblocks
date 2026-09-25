import type { FlowInput } from "@sh/launchblocks";
import { GALLERY } from "@sh/launchblocks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OUTSIDE_TRANSFER, clearServerEnv, fresh, galleryInput, json, post, stubOperator } from "~~/test/helpers";

const loadRun = () => fresh(() => import("~~/app/api/launchblocks/flows/run/route"));

/** Deploys a contract that was never compiled: the run stops in preflight, before any transaction. */
const DEPLOY_UNCOMPILED: FlowInput = {
  schemaVersion: 1,
  id: "deploy-uncompiled",
  name: "Deploy an uncompiled contract",
  network: "testnet",
  steps: [{ id: "deploy", type: "contract.deploy", params: { contract: "NeverCompiled" } }],
};

let artifactsDir: string;
beforeEach(() => {
  clearServerEnv();
  artifactsDir = mkdtempSync(path.join(tmpdir(), "launchblocks-artifacts-"));
  vi.stubEnv("LAUNCHBLOCKS_ARTIFACTS_DIR", artifactsDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(artifactsDir, { recursive: true, force: true });
});

describe("GET /api/launchblocks/steps and /gallery", () => {
  it("serve the step catalog and every gallery flow, whose steps the catalog lists", async () => {
    const steps = await json(await (await import("~~/app/api/launchblocks/steps/route")).GET());
    const gallery = await json(await (await import("~~/app/api/launchblocks/gallery/route")).GET());
    const types = new Set(steps.body.steps.map((step: { type: string }) => step.type));
    expect(types.has("hts.createToken")).toBe(true);
    expect(gallery.body.flows.map((flow: { id: string }) => flow.id)).toEqual(GALLERY.map(entry => entry.id));
    for (const { flow } of gallery.body.flows as { flow: FlowInput }[]) {
      for (const step of flow.steps) expect(types).toContain(step.type);
    }
  });
});

describe("POST /api/launchblocks/flows/validate", () => {
  const validate = async (body: unknown) =>
    json(await (await import("~~/app/api/launchblocks/flows/validate/route")).POST(post("/validate", body)));

  it("passes a gallery flow and says what one run costs", async () => {
    const { status, body } = await validate(galleryInput());
    expect({ status, ok: body.ok, issues: body.issues }).toEqual({ status: 200, ok: true, issues: [] });
    // Token with custom fees 26, topic 0.4, two messages 0.2, mint 0.1.
    expect(body.estimate).toMatchObject({ perRunHbar: 26.7, unknownAmounts: [] });
    expect(body.estimate.lines).toHaveLength(5);
  });

  it("answers 200 with every issue, for the editor to show inline", async () => {
    const flow = galleryInput();
    const token = flow.steps.find(step => step.type === "hts.createToken")!;
    token.params = { ...token.params, decimals: 30 };
    const { status, body } = await validate(flow);
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.issues).toEqual([
      expect.objectContaining({ stepId: token.id, path: expect.stringContaining("decimals") }),
    ]);
  });

  it("answers 400 to a body that is not JSON", async () => {
    expect(await validate("{")).toMatchObject({ status: 400, body: { error: { code: "BODY_INVALID" } } });
  });
});

describe("POST /api/launchblocks/flows/run", () => {
  it("rejects an invalid flow with its issues", async () => {
    const { POST } = await loadRun();
    const { status, body } = await json(await POST(post("/run", { ...galleryInput(), steps: [] })));
    expect(status).toBe(400);
    expect(body.error.code).toBe("FLOW_INVALID");
    expect(body.error.issues.length).toBeGreaterThan(0);
  });

  it("answers 503 without an operator, and frees the visitor's run for the next try", async () => {
    vi.stubEnv("LAUNCHBLOCKS_PUBLIC_DEMO", "true");
    const { POST } = await loadRun();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await json(await POST(post("/run", galleryInput())))).toMatchObject({
        status: 503,
        body: { error: { code: "OPERATOR_MISSING" } },
      });
    }
  });

  it("refuses a flow for another network than the operator's before running it", async () => {
    stubOperator("localnet");
    const { POST } = await loadRun();
    expect(await json(await POST(post("/run", galleryInput())))).toMatchObject({
      status: 409,
      body: { error: { code: "NETWORK_MISMATCH" } },
    });
  });

  it("applies the public-demo policy before touching the operator", async () => {
    vi.stubEnv("LAUNCHBLOCKS_PUBLIC_DEMO", "true");
    const { POST } = await loadRun();
    expect(await json(await POST(post("/run", OUTSIDE_TRANSFER)))).toMatchObject({
      status: 403,
      body: { error: { code: "PUBLIC_RUN_REFUSED" } },
    });
  });

  it("streams NDJSON, reports a failed preflight as its last line, and frees the visitor's run", async () => {
    vi.stubEnv("LAUNCHBLOCKS_PUBLIC_DEMO", "true");
    stubOperator();
    const { POST } = await loadRun();
    const stream = (ip: string) => POST(post("/run", DEPLOY_UNCOMPILED, { accept: "application/x-ndjson" }, ip));

    const response = await stream("198.51.100.4");
    expect(response.headers.get("content-type")).toMatch(/application\/x-ndjson/);
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    const lines = (await response.text())
      .trim()
      .split("\n")
      .map(line => JSON.parse(line));
    // The preflight stopped the run before flow:start: nothing reached the network.
    expect(lines).toEqual([
      {
        type: "error",
        error: expect.objectContaining({ code: "CONTRACT_ARTIFACT_MISSING", hint: expect.any(String) }),
      },
    ]);

    // The stream owned the visitor's run and released it when it closed.
    expect((await stream("198.51.100.4")).status).toBe(200);
  });
});

describe("POST /api/launchblocks/flows/codegen and /harness", () => {
  it("export a flow as launch.ts and as a harness recipe", async () => {
    // A recipe adds the flow to the gallery, so it must not be one already.
    const flow = { ...galleryInput("hts-launch-locked-liquidity"), id: "my-locked-launch", name: "My locked launch" };
    const codegen = await json(
      await (await import("~~/app/api/launchblocks/flows/codegen/route")).POST(post("/codegen", flow)),
    );
    expect(codegen.status).toBe(200);
    expect(codegen.body.source).toContain("Exported from the LaunchBlocks editor.");
    expect(codegen.body.source).toMatch(/deployContract\(ctx/);

    const harness = await json(
      await (await import("~~/app/api/launchblocks/flows/harness/route")).POST(post("/harness", flow)),
    );
    expect(harness.status).toBe(200);
    expect(harness.body.files.map((file: { path: string }) => file.path)).toContain(`.harness/${flow.id}.spec.yaml`);
  });
});
