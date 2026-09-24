import { z } from "zod";

import { burnFungibleToken } from "../../hedera/ops/tokens";
import { defineStep } from "../../registry/define-step";
import { CATEGORY_COLOUR, PositiveAmountSchema, TokenIdSchema, callOperation } from "../shared";

export const htsBurn = defineStep({
  type: "hts.burn",
  input: z.object({
    tokenId: TokenIdSchema,
    amount: PositiveAmountSchema,
  }),
  output: z.object({
    tokenId: z.string(),
    transactionId: z.string(),
    burnedUnits: z.string(),
    newTotalSupplyUnits: z.string(),
    newTotalSupply: z.string(),
  }),
  outputExample: {
    tokenId: "0.0.6512345",
    transactionId: "0.0.4242@1758500010.000000001",
    burnedUnits: "10000000000000",
    newTotalSupplyUnits: "90000000000000",
    newTotalSupply: "900000",
  },
  ui: {
    label: "Burn tokens",
    category: "hts",
    colour: CATEGORY_COLOUR.hts,
    tooltip: "Burn supply from the treasury. The token needs a supply key.",
    fields: [
      { key: "tokenId", label: "Token", kind: "tokenId" },
      { key: "amount", label: "Amount", kind: "amount", help: "Whole tokens" },
    ],
    outputs: [
      { key: "tokenId", label: "Token", kind: "tokenId" },
      { key: "transactionId", label: "Burn transaction", kind: "transactionId" },
      { key: "newTotalSupply", label: "New total supply", kind: "amount" },
    ],
  },
  docs: {
    summary: "Burn supply from the treasury (requires the supply key).",
    hederaServices: ["HTS"],
  },
  execute: (input, ctx) => burnFungibleToken(ctx.hedera, input),
  codegen: ctx => callOperation(ctx, "burnFungibleToken", ["tokenId", "amount"]),
});
