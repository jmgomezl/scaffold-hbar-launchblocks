import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineStep } from "../../src/registry/define-step";
import type { StepDefinition } from "../../src/registry/types";

const base: StepDefinition<{ a: string }, { b: number }> = {
  type: "fake.ok",
  input: z.object({ a: z.string() }),
  output: z.object({ b: z.number() }),
  outputExample: { b: 1 },
  ui: {
    label: "Ok",
    category: "util",
    colour: 0,
    fields: [{ key: "a", label: "A", kind: "text" }],
    outputs: [{ key: "b", label: "B", kind: "number" }],
  },
  docs: { summary: "ok", hederaServices: [] },
  execute: async () => ({ b: 1 }),
  codegen: ctx => ({ body: `const ${ctx.stepId} = { b: 1 };` }),
};

describe("defineStep()", () => {
  it("returns the definition unchanged when it is well-formed", () => {
    expect(defineStep(base)).toBe(base);
  });

  it("rejects malformed types", () => {
    expect(() => defineStep({ ...base, type: "NotNamespaced" })).toThrow(/namespace\.action/);
  });

  it("rejects an outputExample that does not satisfy the output schema", () => {
    expect(() => defineStep({ ...base, outputExample: { b: "1" as unknown as number } })).toThrow(/outputExample/);
  });

  it("rejects ui.outputs that are not real outputs", () => {
    expect(() =>
      defineStep({ ...base, ui: { ...base.ui, outputs: [{ key: "zzz", label: "Z", kind: "text" }] } }),
    ).toThrow(/"zzz"/);
  });

  it("rejects duplicate ui.fields keys", () => {
    const fields = [
      { key: "a", label: "A", kind: "text" as const },
      { key: "a", label: "A again", kind: "text" as const },
    ];
    expect(() => defineStep({ ...base, ui: { ...base.ui, fields } })).toThrow(/twice/);
  });

  it("rejects select fields without options", () => {
    const fields = [{ key: "a", label: "A", kind: "select" as const }];
    expect(() => defineStep({ ...base, ui: { ...base.ui, fields } })).toThrow(/needs options/);
  });
});
