import type { ZodError } from "zod";

import type { FlowIssue } from "../errors";
import { FlowValidationError, UnknownStepTypeError } from "../errors";
import type { Flow } from "../flow/schema";
import { FlowSchema } from "../flow/schema";
import { findRefs, resolveRefs } from "../flow/refs";
import type { AnyStepDefinition } from "./types";

export type StepRegistry = {
  register(definition: AnyStepDefinition): StepRegistry;
  has(type: string): boolean;
  get(type: string): AnyStepDefinition;
  list(): readonly AnyStepDefinition[];
  /**
   * Parse and fully validate a flow document: envelope schema, known step
   * types, per-step params, and reference wiring (target exists earlier,
   * output key exists, and the param accepts what the output produces).
   */
  validateFlow(document: unknown): Flow;
  /** Like `validateFlow` but returns issues instead of throwing. */
  checkFlow(document: unknown): { flow: Flow; issues: [] } | { flow: null; issues: FlowIssue[] };
};

export function createRegistry(definitions: readonly AnyStepDefinition[] = []): StepRegistry {
  const byType = new Map<string, AnyStepDefinition>();

  const registry: StepRegistry = {
    register(definition) {
      if (byType.has(definition.type)) {
        throw new Error(`Step type "${definition.type}" is already registered`);
      }
      byType.set(definition.type, definition);
      return registry;
    },
    has: type => byType.has(type),
    get(type) {
      const definition = byType.get(type);
      if (!definition) throw new UnknownStepTypeError(type);
      return definition;
    },
    list: () => [...byType.values()],
    checkFlow(document) {
      const envelope = FlowSchema.safeParse(document);
      if (!envelope.success) {
        return { flow: null, issues: zodIssues(envelope.error, "") };
      }
      const issues = checkSteps(envelope.data, byType);
      return issues.length ? { flow: null, issues } : { flow: envelope.data, issues: [] };
    },
    validateFlow(document) {
      const result = registry.checkFlow(document);
      if (result.flow) return result.flow;
      throw new FlowValidationError(result.issues);
    },
  };

  definitions.forEach(definition => registry.register(definition));
  return registry;
}

function checkSteps(flow: Flow, byType: ReadonlyMap<string, AnyStepDefinition>): FlowIssue[] {
  const issues: FlowIssue[] = [];
  /** Example outputs of the steps seen so far, keyed by step id. */
  const exampleOutputs: Record<string, Record<string, unknown>> = {};

  flow.steps.forEach((step, index) => {
    const base = `steps[${index}]`;
    const definition = byType.get(step.type);
    if (!definition) {
      issues.push({ path: `${base}.type`, stepId: step.id, message: `unknown step type "${step.type}"` });
      return;
    }

    let wiringOk = true;
    for (const target of findRefs(step.params)) {
      const targetOutputs = exampleOutputs[target.stepId];
      if (!targetOutputs) {
        const reason =
          target.stepId === step.id
            ? "a step cannot reference its own outputs"
            : flow.steps.some(s => s.id === target.stepId)
              ? `step "${target.stepId}" runs later; only earlier steps can be referenced`
              : `no step with id "${target.stepId}"`;
        issues.push({ path: `${base}.params`, stepId: step.id, message: `${target.raw}: ${reason}` });
        wiringOk = false;
        continue;
      }
      if (!(target.key in targetOutputs)) {
        issues.push({
          path: `${base}.params`,
          stepId: step.id,
          message: `${target.raw}: step "${target.stepId}" has no output "${target.key}" (available: ${Object.keys(targetOutputs).join(", ")})`,
        });
        wiringOk = false;
      }
    }

    if (wiringOk) {
      const substituted = resolveRefs(step.params, exampleOutputs);
      const parsed = definition.input.safeParse(substituted);
      if (!parsed.success) {
        issues.push(...zodIssues(parsed.error, `${base}.params`, step.id));
      }
    }

    exampleOutputs[step.id] = definition.outputExample;
  });

  return issues;
}

function zodIssues(error: ZodError, basePath: string, stepId?: string): FlowIssue[] {
  return error.issues.map(issue => {
    const suffix = issue.path
      .map(segment => (typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`))
      .join("");
    const path = (basePath + suffix).replace(/^\./, "") || "<root>";
    return stepId ? { path, stepId, message: issue.message } : { path, message: issue.message };
  });
}
