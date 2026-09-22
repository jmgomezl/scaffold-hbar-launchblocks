/**
 * Error types shared by the schema, registry, runner and codegen.
 *
 * Every error carries a stable `code` so API routes and validators can branch
 * on it without parsing messages.
 */

export type FlowIssue = {
  /** JSON-pointer-ish path into the flow document, e.g. `steps[2].params.tokenId`. */
  path: string;
  message: string;
  stepId?: string;
};

export class LaunchBlocksError extends Error {
  readonly code: string;
  /** Human-oriented remediation, surfaced verbatim in the UI and harness logs. */
  readonly hint: string | undefined;

  constructor(code: string, message: string, options?: ErrorOptions & { hint?: string }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.hint = options?.hint;
  }
}

export class FlowValidationError extends LaunchBlocksError {
  readonly issues: readonly FlowIssue[];

  constructor(issues: readonly FlowIssue[]) {
    const summary = issues.map(issue => `${issue.path}: ${issue.message}`).join("; ");
    super("FLOW_INVALID", `Flow is invalid (${issues.length} issue${issues.length === 1 ? "" : "s"}): ${summary}`);
    this.issues = issues;
  }
}

export class RefResolutionError extends LaunchBlocksError {
  readonly ref: string;

  constructor(ref: string, reason: string) {
    super("REF_UNRESOLVED", `Cannot resolve ${ref}: ${reason}`);
    this.ref = ref;
  }
}

export class UnknownStepTypeError extends LaunchBlocksError {
  readonly stepType: string;

  constructor(stepType: string) {
    super("STEP_TYPE_UNKNOWN", `No step definition registered for type "${stepType}"`);
    this.stepType = stepType;
  }
}

export class StepExecutionError extends LaunchBlocksError {
  readonly stepId: string;
  readonly stepType: string;
  /** Code of the underlying failure (e.g. HEDERA_INSUFFICIENT_PAYER_BALANCE) when there is one. */
  readonly causeCode: string | undefined;

  constructor(args: {
    stepId: string;
    stepType: string;
    message: string;
    hint?: string;
    causeCode?: string;
    cause?: unknown;
  }) {
    super("STEP_FAILED", `Step "${args.stepId}" (${args.stepType}) failed: ${args.message}`, {
      cause: args.cause,
      ...(args.hint ? { hint: args.hint } : {}),
    });
    this.stepId = args.stepId;
    this.stepType = args.stepType;
    this.causeCode = args.causeCode;
  }
}
