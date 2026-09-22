import type { ZodType } from "zod";

import type { Network } from "../flow/schema";
import type { HederaContext } from "../hedera/context";

/**
 * Field kinds drive both the Blockly block shape and the editor's
 * "use output of an earlier step" dropdown: an output of kind `tokenId`
 * is offered to inputs of kind `tokenId`.
 */
export type FieldKind =
  | "text"
  | "number"
  | "boolean"
  | "select"
  | "accountId"
  | "tokenId"
  | "topicId"
  | "contractId"
  | "scheduleId"
  | "transactionId"
  | "amount"
  | "json";

export type FieldSpec = {
  /** Param key in `step.params`; dotted for nested params, e.g. `keys.admin`. */
  key: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  help?: string;
  /** Required for `select`. */
  options?: readonly { value: string; label: string }[];
};

export type OutputSpec = {
  key: string;
  label: string;
  kind: FieldKind;
};

export type StepCategory = "hts" | "hcs" | "hss" | "saucerswap" | "oracle" | "contract" | "util";

export type StepUi = {
  /** Block title, e.g. "Create HTS token". */
  label: string;
  category: StepCategory;
  /** Blockly hue (0-360). Steps in one category should share it. */
  colour: number;
  fields: readonly FieldSpec[];
  outputs: readonly OutputSpec[];
  tooltip?: string;
};

export type HederaService = "HTS" | "HCS" | "HSS" | "SmartContract" | "MirrorNode";

export type StepDocs = {
  /** One line for the README step table. */
  summary: string;
  /** Markdown; rendered on the step's help panel and in generated docs. */
  details?: string;
  hederaServices: readonly HederaService[];
  /** Third-party protocols this step depends on, e.g. "SaucerSwap". */
  integrations?: readonly string[];
};

export type LogLevel = "debug" | "info" | "warn" | "error";
export type Logger = (level: LogLevel, message: string, meta?: Record<string, unknown>) => void;

export type RunContext = {
  network: Network;
  hedera: HederaContext;
  log: Logger;
  /** Aborts long waits (mirror node polling) when the caller cancels the run. */
  signal?: AbortSignal;
};

/** What a step's `codegen` receives: symbolic access to its params. */
export type CodegenContext = {
  stepId: string;
  /** Module specifier that resolves to this package in the generated file. */
  coreModule: string;
  /**
   * TypeScript expression for a param. Literals become JSON literals;
   * references become `<stepId>.<key>`; interpolated strings become
   * template literals.
   */
  expr(key: string): string;
  /** Register a named import for the generated file (deduplicated). */
  addImport(specifier: string, ...names: string[]): void;
};

export type CodegenFragment = {
  /**
   * Body of an async function that performs the step with the SDK and
   * `return`s its outputs object. The generator wraps it as
   * `const <stepId> = await step("<stepId>", async () => { ...body })`,
   * so `ctx`, `client`, `operatorId` and `operatorKey` are in scope and
   * earlier steps are reachable as `<stepId>.<key>`.
   */
  body: string;
};

export type StepDefinition<In, Out extends Record<string, unknown>> = {
  /** `namespace.action`, unique across the registry. */
  type: string;
  input: ZodType<In>;
  output: ZodType<Out>;
  /**
   * A complete, realistic output. Used to type-check references between
   * steps before anything runs, and as the example in generated docs.
   */
  outputExample: Out;
  ui: StepUi;
  docs: StepDocs;
  execute(input: In, ctx: RunContext): Promise<Out>;
  codegen(ctx: CodegenContext): CodegenFragment;
};

// Method signatures are bivariant, so a concrete definition is assignable here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStepDefinition = StepDefinition<any, any>;

export type StepInputOf<D> = D extends StepDefinition<infer In, Record<string, unknown>> ? In : never;
export type StepOutputOf<D> = D extends StepDefinition<unknown, infer Out> ? Out : never;
