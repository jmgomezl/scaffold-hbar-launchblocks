import { RefResolutionError } from "../errors";

/**
 * Step references let a parameter consume the output of an earlier step.
 *
 * Syntax: `{{steps.<stepId>.<outputKey>}}`
 *
 * - A string that is exactly one reference resolves to the referenced value
 *   with its original type (so a numeric output stays a number).
 * - A string containing references among other text is interpolated.
 * - Arrays and plain objects are resolved recursively.
 */

export type StepRef = {
  stepId: string;
  key: string;
  /** The reference exactly as written, including braces. */
  raw: string;
};

const REF_PATTERN = /\{\{\s*steps\.([a-z][a-zA-Z0-9]*)\.([a-z][a-zA-Z0-9]*)\s*\}\}/g;
const WHOLE_REF_PATTERN = /^\{\{\s*steps\.([a-z][a-zA-Z0-9]*)\.([a-z][a-zA-Z0-9]*)\s*\}\}$/;

/** Build a reference string for use in flow JSON. */
export function ref(stepId: string, key: string): string {
  return `{{steps.${stepId}.${key}}}`;
}

/** Parse a string that is exactly one reference; `null` otherwise. */
export function parseRef(value: unknown): StepRef | null {
  if (typeof value !== "string") return null;
  const match = WHOLE_REF_PATTERN.exec(value);
  if (!match) return null;
  return { stepId: match[1] as string, key: match[2] as string, raw: value };
}

/** Every reference appearing anywhere inside `value`, in document order. */
export function findRefs(value: unknown): StepRef[] {
  const refs: StepRef[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      for (const match of node.matchAll(REF_PATTERN)) {
        refs.push({ stepId: match[1] as string, key: match[2] as string, raw: match[0] });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (isPlainObject(node)) {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return refs;
}

export type StepOutputs = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * Replace every reference inside `value` with the corresponding output.
 * Throws {@link RefResolutionError} when a step or key is missing.
 */
export function resolveRefs<T>(value: T, outputs: StepOutputs): T {
  return visitResolve(value, outputs) as T;
}

function visitResolve(node: unknown, outputs: StepOutputs): unknown {
  if (typeof node === "string") {
    const whole = parseRef(node);
    if (whole) return lookup(whole, outputs);
    return node.replace(REF_PATTERN, (raw, stepId: string, key: string) =>
      stringify(lookup({ stepId, key, raw }, outputs)),
    );
  }
  if (Array.isArray(node)) {
    return node.map(item => visitResolve(item, outputs));
  }
  if (isPlainObject(node)) {
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, visitResolve(v, outputs)]));
  }
  return node;
}

function lookup(target: StepRef, outputs: StepOutputs): unknown {
  const stepOutputs = outputs[target.stepId];
  if (!stepOutputs) {
    throw new RefResolutionError(target.raw, `step "${target.stepId}" has not produced outputs yet`);
  }
  if (!(target.key in stepOutputs)) {
    const available = Object.keys(stepOutputs);
    throw new RefResolutionError(
      target.raw,
      `step "${target.stepId}" has no output "${target.key}"` +
        (available.length ? ` (available: ${available.join(", ")})` : ""),
    );
  }
  return stepOutputs[target.key];
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
