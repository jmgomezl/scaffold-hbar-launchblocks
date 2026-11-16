import { z } from "zod";

import { createVestingSchedule, vestingRunHbar } from "../../hedera/ops/self-scheduling";
import { defineStep } from "../../registry/define-step";
import {
  AccountIdSchema,
  CATEGORY_COLOUR,
  PositiveAmountSchema,
  PositiveHbarAmountSchema,
  TokenIdSchema,
  tokenAmountIssues,
} from "../shared";
import {
  SELF_SCHEDULING_DETAILS,
  fundingFields,
  loadContract,
  scheduledGasSchema,
  selfSchedulingCodegen,
  selfSchedulingOutputShape,
  selfSchedulingOutputs,
} from "./self-scheduling";

/** VestingSchedule's own limits: 1 to 120 tranches, at least a minute apart. */
export const MAX_TRANCHES = 120;
export const MIN_TRANCHE_INTERVAL_SECONDS = 60;
/** Ten years to the first tranche or between two. */
const MAX_WAIT_SECONDS = 3650 * 24 * 60 * 60;

export const hssVesting = defineStep({
  type: "hss.vesting",
  input: z
    .object({
      tokenId: TokenIdSchema,
      amount: PositiveAmountSchema,
      beneficiary: AccountIdSchema,
      startInSeconds: z
        .number()
        .int()
        .min(60, "start at least a minute from now, so the tokens arrive first")
        .max(MAX_WAIT_SECONDS),
      intervalSeconds: z
        .number()
        .int()
        .min(MIN_TRANCHE_INTERVAL_SECONDS, "tranches are at least a minute apart")
        .max(MAX_WAIT_SECONDS),
      tranches: z.number().int().min(1).max(MAX_TRANCHES, `at most ${MAX_TRANCHES} tranches`),
      runHbar: PositiveHbarAmountSchema.optional(),
      scheduledGas: scheduledGasSchema,
    })
    .superRefine((input, ctx) => {
      const needed = vestingRunHbar(input.startInSeconds, input.intervalSeconds, input.tranches);
      if (input.runHbar !== undefined && Number(input.runHbar) < needed) {
        ctx.addIssue({
          code: "custom",
          path: ["runHbar"],
          message: `the network's runs for this vesting need about ${needed} HBAR; leave it empty to send that`,
        });
      }
    }),
  output: z.object({ ...selfSchedulingOutputShape, firstTrancheAt: z.string(), tranches: z.number().int() }),
  outputExample: {
    contractId: "0.0.6512620",
    accountId: "0.0.6512620",
    evmAddress: "0x8b9a0f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8",
    scheduleId: "0.0.6512623",
    nextRunAt: "2026-11-21T15:20:33.000Z",
    amountUnits: "10000000000000",
    runHbar: "21.1",
    deployTransactionId: "0.0.4242@1792685100.000000001",
    armTransactionId: "0.0.4242@1792685104.000000002",
    fundTransactionId: "0.0.4242@1792685108.000000003",
    firstTrancheAt: "2026-11-21T15:20:33.000Z",
    tranches: 12,
  },
  ui: {
    label: "Vest tokens, paid by the network",
    category: "hss",
    colour: CATEGORY_COLOUR.hss,
    tooltip:
      "Vest tokens to a team or treasury account in equal tranches that the network pays on time by itself: each payment books the next, with no bot or server.",
    fields: [
      { key: "tokenId", label: "Token", kind: "tokenId" },
      {
        key: "amount",
        label: "Amount in all",
        kind: "amount",
        help: "In tokens, not smallest units: 1.5 is one and a half",
      },
      { key: "beneficiary", label: "Paid to", kind: "accountId" },
      {
        key: "startInSeconds",
        label: "First tranche in (seconds)",
        kind: "number",
        help: "3600 = 1 hour, 86400 = 1 day, 2592000 = 30 days",
      },
      {
        key: "intervalSeconds",
        label: "Then every (seconds)",
        kind: "number",
        help: "At least 60; 2592000 = 30 days",
      },
      { key: "tranches", label: "Tranches", kind: "number", help: `1 to ${MAX_TRANCHES}, equal in size` },
      ...fundingFields,
    ],
    outputs: [...selfSchedulingOutputs, { key: "firstTrancheAt", label: "First tranche at", kind: "text" }],
  },
  docs: {
    summary: "Vest tokens in equal tranches that the network pays by itself (HIP-1215), with no keeper.",
    details: [
      "Deploys `VestingSchedule` from `packages/hardhat/contracts`, which pays the tokens it holds to the",
      "beneficiary in `tranches` equal parts, the first `startInSeconds` from now and then every",
      "`intervalSeconds`. A late run pays every tranche due by then.",
      "",
      SELF_SCHEDULING_DETAILS,
      "",
      "`runHbar` defaults to about 0.2 HBAR per tranche plus 1.7 for each booking a run makes (every",
      "tranche but the last, and a hop for every 60 days of a long wait): 21.1 HBAR for 12 monthly",
      "tranches. The contract has one automatic association slot, for the token it vests.",
    ].join("\n"),
    hederaServices: ["HSS", "SmartContract", "HTS", "MirrorNode"],
  },
  preflight: async (_params, ctx) => {
    if (ctx.artifacts) await ctx.artifacts("VestingSchedule");
  },
  checkWiring: (params, earlier) => tokenAmountIssues(params, [{ path: "amount", value: params.amount }], earlier),
  execute: async (input, ctx) =>
    createVestingSchedule(
      ctx.hedera,
      {
        artifact: await loadContract(ctx, "VestingSchedule"),
        tokenId: input.tokenId,
        amount: input.amount,
        beneficiary: input.beneficiary,
        startInSeconds: input.startInSeconds,
        intervalSeconds: input.intervalSeconds,
        tranches: input.tranches,
        runHbar: input.runHbar,
        scheduledGas: input.scheduledGas,
      },
      ctx.signal,
    ),
  codegen: ctx =>
    selfSchedulingCodegen(ctx, "createVestingSchedule", "VestingSchedule", [
      "tokenId",
      "amount",
      "beneficiary",
      "startInSeconds",
      "intervalSeconds",
      "tranches",
      "runHbar",
      "scheduledGas",
    ]),
});
