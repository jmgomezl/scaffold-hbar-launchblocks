import { z } from "zod";

import { scheduleTokenMint } from "../../hedera/ops/schedules";
import { defineStep } from "../../registry/define-step";
import { CATEGORY_COLOUR, PositiveAmountSchema, TokenIdSchema, callOperation, tokenAmountIssues } from "../shared";
import {
  SCHEDULE_DETAILS,
  scheduleFields,
  scheduleOutputExample,
  scheduleOutputShape,
  scheduleOutputs,
  scheduleShape,
} from "./shared";

export const hssScheduleMint = defineStep({
  type: "hss.scheduleMint",
  input: z.object({
    tokenId: TokenIdSchema,
    amount: PositiveAmountSchema,
    ...scheduleShape,
  }),
  output: z.object({
    ...scheduleOutputShape,
    tokenId: z.string(),
    amountUnits: z.string(),
  }),
  outputExample: {
    ...scheduleOutputExample,
    tokenId: "0.0.6512345",
    amountUnits: "10000000000000",
  },
  ui: {
    label: "Schedule a mint",
    category: "hss",
    colour: CATEGORY_COLOUR.hss,
    tooltip: "Schedule new supply that the network mints later by itself, e.g. a supply unlock on a date.",
    fields: [
      { key: "tokenId", label: "Token", kind: "tokenId" },
      { key: "amount", label: "Amount", kind: "amount", help: "Whole tokens" },
      ...scheduleFields,
    ],
    outputs: scheduleOutputs,
  },
  docs: {
    summary: "Schedule a mint into the treasury that the network runs later by itself, for a supply unlock.",
    details: `${SCHEDULE_DETAILS}\n\nThe token needs a supply key (the operator's), and must still have room under a finite max supply when it runs.`,
    hederaServices: ["HSS", "HTS"],
  },
  checkWiring: (params, earlier) => tokenAmountIssues(params, [{ path: "amount", value: params.amount }], earlier),
  execute: (input, ctx) => scheduleTokenMint(ctx.hedera, input),
  codegen: ctx => callOperation(ctx, "scheduleTokenMint", ["tokenId", "amount", "delaySeconds", "memo", "adminKey"]),
});
