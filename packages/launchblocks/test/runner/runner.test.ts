import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { FlowValidationError, LaunchBlocksError, StepExecutionError } from "../../src/errors";
import { ref } from "../../src/flow/refs";
import { defineStep } from "../../src/registry/define-step";
import { createRegistry } from "../../src/registry/registry";
import type { RunEvent } from "../../src/runner/runner";
import { linksFor, runFlow } from "../../src/runner/runner";
import { FAKE_STEPS, fakeRunContext, makeToken } from "../helpers/fake-steps";

const registry = createRegistry(FAKE_STEPS);

const launchFlow = {
  schemaVersion: 1,
  id: "launch",
  name: "Launch",
  steps: [
    { id: "mint", type: "fake.makeToken", label: "Mint it", params: { symbol: "LB" } },
    {
      id: "spend",
      type: "fake.useToken",
      params: { tokenId: ref("mint", "tokenId"), amount: 3, memo: `spent ${ref("mint", "tokenId")}` },
    },
  ],
};

describe("runFlow()", () => {
  it("runs steps in order, resolving references and recording outputs", async () => {
    const result = await runFlow(launchFlow, { registry, ctx: fakeRunContext() });

    expect(result.status).toBe("succeeded");
    expect(result.error).toBeUndefined();
    expect(result.steps.map(s => s.status)).toEqual(["succeeded", "succeeded"]);
    expect(result.outputs.mint?.tokenId).toBe("0.0.1002");
    expect(result.steps[1]?.input).toEqual({ tokenId: "0.0.1002", amount: 3, memo: "spent 0.0.1002" });
    expect(result.outputs.spend).toEqual({ ok: true, memo: "spent 0.0.1002" });
    expect(result.steps[0]?.label).toBe("Mint it");
    expect(result.steps[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(result.finishedAt)).toBeGreaterThanOrEqual(Date.parse(result.startedAt));
  });

  it("applies step input defaults before executing", async () => {
    const result = await runFlow(launchFlow, { registry, ctx: fakeRunContext() });
    expect(result.steps[0]?.input).toEqual({ symbol: "LB", decimals: 8 });
  });

  it("derives explorer links from output kinds", async () => {
    const result = await runFlow(launchFlow, { registry, ctx: fakeRunContext() });
    expect(result.steps[0]?.links).toEqual([{ label: "Token id", url: "https://hashscan.io/testnet/token/0.0.1002" }]);
    expect(result.steps[1]?.links).toEqual([]);
  });

  it("emits lifecycle events in order", async () => {
    const events: string[] = [];
    await runFlow(launchFlow, {
      registry,
      ctx: fakeRunContext(),
      onEvent: (event: RunEvent) => events.push("step" in event ? `${event.type}:${event.step.id}` : event.type),
    });
    expect(events).toEqual([
      "flow:start",
      "step:start:mint",
      "step:success:mint",
      "step:start:spend",
      "step:success:spend",
      "flow:end",
    ]);
  });

  it("logs step outcomes through the context logger", async () => {
    const log = vi.fn();
    await runFlow(launchFlow, { registry, ctx: fakeRunContext({ log }) });
    expect(log).toHaveBeenCalledWith(
      "info",
      "step mint succeeded",
      expect.objectContaining({ type: "fake.makeToken" }),
    );
  });

  it("throws FlowValidationError before running anything invalid", async () => {
    const log = vi.fn();
    await expect(
      runFlow(
        { ...launchFlow, steps: [{ id: "x", type: "nope.nothing" }] },
        { registry, ctx: fakeRunContext({ log }) },
      ),
    ).rejects.toThrowError(FlowValidationError);
    expect(log).not.toHaveBeenCalled();
  });

  it("refuses to run a flow on a different network than the operator context", async () => {
    await expect(
      runFlow({ ...launchFlow, network: "mainnet" }, { registry, ctx: fakeRunContext({ network: "testnet" }) }),
    ).rejects.toMatchObject({ code: "NETWORK_MISMATCH" });
  });

  it("captures a failing step, skips the rest and reports the failure", async () => {
    const result = await runFlow(
      {
        ...launchFlow,
        steps: [
          launchFlow.steps[0],
          { id: "boom", type: "fake.explode", params: { reason: "insufficient balance" } },
          launchFlow.steps[1],
        ],
      },
      { registry, ctx: fakeRunContext() },
    );

    expect(result.status).toBe("failed");
    expect(result.steps.map(s => s.status)).toEqual(["succeeded", "failed", "skipped"]);
    expect(result.error).toEqual({
      stepId: "boom",
      code: "STEP_FAILED",
      message: 'Step "boom" (fake.explode) failed: insufficient balance',
    });
    expect(result.outputs).toEqual({ mint: { tokenId: "0.0.1002", decimals: 8, transactionId: "0.0.2@1.0" } });
  });

  it("keeps hints from StepExecutionError", async () => {
    const hinting = defineStep({
      type: "fake.hint",
      input: z.object({}),
      output: z.object({ x: z.number() }),
      outputExample: { x: 1 },
      ui: { label: "Hint", category: "util", colour: 0, fields: [], outputs: [] },
      docs: { summary: "", hederaServices: [] },
      async execute(): Promise<{ x: number }> {
        throw new StepExecutionError({
          stepId: "h",
          stepType: "fake.hint",
          message: "no HBAR",
          hint: "Use the faucet",
        });
      },
      codegen: () => ({ body: "" }),
    });
    const result = await runFlow(
      { ...launchFlow, steps: [{ id: "h", type: "fake.hint" }] },
      { registry: createRegistry([hinting]), ctx: fakeRunContext() },
    );
    expect(result.steps[0]?.error?.hint).toBe("Use the faucet");
  });

  it("fails a step whose executor violates its own output schema", async () => {
    const liar = defineStep({
      type: "fake.liar",
      input: z.object({}),
      output: z.object({ tokenId: z.string() }),
      outputExample: { tokenId: "0.0.1" },
      ui: { label: "Liar", category: "util", colour: 0, fields: [], outputs: [] },
      docs: { summary: "", hederaServices: [] },
      execute: async () => ({ tokenId: 42 as unknown as string }),
      codegen: () => ({ body: "" }),
    });
    const result = await runFlow(
      { ...launchFlow, steps: [{ id: "lie", type: "fake.liar" }] },
      { registry: createRegistry([liar]), ctx: fakeRunContext() },
    );
    expect(result.status).toBe("failed");
    expect(result.error?.message).toMatch(/violates its own schema \(tokenId:/);
    expect(result.error?.hint).toMatch(/bug in the step definition/);
  });

  it("stops before a step when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runFlow(launchFlow, { registry, ctx: fakeRunContext({ signal: controller.signal }) });
    expect(result.steps.map(s => s.status)).toEqual(["failed", "skipped"]);
    expect(result.error?.message).toMatch(/cancelled/);
  });

  it("wraps generic LaunchBlocksErrors thrown by executors", async () => {
    const custom = defineStep({
      type: "fake.custom",
      input: z.object({}),
      output: z.object({}),
      outputExample: {},
      ui: { label: "Custom", category: "util", colour: 0, fields: [], outputs: [] },
      docs: { summary: "", hederaServices: [] },
      async execute(): Promise<Record<string, never>> {
        throw new LaunchBlocksError("MIRROR_TIMEOUT", "mirror node did not catch up");
      },
      codegen: () => ({ body: "" }),
    });
    const result = await runFlow(
      { ...launchFlow, steps: [{ id: "c", type: "fake.custom" }] },
      { registry: createRegistry([custom]), ctx: fakeRunContext() },
    );
    expect(result.error).toMatchObject({
      code: "STEP_FAILED",
      message: expect.stringContaining("mirror node did not catch up"),
    });
  });
});

describe("linksFor()", () => {
  it("ignores empty and non-string values", () => {
    expect(linksFor(makeToken, { tokenId: "", decimals: 8 }, "testnet")).toEqual([]);
  });
});
