import type { FlowIssue } from "../errors";
import { LaunchBlocksError } from "../errors";
import type { StepOutputs } from "../flow/refs";
import { parseRef } from "../flow/refs";
import type { Flow } from "../flow/schema";
import { estimateFlowFees } from "../harness/recipe";
import { DEFAULT_CALL_GAS, DEFAULT_DEPLOY_GAS, isReadOnly, parseFunctionSignature } from "../hedera/ops/contracts";
import { ADD_LIQUIDITY_GAS, CREATE_PAIR_GAS, DEFAULT_FEE_BUFFER_BPS, SWAP_GAS } from "../saucerswap/config";
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
  "hts.mint": ["tokenId"],
  "hss.scheduleMint": ["tokenId"],
  "hts.associate": ["tokenId"],
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
const GAS_CAPS: Readonly<Record<string, readonly { key: string; max: number }[]>> = {
  "contract.call": [{ key: "gas", max: DEFAULT_CALL_GAS }],
  "contract.deploy": [{ key: "gas", max: DEFAULT_DEPLOY_GAS }],
  "saucerswap.createPool": [
    { key: "gasLimit", max: ADD_LIQUIDITY_GAS },
    { key: "createPairGasLimit", max: CREATE_PAIR_GAS },
  ],
  "saucerswap.swap": [{ key: "gasLimit", max: SWAP_GAS }],
};

// New step types require an explicit review before they can spend the demo's funds.
const PUBLIC_STEPS = new Set([
  ...Object.keys(TARGETS),
  "hts.createToken",
  "hcs.createTopic",
  "contract.deploy",
  "pyth.priceInUsd",
]);

/** The public deployment only deploys the reviewed lock, never arbitrary constructors with onward payouts. */
function lockIssues(flow: Flow, index: number): FlowIssue[] {
  const step = flow.steps[index]!;
  const issues: FlowIssue[] = [];
  const issue = (key: string, message: string) =>
    issues.push({ path: `steps[${index}].params.${key}`, stepId: step.id, message });
  const from = (key: string, types: Record<string, readonly string[]>) => {
    const ref = parseRef(step.params[key]);
    const producer = ref && flow.steps.slice(0, index).find(candidate => candidate.id === ref.stepId);
    return !!(ref && producer && types[producer.type]?.includes(ref.key));
  };
  if (step.params.contract !== "TokenLock" && step.params.contract !== "TokenLock.sol:TokenLock") {
    issue("contract", "a public run only deploys TokenLock; use your wallet for other contracts");
  }
  if (!from("arg1", { "hts.createToken": ["tokenId"], "saucerswap.createPool": ["lpTokenId"] })) {
    issue("arg1", "wire the lock's token from a token or LP token this launch creates");
  }
  if (!from("arg2", { "hts.createToken": ["treasuryAccountId"] })) {
    issue(
      "arg2",
      "wire the lock's beneficiary from this launch's token treasury; public funds cannot go to another beneficiary",
    );
  }
  if (
    step.params.autoAssociations !== undefined &&
    (isReference(step.params.autoAssociations) ||
      Number(step.params.autoAssociations) > 1 ||
      Number(step.params.autoAssociations) < 0)
  ) {
    issue("autoAssociations", "a public lock uses at most one automatic token association");
  }
  return issues;
}

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
    if (!PUBLIC_STEPS.has(step.type))
      issues.push({
        path: `steps[${index}].type`,
        stepId: step.id,
        message: "this step has not been approved for public runs",
      });
    if (step.type === "contract.deploy") issues.push(...lockIssues(flow, index));
    if (step.type === "hts.createToken") {
      for (const key of ["fractionalFee", "fixedHbarFee"]) {
        const fee = step.params[key];
        if (isReference(fee) || (fee && typeof fee === "object" && "collectorAccountId" in fee)) {
          issues.push({
            path: at(key),
            stepId: step.id,
            message: "public token fees must use the default treasury collector",
          });
        }
      }
    }
    if (
      step.type === "saucerswap.createPool" &&
      step.params.feeBufferBps !== undefined &&
      (isReference(step.params.feeBufferBps) || Number(step.params.feeBufferBps) > DEFAULT_FEE_BUFFER_BPS)
    ) {
      issues.push({
        path: at("feeBufferBps"),
        stepId: step.id,
        message: `a public run uses at most ${DEFAULT_FEE_BUFFER_BPS} fee-buffer basis points`,
      });
    }
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
    for (const gas of GAS_CAPS[step.type] ?? []) {
      const value = step.params[gas.key];
      if (value !== undefined && (isReference(value) || Number(value) > gas.max)) {
        issues.push({
          path: at(gas.key),
          stepId: step.id,
          message: `a public run uses at most ${gas.max.toLocaleString("en-US")} gas here, the default`,
        });
      }
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
    if (step.type === "contract.call") {
      if (isReadOnlyCall(step.params)) return;
      const target = parseRef(step.params.contractId);
      const producer = target && flow.steps.slice(0, index).find(candidate => candidate.id === target.stepId);
      if (producer?.type !== "contract.deploy" || target?.key !== "contractId" || !isLockRelease(step.params)) {
        issues.push({
          path: at("function"),
          stepId: step.id,
          message: "a public contract write can only release this launch's TokenLock to its treasury",
        });
      }
    }
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
  const policyIssues = checkPublicFlow(flow, limits);
  return (step, input, earlier) => {
    const params = (input ?? {}) as Record<string, unknown>;
    if (step.type === "hts.createToken") {
      for (const key of ["fractionalFee", "fixedHbarFee"]) {
        const fee = params[key];
        if (fee && typeof fee === "object" && "collectorAccountId" in fee && fee.collectorAccountId !== undefined) {
          throw new LaunchBlocksError(
            "PUBLIC_RUN_REFUSED",
            "Public token fees must use the default treasury collector",
            { hint: HINT },
          );
        }
      }
    }
    // Evaluate the relevant new restrictions again at execution, without trusting wired values.
    if (!PUBLIC_STEPS.has(step.type))
      throw new LaunchBlocksError("PUBLIC_RUN_REFUSED", "This step has not been approved for public runs");
    if (step.type === "contract.deploy") {
      const issue = policyIssues.find(candidate => candidate.stepId === step.id);
      const treasury = parseRef(step.params.arg2);
      const beneficiary = treasury && earlier[treasury.stepId]?.[treasury.key];
      if (
        issue ||
        !beneficiary ||
        params.arg2 !== beneficiary ||
        (params.contract !== "TokenLock" && params.contract !== "TokenLock.sol:TokenLock") ||
        Number(params.autoAssociations ?? 0) > 1 ||
        Number(params.autoAssociations ?? 0) < 0
      ) {
        throw new LaunchBlocksError(
          "PUBLIC_RUN_REFUSED",
          issue?.message ?? "A public lock must pay the launch's treasury",
          { hint: HINT },
        );
      }
    }
    if (
      step.type === "saucerswap.createPool" &&
      Number(params.feeBufferBps ?? DEFAULT_FEE_BUFFER_BPS) > DEFAULT_FEE_BUFFER_BPS
    ) {
      throw new LaunchBlocksError("PUBLIC_RUN_REFUSED", "A public run cannot raise the pool creation fee buffer", {
        hint: HINT,
      });
    }
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
    for (const gas of GAS_CAPS[step.type] ?? []) {
      if (params[gas.key] !== undefined && Number(params[gas.key]) > gas.max) {
        throw new LaunchBlocksError(
          "PUBLIC_RUN_REFUSED",
          `This step asks for ${params[gas.key]} gas; a public run uses at most ${gas.max}`,
          { hint: HINT },
        );
      }
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
    if (step.type === "contract.call") {
      if (isReadOnlyCall(params)) return;
      const target = parseRef(step.params.contractId);
      if (
        !target ||
        typeOf.get(target.stepId) !== "contract.deploy" ||
        target.key !== "contractId" ||
        !isLockRelease(params)
      ) {
        throw new LaunchBlocksError(
          "PUBLIC_RUN_REFUSED",
          "A public contract write can only release this launch's TokenLock",
          { hint: HINT },
        );
      }
    }
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

/** Conservative reservation, not a network-fee guarantee: double measured fees, all allowed chunks,
 * and wired deposits counted at their cap. Actual HBAR fees depend on the network exchange rate. */
export function publicRunHbarEstimate(flow: Flow, limits: PublicRunLimits = DEFAULT_PUBLIC_RUN_LIMITS): number {
  const estimate = estimateFlowFees(flow);
  const fees = estimate.lines.reduce((sum, line, index) => {
    const step = flow.steps[index]!;
    // Wired message lengths and recipient counts are unknown until execution: reserve their maximum.
    const multiplier =
      step.type === "hcs.submitMessage"
        ? typeof step.params.maxChunks === "number"
          ? step.params.maxChunks
          : 20
        : step.type === "hts.airdrop"
          ? 10
          : 1;
    return sum + line.feeHbar * multiplier * 2;
  }, 0);
  const deposits = estimate.lines.reduce((sum, line) => sum + line.spentHbar, 0);
  return Math.ceil((fees + deposits + estimate.unknownAmounts.length * limits.maxHbarPerStep) * 100) / 100;
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

/** Only release() is a reviewed write on the public lock. Solidity selectors ignore return types. */
function isLockRelease(params: Record<string, unknown>): boolean {
  if (typeof params.function !== "string" || isReference(params.function)) return false;
  try {
    const fn = parseFunctionSignature(params.function);
    return fn.name === "release" && fn.inputs.length === 0;
  } catch {
    return false;
  }
}
