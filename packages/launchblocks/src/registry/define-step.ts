import type { StepDefinition } from "./types";
import { STEP_TYPE_PATTERN } from "../flow/schema";

/**
 * Identity helper that pins the generic parameters from the zod schemas and
 * performs the authoring checks that TypeScript cannot express.
 */
export function defineStep<In, Out extends Record<string, unknown>>(
  definition: StepDefinition<In, Out>,
): StepDefinition<In, Out> {
  if (!STEP_TYPE_PATTERN.test(definition.type)) {
    throw new Error(`Step type "${definition.type}" must look like namespace.action`);
  }

  const parsedExample = definition.output.safeParse(definition.outputExample);
  if (!parsedExample.success) {
    throw new Error(`Step "${definition.type}": outputExample does not satisfy its output schema`);
  }

  const outputKeys = new Set(Object.keys(definition.outputExample));
  for (const spec of definition.ui.outputs) {
    if (!outputKeys.has(spec.key)) {
      throw new Error(`Step "${definition.type}": ui.outputs declares "${spec.key}" which is not in outputExample`);
    }
  }

  const fieldKeys = definition.ui.fields.map(f => f.key);
  const duplicateField = fieldKeys.find((key, index) => fieldKeys.indexOf(key) !== index);
  if (duplicateField) {
    throw new Error(`Step "${definition.type}": ui.fields declares "${duplicateField}" twice`);
  }
  for (const field of definition.ui.fields) {
    if (field.kind === "select" && !field.options?.length) {
      throw new Error(`Step "${definition.type}": select field "${field.key}" needs options`);
    }
  }

  return definition;
}
