import { z } from "zod";

import { transferFungibleToken } from "../../hedera/ops/tokens";
import { defineStep } from "../../registry/define-step";
import {
  AccountIdSchema,
  CATEGORY_COLOUR,
  MemoSchema,
  PositiveAmountSchema,
  TokenIdSchema,
  callOperation,
  tokenAmountIssues,
} from "../shared";

export const htsTransfer = defineStep({
  type: "hts.transfer",
  input: z.object({
    tokenId: TokenIdSchema,
    to: AccountIdSchema,
    amount: PositiveAmountSchema,
    memo: MemoSchema.optional(),
  }),
  output: z.object({
    tokenId: z.string(),
    to: z.string(),
    amountUnits: z.string(),
    transactionId: z.string(),
  }),
  outputExample: {
    tokenId: "0.0.6512345",
    to: "0.0.7777",
    amountUnits: "10000000000",
    transactionId: "0.0.4242@1758500020.000000001",
  },
  ui: {
    label: "Transfer tokens",
    category: "hts",
    colour: CATEGORY_COLOUR.hts,
    tooltip: "Send tokens from the treasury to an account that already holds the token.",
    fields: [
      { key: "tokenId", label: "Token", kind: "tokenId" },
      { key: "to", label: "To account", kind: "accountId" },
      { key: "amount", label: "Amount", kind: "amount", help: "In tokens, not smallest units: 1.5 is one and a half" },
      { key: "memo", label: "Memo", kind: "text" },
    ],
    outputs: [
      { key: "to", label: "Recipient", kind: "accountId" },
      { key: "transactionId", label: "Transfer transaction", kind: "transactionId" },
    ],
  },
  docs: {
    summary: "Transfer tokens from the treasury to an associated account.",
    details:
      "Fails with TOKEN_NOT_ASSOCIATED_TO_ACCOUNT if the recipient has not associated; use hts.airdrop for cold recipients.",
    hederaServices: ["HTS"],
  },
  checkWiring: (params, earlier) => tokenAmountIssues(params, [{ path: "amount", value: params.amount }], earlier),
  execute: (input, ctx) => transferFungibleToken(ctx.hedera, input),
  codegen: ctx => callOperation(ctx, "transferFungibleToken", ["tokenId", "to", "amount", "memo"]),
});
