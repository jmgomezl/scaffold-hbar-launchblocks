import { z } from "zod";

import { LaunchBlocksError } from "../../errors";
import { SCHEDULED_RUN_GAS, lockRunHbar, vestingRunHbar } from "../../hedera/ops/self-scheduling";
import type { CodegenContext, CodegenFragment, FieldSpec, OutputSpec, RunContext } from "../../registry/types";

/** Shared by the two blocks whose contracts book their own runs (HIP-1215). */

/** Steps whose contract books its own runs, paid from HBAR parked in it until the last run. */
export const SELF_SCHEDULING_STEPS: ReadonlySet<string> = new Set(["hss.selfReleasingLock", "hss.vesting"]);

/**
 * The HBAR a self-scheduling step will park, from its params as written: `runHbar`, or what its
 * schedule needs when that is left empty. Null when a value it depends on is wired from another step.
 */
export function plannedRunHbar(type: string, params: Readonly<Record<string, unknown>>): number | null {
  const literal = (key: string) =>
    typeof params[key] === "string" && String(params[key]).includes("{{") ? NaN : Number(params[key]);
  if (params.runHbar !== undefined) {
    const runHbar = literal("runHbar");
    return Number.isFinite(runHbar) ? runHbar : null;
  }
  const needed =
    type === "hss.vesting"
      ? vestingRunHbar(literal("startInSeconds"), literal("intervalSeconds"), literal("tranches"))
      : lockRunHbar(literal("lockSeconds"));
  return Number.isFinite(needed) ? needed : null;
}

export const scheduledGasSchema = z.number().int().min(100_000).max(15_000_000).default(SCHEDULED_RUN_GAS);

export const fundingFields: FieldSpec[] = [
  {
    key: "runHbar",
    label: "HBAR for the runs",
    kind: "amount",
    advanced: true,
    help: "Parked in the contract to pay the network's runs; leave empty for what the schedule needs. The rest comes back after the last run",
  },
  {
    key: "scheduledGas",
    label: "Gas per run",
    kind: "number",
    advanced: true,
    help: "A run that books the next one spends about 1.41M on the booking; runs pay for the gas they use",
  },
];

export const selfSchedulingOutputShape = {
  contractId: z.string(),
  accountId: z.string(),
  evmAddress: z.string(),
  scheduleId: z.string(),
  nextRunAt: z.string(),
  amountUnits: z.string(),
  runHbar: z.string(),
  deployTransactionId: z.string(),
  armTransactionId: z.string(),
  fundTransactionId: z.string(),
};

export const selfSchedulingOutputs: OutputSpec[] = [
  { key: "contractId", label: "Contract", kind: "contractId" },
  { key: "accountId", label: "Contract as account", kind: "accountId" },
  { key: "scheduleId", label: "Next scheduled run", kind: "scheduleId" },
  { key: "nextRunAt", label: "Runs at", kind: "text" },
  { key: "armTransactionId", label: "Arm transaction", kind: "transactionId" },
];

export const SELF_SCHEDULING_DETAILS = [
  "Three transactions: the contract is deployed, `arm()` books its first run with the Schedule Service",
  "system contract at `0x16b` (HIP-1215) and parks HBAR in it to pay for the runs, and the tokens move in.",
  "From then on the network calls the contract at each booked second with nobody online, and each run",
  "that has more to do books the next one. No keeper bot, no server, no cron.",
  "",
  "The contract has no owner and nothing changes after deployment: the tokens only go to the",
  "beneficiary, and the HBAR left after the last run goes back to the account that ran the flow.",
  "A booking can be at most 60 days ahead, so longer waits hop. If a run ever fails, anyone can call",
  "`release()` once a payment is due. An operator with an ECDSA account deploys the contract as an",
  "Ethereum transaction, which costs gas only (about 1 HBAR); otherwise ContractCreate costs about 15.",
].join("\n");

/** The compiled contract, or a clear refusal when this run has no way to load it. */
export async function loadContract(ctx: Pick<RunContext, "artifacts">, name: string) {
  if (!ctx.artifacts) {
    throw new LaunchBlocksError("CONTRACT_ARTIFACTS_UNAVAILABLE", "This run has no way to load compiled contracts", {
      hint: "Run the flow from the Launch Studio or core:run, which read the Hardhat package's artifacts.",
    });
  }
  return ctx.artifacts(name);
}

/** `return await <fn>(ctx, { artifact: loadHardhatArtifact(<contract>), ...params });` */
export function selfSchedulingCodegen(
  ctx: CodegenContext,
  fn: string,
  contract: string,
  keys: readonly string[],
): CodegenFragment {
  ctx.addImport(ctx.coreModule, fn, "loadHardhatArtifact");
  const entries = keys.map(key => `${key}: ${ctx.expr(key)}`).filter(entry => !entry.endsWith(": undefined"));
  return {
    body: [
      `return await ${fn}(ctx, {`,
      `  artifact: loadHardhatArtifact(${JSON.stringify(contract)}),`,
      ...entries.map(entry => `  ${entry},`),
      `});`,
    ].join("\n"),
  };
}
