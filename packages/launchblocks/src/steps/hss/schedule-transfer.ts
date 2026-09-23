import { z } from "zod";

import { scheduleTokenTransfer } from "../../hedera/ops/schedules";
import { defineStep } from "../../registry/define-step";
import { AccountIdSchema, CATEGORY_COLOUR, PositiveAmountSchema, TokenIdSchema, callOperation } from "../shared";
import {
  SCHEDULE_DETAILS,
  scheduleFields,
  scheduleOutputExample,
  scheduleOutputShape,
  scheduleOutputs,
  scheduleShape,
} from "./shared";

export const hssScheduleTransfer = defineStep({
  type: "hss.scheduleTransfer",
  input: z.object({
    tokenId: TokenIdSchema,
    to: AccountIdSchema,
    amount: PositiveAmountSchema,
    ...scheduleShape,
  }),
  output: z.object({
    ...scheduleOutputShape,
    tokenId: z.string(),
    to: z.string(),
    amountUnits: z.string(),
  }),
  outputExample: {
    ...scheduleOutputExample,
    tokenId: "0.0.6512345",
    to: "0.0.7777",
    amountUnits: "10000000000000",
  },
  ui: {
    label: "Schedule token transfer",
    category: "hss",
    colour: CATEGORY_COLOUR.hss,
    tooltip: "Schedule a transfer from the treasury that the network runs later by itself, e.g. a vesting unlock.",
    fields: [
      { key: "tokenId", label: "Token", kind: "tokenId" },
      { key: "to", label: "To account", kind: "accountId" },
      { key: "amount", label: "Amount", kind: "amount", help: "Whole tokens" },
      ...scheduleFields,
    ],
    outputs: scheduleOutputs,
  },
  docs: {
    summary: "Schedule a token transfer from the treasury that the network runs later by itself, for vesting.",
    details: `${SCHEDULE_DETAILS}\n\nThe recipient must be associated with the token, or have a free association slot, when it runs.`,
    hederaServices: ["HSS", "HTS"],
  },
  execute: (input, ctx) => scheduleTokenTransfer(ctx.hedera, input),
  codegen: ctx =>
    callOperation(ctx, "scheduleTokenTransfer", ["tokenId", "to", "amount", "delaySeconds", "memo", "adminKey"]),
});
