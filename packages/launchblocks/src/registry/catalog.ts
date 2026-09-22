import { z } from "zod";

import type { StepRegistry } from "./registry";
import type { AnyStepDefinition, StepDocs, StepUi } from "./types";

/** Everything an editor needs to render and configure a step, serializable as JSON. */
export type StepCatalogEntry = {
  type: string;
  ui: StepUi;
  docs: StepDocs;
  /** JSON Schema (draft 2020-12) of the step's params before defaults. */
  inputSchema: Record<string, unknown>;
  outputExample: Record<string, unknown>;
};

export function describeStep(definition: AnyStepDefinition): StepCatalogEntry {
  return {
    type: definition.type,
    ui: definition.ui,
    docs: definition.docs,
    inputSchema: z.toJSONSchema(definition.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>,
    outputExample: definition.outputExample,
  };
}

export function stepCatalog(registry: StepRegistry): StepCatalogEntry[] {
  return registry.list().map(describeStep);
}
