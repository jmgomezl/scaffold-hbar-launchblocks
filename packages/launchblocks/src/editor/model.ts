import { isValidStepId } from "../flow/ids";
import { isPlainObject, parseRef, ref } from "../flow/refs";
import type { FlowInput, Network } from "../flow/schema";
import type { StepCatalogEntry } from "../registry/catalog";
import type { FieldKind, FieldSpec } from "../registry/types";

/**
 * The block editor's view of a flow, and the conversions between it and flow
 * JSON. Everything here is pure and free of zod and the Hedera SDK, so it
 * runs in the browser; the Blockly layer only maps blocks to and from these
 * shapes. The flow JSON stays the source of truth: nothing the editor can
 * express is missing from it.
 */

/** Field kinds that name an on-chain entity and can take an earlier step's output. */
export const REFERENCE_KINDS: ReadonlySet<FieldKind> = new Set([
  "accountId",
  "tokenId",
  "topicId",
  "contractId",
  "scheduleId",
]);

export function isReferenceKind(kind: FieldKind): boolean {
  return REFERENCE_KINDS.has(kind);
}

/** Checkboxes and dropdowns always hold a value, so they cannot signal "unset". */
const ALWAYS_SET_KINDS: ReadonlySet<FieldKind> = new Set(["boolean", "select"]);

export type EditorValue = string | boolean;

export type EditorStep = {
  type: string;
  id: string;
  label?: string;
  /**
   * One value per `ui.fields` entry, keyed by field key. Reference-kind values
   * are either a literal id or a whole `{{steps.<id>.<key>}}` reference.
   */
  values: Record<string, EditorValue>;
  /** Params the flow carries that no editor field represents, kept verbatim. */
  extra: Record<string, unknown>;
};

export type EditorDocument = {
  id: string;
  name: string;
  description?: string;
  network: Network;
  steps: EditorStep[];
};

export type Catalog = ReadonlyMap<string, StepCatalogEntry>;

export function indexCatalog(entries: readonly StepCatalogEntry[]): Catalog {
  return new Map(entries.map(entry => [entry.type, entry]));
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function getPath(target: unknown, path: string): unknown {
  let node: unknown = target;
  for (const segment of path.split(".")) {
    if (!isPlainObject(node)) return undefined;
    node = node[segment];
  }
  return node;
}

export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let node = target;
  segments.slice(0, -1).forEach(segment => {
    const next = node[segment];
    if (!isPlainObject(next)) node[segment] = {};
    node = node[segment] as Record<string, unknown>;
  });
  node[segments[segments.length - 1] as string] = value;
}

/** Delete `path`, then drop any parent objects the deletion left empty. */
export function deletePath(target: Record<string, unknown>, path: string): void {
  const segments = path.split(".");
  const parents: Record<string, unknown>[] = [target];
  for (const segment of segments.slice(0, -1)) {
    const next = parents[parents.length - 1]?.[segment];
    if (!isPlainObject(next)) return;
    parents.push(next);
  }
  delete parents[parents.length - 1]?.[segments[segments.length - 1] as string];
  for (let i = parents.length - 1; i > 0; i -= 1) {
    if (Object.keys(parents[i] as object).length > 0) break;
    delete parents[i - 1]?.[segments[i - 1] as string];
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// ── Defaults ────────────────────────────────────────────────────────────────

/** The `default` a JSON Schema declares at `path`, looking through parent defaults too. */
export function schemaDefault(schema: Record<string, unknown>, path: string): unknown {
  let node: unknown = schema;
  const segments = path.split(".");
  for (const [index, segment] of segments.entries()) {
    if (!isPlainObject(node)) return undefined;
    const properties = node.properties;
    const child = isPlainObject(properties) ? properties[segment] : undefined;
    if (!isPlainObject(child)) {
      // A parent default such as `keys: { default: {...} }` can still answer.
      return "default" in node ? getPath(node.default, segments.slice(index).join(".")) : undefined;
    }
    node = child;
  }
  return isPlainObject(node) ? node.default : undefined;
}

export function defaultValue(entry: StepCatalogEntry, field: FieldSpec): EditorValue {
  const fallback = schemaDefault(entry.inputSchema, field.key);
  switch (field.kind) {
    case "boolean":
      return typeof fallback === "boolean" ? fallback : false;
    case "select":
      return typeof fallback === "string" ? fallback : (field.options?.[0]?.value ?? "");
    case "json":
      return fallback === undefined ? "" : typeof fallback === "string" ? fallback : JSON.stringify(fallback, null, 2);
    default:
      return fallback === undefined || fallback === null ? "" : String(fallback);
  }
}

// ── Ids ─────────────────────────────────────────────────────────────────────

/** A fresh step id derived from the step type, e.g. `hts.createToken` → `createToken`, `createToken2`. */
export function nextStepId(type: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const action = type.split(".").pop() ?? "step";
  let base = action.charAt(0).toLowerCase() + action.slice(1);
  if (!isValidStepId(base)) base = `${base}Step`;
  if (!isValidStepId(base)) base = "step";
  if (!used.has(base) && isValidStepId(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Kebab-case flow id from a human name, e.g. "My Launch!" → "my-launch". */
export function flowIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || "my-launch";
}

export function newStep(entry: StepCatalogEntry, taken: Iterable<string>): EditorStep {
  return {
    type: entry.type,
    id: nextStepId(entry.type, taken),
    values: Object.fromEntries(entry.ui.fields.map(field => [field.key, defaultValue(entry, field)])),
    extra: {},
  };
}

// ── Editor → flow ───────────────────────────────────────────────────────────

/** Convert one editor value into the param it stands for; `undefined` means "leave unset". */
export function toParam(field: FieldSpec, value: EditorValue | undefined): unknown {
  if (field.kind === "boolean") return value === true || value === "true";
  const text = typeof value === "string" ? value.trim() : value === undefined ? "" : String(value);
  if (text === "") return undefined;
  switch (field.kind) {
    case "number": {
      if (parseRef(text)) return text;
      const number = Number(text);
      // Keep unparsable input as typed so validation reports it instead of it vanishing.
      return Number.isFinite(number) ? number : text;
    }
    case "json": {
      try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null ? parsed : text;
      } catch {
        return text;
      }
    }
    default:
      return text;
  }
}

/** Nested field groups, keyed by the path before the last dot (e.g. `fractionalFee`). */
function fieldGroups(fields: readonly FieldSpec[]): Map<string, FieldSpec[]> {
  const groups = new Map<string, FieldSpec[]>();
  for (const field of fields) {
    const dot = field.key.lastIndexOf(".");
    if (dot < 0) continue;
    const prefix = field.key.slice(0, dot);
    groups.set(prefix, [...(groups.get(prefix) ?? []), field]);
  }
  return groups;
}

/**
 * Build a step's params from its editor values.
 *
 * Optional nested groups need care: a fee group has a dropdown that always
 * holds a value, so "the user filled nothing in" would otherwise come out as
 * `{ assessment: "inclusive" }` and fail validation. A group whose free-form
 * fields are all empty is omitted entirely; a group made only of checkboxes
 * and dropdowns (like `keys`) is always kept.
 */
export function stepToParams(entry: StepCatalogEntry, step: EditorStep): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const field of entry.ui.fields) {
    const value = toParam(field, step.values[field.key]);
    if (value !== undefined) setPath(params, field.key, value);
  }

  const extra = clone(step.extra);
  for (const [prefix, fields] of fieldGroups(entry.ui.fields)) {
    const freeForm = fields.filter(field => !ALWAYS_SET_KINDS.has(field.kind));
    const empty = freeForm.every(field => toParam(field, step.values[field.key]) === undefined);
    if (freeForm.length > 0 && empty) {
      deletePath(params, prefix);
      deletePath(extra, prefix);
    }
  }

  return mergeDeep(params, extra);
}

function mergeDeep(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? mergeDeep(existing, value) : value;
  }
  return out;
}

export function editorToFlow(document: EditorDocument, catalog: Catalog): FlowInput {
  return {
    schemaVersion: 1,
    id: document.id,
    name: document.name,
    ...(document.description ? { description: document.description } : {}),
    network: document.network,
    steps: document.steps.map(step => {
      const entry = catalog.get(step.type);
      return {
        id: step.id,
        type: step.type,
        ...(step.label ? { label: step.label } : {}),
        params: entry ? stepToParams(entry, step) : clone(step.extra),
      };
    }),
  };
}

// ── Flow → editor ───────────────────────────────────────────────────────────

export function fromParam(field: FieldSpec, raw: unknown): EditorValue {
  if (field.kind === "boolean") return raw === true || raw === "true";
  if (field.kind === "json") return typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
  return String(raw);
}

export function paramsToStep(
  entry: StepCatalogEntry,
  step: { id: string; type: string; label?: string | undefined; params?: Record<string, unknown> | undefined },
): EditorStep {
  const params = step.params ?? {};
  const values: Record<string, EditorValue> = {};
  const extra = clone(params);
  for (const field of entry.ui.fields) {
    const raw = getPath(params, field.key);
    values[field.key] = raw === undefined ? defaultValue(entry, field) : fromParam(field, raw);
    deletePath(extra, field.key);
  }
  return { type: step.type, id: step.id, ...(step.label ? { label: step.label } : {}), values, extra };
}

export type LoadProblem = { stepId: string; message: string };

/**
 * Turn a flow document into editor state. Steps whose type the catalog does
 * not know are kept (with all params as `extra`) and reported, so saving the
 * document again does not silently drop them.
 */
export function flowToEditor(flow: FlowInput, catalog: Catalog): { document: EditorDocument; problems: LoadProblem[] } {
  const problems: LoadProblem[] = [];
  const steps = flow.steps.map(step => {
    const entry = catalog.get(step.type);
    if (!entry) {
      problems.push({ stepId: step.id, message: `unknown step type "${step.type}"` });
      return {
        type: step.type,
        id: step.id,
        ...(step.label ? { label: step.label } : {}),
        values: {},
        extra: clone(step.params ?? {}),
      };
    }
    return paramsToStep(entry, step);
  });
  return {
    document: {
      id: flow.id,
      name: flow.name,
      ...(flow.description ? { description: flow.description } : {}),
      network: flow.network ?? "testnet",
      steps,
    },
    problems,
  };
}

// ── Wiring helpers ──────────────────────────────────────────────────────────

export type StepOutputRef = {
  stepId: string;
  key: string;
  label: string;
  kind: FieldKind;
  /** `{{steps.<stepId>.<key>}}` */
  reference: string;
};

/** Outputs a step exposes to later steps, in the order its definition lists them. */
export function outputsOf(step: Pick<EditorStep, "id" | "type">, catalog: Catalog): StepOutputRef[] {
  const entry = catalog.get(step.type);
  if (!entry) return [];
  return entry.ui.outputs.map(output => ({
    stepId: step.id,
    key: output.key,
    label: output.label,
    kind: output.kind,
    reference: ref(step.id, output.key),
  }));
}

/** Earlier outputs a field of `kind` at position `index` could take. */
export function referenceOptions(
  steps: readonly Pick<EditorStep, "id" | "type">[],
  index: number,
  kind: FieldKind,
  catalog: Catalog,
): StepOutputRef[] {
  return steps.slice(0, index).flatMap(step => outputsOf(step, catalog).filter(output => output.kind === kind));
}

/** Rewrite every reference to `oldId` (in values and extra) after a step is renamed. */
export function renameStepReferences(steps: readonly EditorStep[], oldId: string, newId: string): EditorStep[] {
  const pattern = new RegExp(`(\\{\\{\\s*steps\\.)${escapeRegExp(oldId)}(\\.[a-z][a-zA-Z0-9]*\\s*\\}\\})`, "g");
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(pattern, `$1${newId}$2`);
    if (Array.isArray(value)) return value.map(rewrite);
    if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v)]));
    return value;
  };
  return steps.map(step => ({
    ...step,
    id: step.id === oldId ? newId : step.id,
    values: rewrite(step.values) as Record<string, EditorValue>,
    extra: rewrite(step.extra) as Record<string, unknown>,
  }));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
