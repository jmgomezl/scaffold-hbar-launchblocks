import ts from "typescript";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { generateLaunchScript } from "../../src/codegen/typescript";
import { GALLERY } from "../../src/gallery";
import type { CodegenContext } from "../../src/registry/types";
import { BUILT_IN_STEPS, createDefaultRegistry } from "../../src/steps";

/**
 * Invariants every shipped step must satisfy. A new step that breaks one of
 * these would confuse the editor or the generated script.
 */

const registry = createDefaultRegistry();

/** Walk a JSON schema by a dotted path, through objects, unions and nullable wrappers. */
function schemaHasPath(schema: Record<string, unknown>, path: string): boolean {
  const [head, ...rest] = path.split(".");
  const candidates = [schema, ...((schema.anyOf as Record<string, unknown>[] | undefined) ?? [])];
  for (const candidate of candidates) {
    const properties = candidate.properties as Record<string, Record<string, unknown>> | undefined;
    const next = properties?.[head as string];
    if (!next) continue;
    if (rest.length === 0) return true;
    if (schemaHasPath(next, rest.join("."))) return true;
  }
  return false;
}

function parses(body: string): string[] {
  const file = ts.createSourceFile(
    "s.ts",
    `async () => {\n${body}\n};`,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TS,
  );
  return (file as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics.map(d => String(d.messageText));
}

describe.each(BUILT_IN_STEPS.map(step => [step.type, step] as const))("%s", (_type, step) => {
  it("has an outputExample that satisfies its output schema", () => {
    expect(step.output.safeParse(step.outputExample).success).toBe(true);
  });

  it("only exposes real outputs to later steps", () => {
    const keys = Object.keys(step.outputExample);
    for (const spec of step.ui.outputs) expect(keys).toContain(spec.key);
  });

  it("only declares editor fields that exist in the input schema", () => {
    const jsonSchema = z.toJSONSchema(step.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
    for (const field of step.ui.fields) {
      expect(schemaHasPath(jsonSchema, field.key), `${step.type} field ${field.key}`).toBe(true);
    }
  });

  it("documents itself", () => {
    expect(step.docs.summary.length).toBeGreaterThan(10);
    expect(step.docs.hederaServices.length).toBeGreaterThan(0);
    expect(step.ui.label.length).toBeGreaterThan(0);
  });

  it("generates a parseable step body", () => {
    const imports = new Map<string, string[]>();
    const ctx: CodegenContext = {
      stepId: "sample",
      coreModule: "@sh/launchblocks",
      expr: key => JSON.stringify(`<${key}>`),
      addImport: (specifier, ...names) => imports.set(specifier, names),
    };
    const { body } = step.codegen(ctx);
    expect(parses(body)).toEqual([]);
    expect(body).toMatch(/^return await /);
    expect(imports.has("@sh/launchblocks")).toBe(true);
  });
});

describe("gallery flows", () => {
  it.each(GALLERY.map(entry => [entry.id, entry] as const))("%s validates and generates a script", (_id, entry) => {
    expect(entry.flow.id).toBe(entry.id);
    const flow = registry.validateFlow(entry.flow);
    expect(flow.steps.length).toBeGreaterThan(0);
    const script = generateLaunchScript(entry.flow, registry);
    const file = ts.createSourceFile("launch.ts", script, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    expect((file as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics).toEqual([]);
  });
});
