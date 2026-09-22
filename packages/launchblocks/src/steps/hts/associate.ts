import { z } from "zod";

import { associateOperator } from "../../hedera/ops/tokens";
import { defineStep } from "../../registry/define-step";
import { CATEGORY_COLOUR, TokenIdSchema } from "../shared";

export const htsAssociate = defineStep({
  type: "hts.associate",
  input: z.object({ tokenId: TokenIdSchema }),
  output: z.object({
    tokenId: z.string(),
    accountId: z.string(),
    transactionId: z.string().nullable(),
    alreadyAssociated: z.boolean(),
  }),
  outputExample: {
    tokenId: "0.0.15058",
    accountId: "0.0.4242",
    transactionId: "0.0.4242@1758500040.000000001",
    alreadyAssociated: false,
  },
  ui: {
    label: "Associate token",
    category: "hts",
    colour: CATEGORY_COLOUR.hts,
    tooltip: "Let the operator account hold a token it did not create (e.g. WHBAR).",
    fields: [{ key: "tokenId", label: "Token", kind: "tokenId" }],
    outputs: [
      { key: "accountId", label: "Account", kind: "accountId" },
      { key: "transactionId", label: "Associate transaction", kind: "transactionId" },
    ],
  },
  docs: {
    summary: "Associate the operator with an existing token; a no-op if already associated.",
    hederaServices: ["HTS"],
  },
  execute: (input, ctx) => associateOperator(ctx.hedera, input.tokenId),
  codegen: ctx => {
    ctx.addImport(ctx.coreModule, "associateOperator");
    return { body: `return await associateOperator(ctx, ${ctx.expr("tokenId")});` };
  },
});
