import type { FlowIssue } from "../errors";
import { LaunchBlocksError } from "../errors";
import type { StepOutputs } from "../flow/refs";
import type { Flow } from "../flow/schema";
import { estimateFlowFees } from "../harness/recipe";
import { DEFAULT_CALL_GAS, DEFAULT_DEPLOY_GAS, isReadOnly, parseFunctionSignature } from "../hedera/ops/contracts";
import { CREATE_PAIR_GAS, SWAP_GAS } from "../saucerswap/config";
import type { BeforeStep } from "./runner";

/**
 * Limits for a public deployment whose operator pays for anonymous visitors'
 * runs. Every gallery launch fits inside them; what they stop is a flow that
 * moves the operator's HBAR or tokens to something the visitor controls. HBAR
 * and tokens only go to tokens, contracts and accounts the same run created,
 * messages only to its own topics, never with a payable amount, at most
 * `maxHbarPerStep` at a time, and with no more gas than the defaults.
 */
export type PublicRunLimits = {
  maxSteps: number;
  maxHbarPerStep: number;
};

export const DEFAULT_PUBLIC_RUN_LIMITS: PublicRunLimits = { maxSteps: 25, maxHbarPerStep: 25 };

/** Params that send HBAR along with a contract call or deployment. */
const PAYABLE_PARAMS = ["payableHbar", "initialHbar"] as const;

/**
 * Steps that act on the token, contract or topic they name, and the params
 * that name it. A topic counts because a topic someone else created can
 * charge a custom fee (HIP-991) for every message.
 */
const TARGETS: Readonly<Record<string, readonly string[]>> = {
  "contract.call": ["contractId"],
  "saucerswap.createPool": ["tokenId"],
  "saucerswap.swap": ["tokenId"],
  "hts.transfer": ["tokenId"],
  "hts.airdrop": ["tokenId"],
  "hss.scheduleTransfer": ["tokenId"],
  "hcs.submitMessage": ["topicId"],
};

/**
 * Steps that send tokens to an account, and the params that name it. Only
 * accounts and contracts the launch created may receive: tokens sent to the
 * visitor could be sold into the launch's pool for its HBAR.
 */
const RECIPIENTS: Readonly<Record<string, readonly string[]>> = {
  "hts.transfer": ["to"],
  "hss.scheduleTransfer": ["to"],
};

/** The outputs through which a step brings a new token, contract, account or topic into existence. */
const CREATES: Readonly<Record<string, readonly string[]>> = {
  "hts.createToken": ["tokenId"],
  "hcs.createTopic": ["topicId"],
  "contract.deploy": ["contractId", "accountId"],
  "saucerswap.createPool": ["lpTokenId", "pairId"],
};

/**
 * Gas a public run may buy per step: the defaults the fee estimate was
 * measured at. Hedera charges at least 80% of the gas limit even when a call
 * reverts, so a raised limit would cost far more than the estimate says.
 */
const GAS_CAPS: Readonly<Record<string, { key: string; max: number }>> = {
  "contract.call": { key: "gas", max: DEFAULT_CALL_GAS },
  "contract.deploy": { key: "gas", max: DEFAULT_DEPLOY_GAS },
  "saucerswap.createPool": { key: "gasLimit", max: CREATE_PAIR_GAS },
  "saucerswap.swap": { key: "gasLimit", max: SWAP_GAS },
};

const HINT =
  "This public demo only sends value to tokens and contracts the same launch creates. Run it on your own deployment, or with your own wallet, to lift the limit.";

const isReference = (value: unknown) => typeof value === "string" && value.includes("{{");

/**
 * A contract read (view or pure), judged from the parsed signature as the
 * executor judges it: words like "view" elsewhere in the text do not count,
 * and a signature that does not parse counts as a write.
 */
function isReadOnlyCall(params: Record<string, unknown>): boolean {
  const signature = params.function;
  if (typeof signature !== "string" || isReference(signature)) return false;
  try {
    return isReadOnly(parseFunctionSignature(signature));
  } catch {
    return false;
  }
}

/** The account ids an airdrop names, with their param paths. */
function airdropRecipients(params: Record<string, unknown>): { path: string; value: unknown }[] {
  const recipients = params.recipients;
  if (!Array.isArray(recipients)) return [{ path: "recipients", value: recipients }];
  return recipients.map((recipient, index) => ({
    path: `recipients[${index}].accountId`,
    value: (recipient as Record<string, unknown> | null)?.accountId,
  }));
}

function recipientsOf(type: string, params: Record<string, unknown>): { path: string; value: unknown }[] {
  if (type === "hts.airdrop") return airdropRecipients(params);
  return (RECIPIENTS[type] ?? []).map(key => ({ path: key, value: params[key] }));
}

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
    const gas = GAS_CAPS[step.type];
    const gasValue = gas ? step.params[gas.key] : undefined;
    if (gas && gasValue !== undefined && (isReference(gasValue) || Number(gasValue) > gas.max)) {
      issues.push({
        path: at(gas.key),
        stepId: step.id,
        message: `a public run uses at most ${gas.max.toLocaleString("en-US")} gas here, the default`,
      });
    }
    for (const { path, value } of recipientsOf(step.type, step.params)) {
      if (!isReference(value)) {
        issues.push({
          path: at(path),
          stepId: step.id,
          message:
            "in a public run tokens only go to an account or contract the launch creates: wire it from an earlier step",
        });
      }
    }
    if (step.type === "contract.call" && isReadOnlyCall(step.params)) return;
    for (const key of TARGETS[step.type] ?? []) {
      if (step.params[key] !== undefined && !isReference(step.params[key])) {
        issues.push({
          path: at(key),
          stepId: step.id,
          message:
            "in a public run this must be a token, contract or topic the launch creates: wire it from an earlier step",
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
    const gas = GAS_CAPS[step.type];
    if (gas && params[gas.key] !== undefined && Number(params[gas.key]) > gas.max) {
      throw new LaunchBlocksError(
        "PUBLIC_RUN_REFUSED",
        `This step asks for ${params[gas.key]} gas; a public run uses at most ${gas.max}`,
        { hint: HINT },
      );
    }
    const created = createdEntities(earlier, typeOf);
    for (const { value } of recipientsOf(step.type, params)) {
      const id = String(value ?? "");
      if (!created.has(id)) {
        throw new LaunchBlocksError(
          "PUBLIC_RUN_REFUSED",
          `${id || "This recipient"} was not created by this launch, so a public run will not send tokens to it`,
          { hint: HINT },
        );
      }
    }
    if (step.type === "contract.call" && isReadOnlyCall(params)) return;
    for (const key of TARGETS[step.type] ?? []) {
      const id = String(params[key] ?? "");
      if (!created.has(id)) {
        throw new LaunchBlocksError(
          "PUBLIC_RUN_REFUSED",
          `${id || "This target"} was not created by this launch, so a public run will not act on it`,
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
