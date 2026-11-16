import { z } from "zod";

import { createSelfReleasingLock, lockRunHbar } from "../../hedera/ops/self-scheduling";
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

/** Two years: each 60 days beyond the first costs a hop run, paid from the HBAR parked in the lock. */
export const MAX_LOCK_SECONDS = 730 * 24 * 60 * 60;

export const hssSelfReleasingLock = defineStep({
  type: "hss.selfReleasingLock",
  input: z
    .object({
      tokenId: TokenIdSchema,
      amount: PositiveAmountSchema,
      beneficiary: AccountIdSchema,
      lockSeconds: z
        .number()
        .int()
        .min(60, "lock for at least a minute")
        .max(MAX_LOCK_SECONDS, "lock for at most two years (63072000 seconds)"),
      runHbar: PositiveHbarAmountSchema.optional(),
      scheduledGas: scheduledGasSchema,
    })
    .superRefine((input, ctx) => {
      const needed = lockRunHbar(input.lockSeconds);
      if (input.runHbar !== undefined && Number(input.runHbar) < needed) {
        ctx.addIssue({
          code: "custom",
          path: ["runHbar"],
          message: `the network's runs for this lock need about ${needed} HBAR; leave it empty to send that`,
        });
      }
    }),
  output: z.object({ ...selfSchedulingOutputShape, releaseAt: z.string() }),
  outputExample: {
    contractId: "0.0.6512610",
    accountId: "0.0.6512610",
    evmAddress: "0x5fd8e0a1d2c3b4a5968778695a4b3c2d1e0f9a8b",
    scheduleId: "0.0.6512613",
    nextRunAt: "2026-11-21T15:20:33.000Z",
    amountUnits: "70710678118",
    runHbar: "0.2",
    deployTransactionId: "0.0.4242@1792685000.000000001",
    armTransactionId: "0.0.4242@1792685004.000000002",
    fundTransactionId: "0.0.4242@1792685008.000000003",
    releaseAt: "2026-11-21T15:20:33.000Z",
  },
  ui: {
    label: "Lock tokens, released by the network",
    category: "hss",
    colour: CATEGORY_COLOUR.hss,
    tooltip:
      "Lock tokens, such as a pool's LP tokens, in a contract that books its own release: the network pays them to the beneficiary on time, with no bot or server.",
    fields: [
      { key: "tokenId", label: "Token", kind: "tokenId", help: "A token or LP token" },
      { key: "amount", label: "Amount", kind: "amount", help: "In tokens, not smallest units: 1.5 is one and a half" },
      { key: "beneficiary", label: "Released to", kind: "accountId" },
      {
        key: "lockSeconds",
        label: "Locked for (seconds)",
        kind: "number",
        help: "3600 = 1 hour, 86400 = 1 day, 2592000 = 30 days; at most two years",
      },
      ...fundingFields,
    ],
    outputs: [...selfSchedulingOutputs, { key: "releaseAt", label: "Released at", kind: "text" }],
  },
  docs: {
    summary: "Lock tokens in a contract the network releases on time by itself (HIP-1215), with no keeper.",
    details: [
      "Deploys `SelfReleasingLock` from `packages/hardhat/contracts`, which holds the tokens until",
      "`lockSeconds` from now and then pays everything it holds to the beneficiary.",
      "",
      SELF_SCHEDULING_DETAILS,
      "",
      "`runHbar` defaults to about 0.2 HBAR for the release run, plus 1.7 for every 60 days beyond the",
      "first. The lock has one automatic association slot, for the token it holds.",
    ].join("\n"),
    hederaServices: ["HSS", "SmartContract", "HTS", "MirrorNode"],
  },
  preflight: async (_params, ctx) => {
    if (ctx.artifacts) await ctx.artifacts("SelfReleasingLock");
  },
  checkWiring: (params, earlier) => tokenAmountIssues(params, [{ path: "amount", value: params.amount }], earlier),
  execute: async (input, ctx) =>
    createSelfReleasingLock(
      ctx.hedera,
      {
        artifact: await loadContract(ctx, "SelfReleasingLock"),
        tokenId: input.tokenId,
        amount: input.amount,
        beneficiary: input.beneficiary,
        lockSeconds: input.lockSeconds,
        runHbar: input.runHbar,
        scheduledGas: input.scheduledGas,
      },
      ctx.signal,
    ),
  codegen: ctx =>
    selfSchedulingCodegen(ctx, "createSelfReleasingLock", "SelfReleasingLock", [
      "tokenId",
      "amount",
      "beneficiary",
      "lockSeconds",
      "runHbar",
      "scheduledGas",
    ]),
});
