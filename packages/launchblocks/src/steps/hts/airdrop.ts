import { z } from "zod";

import { airdropFungibleToken } from "../../hedera/ops/tokens";
import { defineStep } from "../../registry/define-step";
import {
  AccountIdSchema,
  CATEGORY_COLOUR,
  MemoSchema,
  PositiveAmountSchema,
  TokenIdSchema,
  callOperation,
} from "../shared";

export const htsAirdrop = defineStep({
  type: "hts.airdrop",
  input: z.object({
    tokenId: TokenIdSchema,
    recipients: z
      .array(z.object({ accountId: AccountIdSchema, amount: PositiveAmountSchema }))
      .min(1, "add at least one recipient")
      .max(10, "at most 10 recipients per airdrop"),
    memo: MemoSchema.optional(),
  }),
  output: z.object({
    tokenId: z.string(),
    transactionId: z.string(),
    recipientCount: z.number().int(),
    totalUnits: z.string(),
    pendingCount: z.number().int(),
  }),
  outputExample: {
    tokenId: "0.0.6512345",
    transactionId: "0.0.4242@1758500030.000000001",
    recipientCount: 2,
    totalUnits: "30000000000",
    pendingCount: 1,
  },
  ui: {
    label: "Airdrop tokens",
    category: "hts",
    colour: CATEGORY_COLOUR.hts,
    tooltip: "Send tokens to up to 10 accounts; no prior association needed (HIP-904).",
    fields: [
      { key: "tokenId", label: "Token", kind: "tokenId" },
      { key: "recipients", label: "Recipients", kind: "json", help: '[{ "accountId": "0.0.x", "amount": "100" }]' },
      { key: "memo", label: "Memo", kind: "text" },
    ],
    outputs: [
      { key: "transactionId", label: "Airdrop transaction", kind: "transactionId" },
      { key: "recipientCount", label: "Recipients", kind: "number" },
      { key: "pendingCount", label: "Pending claims", kind: "number" },
    ],
  },
  docs: {
    summary: "Airdrop tokens to early supporters without requiring association (HIP-904).",
    details:
      "Recipients with a free auto-association slot receive the tokens immediately; the rest get a pending airdrop they claim from their wallet.",
    hederaServices: ["HTS"],
  },
  execute: (input, ctx) => airdropFungibleToken(ctx.hedera, input),
  codegen: ctx => callOperation(ctx, "airdropFungibleToken", ["tokenId", "recipients", "memo"]),
});
