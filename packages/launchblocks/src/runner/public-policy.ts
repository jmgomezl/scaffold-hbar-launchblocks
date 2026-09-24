import type { FlowIssue } from "../errors";
import { LaunchBlocksError } from "../errors";
import type { StepOutputs } from "../flow/refs";
import type { Flow } from "../flow/schema";
import { estimateFlowFees } from "../harness/recipe";
import type { BeforeStep } from "./runner";

/**
 * Limits for a public deployment whose operator pays for anonymous visitors'
 * runs. Every gallery launch fits inside them; what they stop is a flow that
 * moves the operator's HBAR or tokens to something the visitor controls. HBAR
 * and tokens only go to tokens and contracts the same run created, never with
 * a payable amount, and at most `maxHbarPerStep` at a time.
 */
export type PublicRunLimits = {
  maxSteps: number;
  maxHbarPerStep: number;
};

export const DEFAULT_PUBLIC_RUN_LIMITS: PublicRunLimits = { maxSteps: 25, maxHbarPerStep: 25 };

/** Params that send HBAR along with a contract call or deployment. */
const PAYABLE_PARAMS = ["payableHbar", "initialHbar"] as const;

/** Steps that move value to the token or contract they name, and the params that name it. */
const TARGETS: Readonly<Record<string, readonly string[]>> = {
  "contract.call": ["contractId"],
  "saucerswap.createPool": ["tokenId"],
  "saucerswap.swap": ["tokenId"],
  "hts.transfer": ["tokenId"],
  "hts.airdrop": ["tokenId"],
  "hss.scheduleTransfer": ["tokenId"],
};

/** The outputs through which a step brings a new token or contract into existence. */
const CREATES: Readonly<Record<string, readonly string[]>> = {
  "hts.createToken": ["tokenId"],
  "contract.deploy": ["contractId"],
  "saucerswap.createPool": ["lpTokenId", "pairId"],
};

const HINT =
  "This public demo only sends value to tokens and contracts the same launch creates. Run it on your own deployment, or with your own wallet, to lift the limit.";

const isReference = (value: unknown) => typeof value === "string" && value.includes("{{");
const isViewCall = (params: Record<string, unknown>) => /\b(view|pure)\b/.test(String(params.function ?? ""));

/** What can be judged from the flow alone, before anything runs. */
export function checkPublicFlow(flow: Flow, limits: PublicRunLimits = DEFAULT_PUBLIC_RUN_LIMITS): FlowIssue[] {
  const issues: FlowIssue[] = [];
  if (flow.steps.length > limits.maxSteps) {
    issues.push({ path: "steps", message: `a public run takes at most ${limits.maxSteps} steps` });
  }
  flow.steps.forEach((step, index) => {
    const at = (key: string) => `steps[${index}].params.${key}`;
    for (const key of PAYABLE_PARAMS) {
      const value = step.params[key];
      if (value !== undefined && (isReference(value) || Number(value) > 0)) {
        issues.push({ path: at(key), stepId: step.id, message: "a public run cannot send HBAR with a contract" });
      }
    }
    const hbar = step.params.hbarAmount;
    if (hbar !== undefined && !isReference(hbar) && Number(hbar) > limits.maxHbarPerStep) {
      issues.push({
        path: at("hbarAmount"),
        stepId: step.id,
        message: `a public run moves at most ${limits.maxHbarPerStep} HBAR per step`,
      });
    }
    if (step.type === "contract.call" && isViewCall(step.params)) return;
    for (const key of TARGETS[step.type] ?? []) {
      if (step.params[key] !== undefined && !isReference(step.params[key])) {
        issues.push({
          path: at(key),
          stepId: step.id,
          message: "in a public run this must be a token or contract the launch creates: wire it from an earlier step",
        });
      }
    }
  });
  return issues;
}

/** Checks each step's resolved input just before it runs, where wired values are known. */
export function publicStepGuard(flow: Flow, limits: PublicRunLimits = DEFAULT_PUBLIC_RUN_LIMITS): BeforeStep {
  const typeOf = new Map(flow.steps.map(step => [step.id, step.type]));
  return (step, input, earlier) => {
    const params = (input ?? {}) as Record<string, unknown>;
    for (const key of PAYABLE_PARAMS) {
      if (params[key] !== undefined && Number(params[key]) > 0) {
        throw new LaunchBlocksError("PUBLIC_RUN_REFUSED", "A public run cannot send HBAR with a contract", {
          hint: HINT,
        });
      }
    }
    if (params.hbarAmount !== undefined && Number(params.hbarAmount) > limits.maxHbarPerStep) {
      throw new LaunchBlocksError(
        "PUBLIC_RUN_REFUSED",
        `This step would move ${params.hbarAmount} HBAR; a public run moves at most ${limits.maxHbarPerStep} per step`,
        { hint: HINT },
      );
    }
    if (step.type === "contract.call" && isViewCall(params)) return;
    const targets = TARGETS[step.type];
    if (!targets) return;
    const created = createdEntities(earlier, typeOf);
    for (const key of targets) {
      const id = String(params[key] ?? "");
      if (!created.has(id)) {
        throw new LaunchBlocksError(
          "PUBLIC_RUN_REFUSED",
          `${id || "This target"} was not created by this launch, so a public run will not send value to it`,
          { hint: HINT },
        );
      }
    }
  };
}

/** The most HBAR a public run could cost: fees, plus wired amounts counted at the per-step cap. */
export function publicRunHbarEstimate(flow: Flow, limits: PublicRunLimits = DEFAULT_PUBLIC_RUN_LIMITS): number {
  const estimate = estimateFlowFees(flow);
  return estimate.perRunHbar + estimate.unknownAmounts.length * limits.maxHbarPerStep;
}

function createdEntities(earlier: StepOutputs, typeOf: ReadonlyMap<string, string>): Set<string> {
  const created = new Set<string>();
  for (const [stepId, outputs] of Object.entries(earlier)) {
    for (const key of CREATES[typeOf.get(stepId) ?? ""] ?? []) {
      const value = outputs[key];
      if (typeof value === "string" && value) created.add(value);
    }
  }
  return created;
}
