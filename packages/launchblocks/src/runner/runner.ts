import { LaunchBlocksError, StepExecutionError } from "../errors";
import type { StepOutputs } from "../flow/refs";
import { resolveRefs } from "../flow/refs";
import type { Flow, Network, StepEnvelope } from "../flow/schema";
import type { HashscanEntity } from "../hedera/context";
import { hashscanUrl } from "../hedera/context";
import type { StepRegistry } from "../registry/registry";
import type { AnyStepDefinition, FieldKind, PreflightContext, RunContext } from "../registry/types";

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type StepLink = { label: string; url: string };

export type StepError = { code: string; message: string; hint?: string; causeCode?: string };

export type StepRecord = {
  id: string;
  type: string;
  label?: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Params after reference resolution and schema parsing (what the executor saw). */
  input?: unknown;
  outputs?: Record<string, unknown>;
  links: StepLink[];
  error?: StepError;
};

export type RunStatus = "succeeded" | "failed";

export type RunResult = {
  flowId: string;
  network: Network;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  steps: StepRecord[];
  /** Outputs of every succeeded step, keyed by step id. */
  outputs: StepOutputs;
  error?: StepError & { stepId: string };
};

export type RunEvent =
  | { type: "flow:start"; flowId: string; network: Network; stepCount: number }
  | { type: "step:start"; step: StepRecord }
  | { type: "step:success"; step: StepRecord }
  | { type: "step:error"; step: StepRecord }
  | { type: "flow:end"; result: RunResult };

/**
 * Called with each step's input after its references resolve and it parses,
 * just before it runs. Throwing stops that step, which fails the run.
 */
export type BeforeStep = (step: StepEnvelope, input: unknown, earlier: StepOutputs) => void;

export type RunOptions = {
  registry: StepRegistry;
  ctx: RunContext;
  onEvent?: (event: RunEvent) => void;
  beforeStep?: BeforeStep;
};

/**
 * Check what a validated flow's steps will need (a compiled contract, …)
 * without sending anything. `runFlow` does this before its first step; dry
 * runs call it to catch the same problems.
 */
export async function preflightFlow(flow: Flow, registry: StepRegistry, ctx: PreflightContext): Promise<void> {
  for (const step of flow.steps) await registry.get(step.type).preflight?.(step.params, ctx);
}

/**
 * Execute a flow step by step. Validation problems throw before anything
 * runs; execution problems are captured in the returned result so callers
 * always get the full step-by-step record.
 */
export async function runFlow(document: unknown, options: RunOptions): Promise<RunResult> {
  const { registry, ctx } = options;
  const emit = options.onEvent ?? (() => undefined);
  const flow = registry.validateFlow(document);
  assertNetworkMatches(flow, ctx);
  await preflightFlow(flow, registry, ctx);

  const startedAt = new Date().toISOString();
  const steps: StepRecord[] = flow.steps.map(step => pendingRecord(step));
  const outputs: Record<string, Record<string, unknown>> = {};
  let failure: RunResult["error"] | undefined;

  emit({ type: "flow:start", flowId: flow.id, network: flow.network, stepCount: steps.length });

  for (const [index, step] of flow.steps.entries()) {
    const record = steps[index] as StepRecord;
    if (failure) {
      record.status = "skipped";
      continue;
    }

    const definition = registry.get(step.type);
    record.status = "running";
    record.startedAt = new Date().toISOString();
    const startedMs = Date.now();
    emit({ type: "step:start", step: record });

    try {
      const result = await executeStep(step, definition, outputs, ctx, options.beforeStep);
      record.input = result.input;
      record.outputs = result.outputs;
      record.links = linksFor(definition, result.outputs, flow.network);
      record.status = "succeeded";
      outputs[step.id] = result.outputs;
      finish(record, startedMs);
      ctx.log("info", `step ${step.id} succeeded`, { type: step.type, durationMs: record.durationMs });
      emit({ type: "step:success", step: record });
    } catch (error) {
      const stepError = toStepError(step, error);
      record.status = "failed";
      record.error = {
        code: stepError.code,
        message: stepError.message,
        ...(stepError.hint ? { hint: stepError.hint } : {}),
        ...(stepError.causeCode ? { causeCode: stepError.causeCode } : {}),
      };
      finish(record, startedMs);
      failure = { ...record.error, stepId: step.id };
      ctx.log("error", `step ${step.id} failed`, { type: step.type, error: stepError.message });
      emit({ type: "step:error", step: record });
    }
  }

  const result: RunResult = {
    flowId: flow.id,
    network: flow.network,
    status: failure ? "failed" : "succeeded",
    startedAt,
    finishedAt: new Date().toISOString(),
    steps,
    outputs,
    ...(failure ? { error: failure } : {}),
  };
  emit({ type: "flow:end", result });
  return result;
}

async function executeStep(
  step: StepEnvelope,
  definition: AnyStepDefinition,
  outputs: StepOutputs,
  ctx: RunContext,
  beforeStep: BeforeStep | undefined,
): Promise<{ input: unknown; outputs: Record<string, unknown> }> {
  throwIfAborted(ctx.signal);

  const resolved = resolveRefs(step.params, outputs);
  // Validation already checked literals and wiring types, so a failure here
  // is an earlier step's actual output not fitting (e.g. a null LP token id).
  const parsedInput = definition.input.safeParse(resolved);
  if (!parsedInput.success) {
    const problems = parsedInput.error.issues.map(i => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new StepExecutionError({
      stepId: step.id,
      stepType: step.type,
      message: `its input is invalid once references resolve (${problems})`,
      hint: "An earlier step produced a value this step cannot take: check what that step returned.",
    });
  }
  const input = parsedInput.data;
  beforeStep?.(step, input, outputs);
  const raw = await definition.execute(input, ctx);

  const parsedOutput = definition.output.safeParse(raw);
  if (!parsedOutput.success) {
    const problems = parsedOutput.error.issues.map(i => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new StepExecutionError({
      stepId: step.id,
      stepType: step.type,
      message: `executor returned an output that violates its own schema (${problems})`,
      hint: "This is a bug in the step definition, not in the flow.",
    });
  }
  return { input, outputs: parsedOutput.data as Record<string, unknown> };
}

function assertNetworkMatches(flow: Flow, ctx: RunContext): void {
  if (flow.network !== ctx.network) {
    throw new LaunchBlocksError(
      "NETWORK_MISMATCH",
      `Flow "${flow.id}" targets ${flow.network} but the operator context is for ${ctx.network}`,
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new LaunchBlocksError("RUN_ABORTED", "Run was cancelled before this step started");
  }
}

function toStepError(step: StepEnvelope, error: unknown): StepExecutionError {
  if (error instanceof StepExecutionError) return error;
  if (error instanceof LaunchBlocksError) {
    return new StepExecutionError({
      stepId: step.id,
      stepType: step.type,
      message: error.message,
      causeCode: error.code,
      ...(error.hint ? { hint: error.hint } : {}),
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new StepExecutionError({ stepId: step.id, stepType: step.type, message, cause: error });
}

function pendingRecord(step: StepEnvelope): StepRecord {
  return {
    id: step.id,
    type: step.type,
    ...(step.label ? { label: step.label } : {}),
    status: "pending",
    links: [],
  };
}

function finish(record: StepRecord, startedMs: number): void {
  record.finishedAt = new Date().toISOString();
  record.durationMs = Date.now() - startedMs;
}

const LINK_ENTITY_BY_KIND: Partial<Record<FieldKind, HashscanEntity>> = {
  accountId: "account",
  tokenId: "token",
  topicId: "topic",
  contractId: "contract",
  scheduleId: "schedule",
  transactionId: "transaction",
};

/** Explorer links for every output the step's UI spec marks as an on-chain entity. */
export function linksFor(
  definition: AnyStepDefinition,
  outputs: Record<string, unknown>,
  network: Network,
): StepLink[] {
  const links: StepLink[] = [];
  for (const spec of definition.ui.outputs) {
    const entity = LINK_ENTITY_BY_KIND[spec.kind];
    const value = outputs[spec.key];
    if (entity && typeof value === "string" && value) {
      links.push({ label: spec.label, url: hashscanUrl(network, entity, value) });
    }
  }
  return links;
}
