import { describe, expect, it } from "vitest";

import { FlowValidationError, UnknownStepTypeError } from "../../src/errors";
import { ref } from "../../src/flow/refs";
import { createRegistry } from "../../src/registry/registry";
import { FAKE_STEPS, makeToken, useToken } from "../helpers/fake-steps";

const registry = createRegistry(FAKE_STEPS);

const flow = (steps: unknown[], extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: "test-flow",
  name: "Test flow",
  steps,
  ...extra,
});

describe("createRegistry()", () => {
  it("registers definitions and lists them in insertion order", () => {
    expect(registry.list().map(d => d.type)).toEqual(["fake.makeToken", "fake.useToken", "fake.explode"]);
    expect(registry.has("fake.makeToken")).toBe(true);
    expect(registry.get("fake.useToken")).toBe(useToken);
  });

  it("rejects duplicate step types", () => {
    expect(() => createRegistry([makeToken, makeToken])).toThrow(/already registered/);
  });

  it("throws UnknownStepTypeError for unregistered types", () => {
    expect(() => registry.get("nope.nothing")).toThrowError(UnknownStepTypeError);
  });

  it("supports chained registration", () => {
    const r = createRegistry().register(makeToken).register(useToken);
    expect(r.list()).toHaveLength(2);
  });
});

describe("validateFlow()", () => {
  it("accepts a well-wired flow and applies step param defaults lazily", () => {
    const validated = registry.validateFlow(
      flow([
        { id: "mint", type: "fake.makeToken", params: { symbol: "LB" } },
        { id: "spend", type: "fake.useToken", params: { tokenId: ref("mint", "tokenId"), amount: 5 } },
      ]),
    );
    expect(validated.steps).toHaveLength(2);
    // Envelope validation keeps params as written; the runner parses per-step.
    expect(validated.steps[0]?.params).toEqual({ symbol: "LB" });
  });

  it("reports envelope problems with root-relative paths", () => {
    const result = registry.checkFlow(flow([{ id: "Bad Id", type: "fake.makeToken" }]));
    expect(result.flow).toBeNull();
    expect(result.issues[0]?.path).toBe("steps[0].id");
  });

  it("reports unknown step types", () => {
    const result = registry.checkFlow(flow([{ id: "x", type: "nope.nothing" }]));
    expect(result.issues).toEqual([
      { path: "steps[0].type", stepId: "x", message: 'unknown step type "nope.nothing"' },
    ]);
  });

  it("reports step param problems under the step path", () => {
    const result = registry.checkFlow(flow([{ id: "mint", type: "fake.makeToken", params: { symbol: "" } }]));
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ path: "steps[0].params.symbol", stepId: "mint" });
  });

  it("rejects references to later steps", () => {
    const result = registry.checkFlow(
      flow([
        { id: "spend", type: "fake.useToken", params: { tokenId: ref("mint", "tokenId"), amount: 1 } },
        { id: "mint", type: "fake.makeToken", params: { symbol: "LB" } },
      ]),
    );
    expect(result.issues[0]?.message).toMatch(/runs later/);
  });

  it("rejects self references", () => {
    const result = registry.checkFlow(
      flow([{ id: "spend", type: "fake.useToken", params: { tokenId: ref("spend", "memo"), amount: 1 } }]),
    );
    expect(result.issues[0]?.message).toMatch(/cannot reference its own/);
  });

  it("rejects references to missing steps", () => {
    const result = registry.checkFlow(
      flow([{ id: "spend", type: "fake.useToken", params: { tokenId: ref("ghost", "tokenId"), amount: 1 } }]),
    );
    expect(result.issues[0]?.message).toMatch(/no step with id "ghost"/);
  });

  it("rejects references to outputs the target step does not produce", () => {
    const result = registry.checkFlow(
      flow([
        { id: "mint", type: "fake.makeToken", params: { symbol: "LB" } },
        { id: "spend", type: "fake.useToken", params: { tokenId: ref("mint", "topicId"), amount: 1 } },
      ]),
    );
    expect(result.issues[0]?.message).toMatch(
      /has no output "topicId" \(available: tokenId, decimals, transactionId\)/,
    );
  });

  it("type-checks the wiring: a numeric output cannot feed a token id param", () => {
    const result = registry.checkFlow(
      flow([
        { id: "mint", type: "fake.makeToken", params: { symbol: "LB" } },
        { id: "spend", type: "fake.useToken", params: { tokenId: ref("mint", "decimals"), amount: 1 } },
      ]),
    );
    expect(result.issues[0]).toMatchObject({ path: "steps[1].params.tokenId", stepId: "spend" });
  });

  it("type-checks the wiring: a token id output can feed an interpolated memo", () => {
    const result = registry.checkFlow(
      flow([
        { id: "mint", type: "fake.makeToken", params: { symbol: "LB" } },
        {
          id: "spend",
          type: "fake.useToken",
          params: { tokenId: ref("mint", "tokenId"), amount: 1, memo: `launched ${ref("mint", "tokenId")}` },
        },
      ]),
    );
    expect(result.issues).toEqual([]);
  });

  it("collects issues across several steps instead of stopping at the first", () => {
    const result = registry.checkFlow(
      flow([
        { id: "a", type: "fake.makeToken", params: { symbol: "" } },
        { id: "b", type: "nope.nothing" },
        { id: "c", type: "fake.useToken", params: { tokenId: "bad", amount: -1 } },
      ]),
    );
    expect(result.issues.map(i => i.stepId)).toEqual(["a", "b", "c", "c"]);
  });

  it("throws FlowValidationError with the same issues", () => {
    expect(() => registry.validateFlow(flow([{ id: "x", type: "nope.nothing" }]))).toThrowError(FlowValidationError);
    try {
      registry.validateFlow(flow([{ id: "x", type: "nope.nothing" }]));
    } catch (error) {
      expect((error as FlowValidationError).issues).toHaveLength(1);
      expect((error as FlowValidationError).code).toBe("FLOW_INVALID");
    }
  });
});
