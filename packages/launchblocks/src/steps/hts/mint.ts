import { z } from "zod";

import { mintFungibleToken } from "../../hedera/ops/tokens";
import { defineStep } from "../../registry/define-step";
import { CATEGORY_COLOUR, PositiveAmountSchema, TokenIdSchema, callOperation } from "../shared";

export const htsMint = defineStep({
  type: "hts.mint",
  input: z.object({
    tokenId: TokenIdSchema,
    amount: PositiveAmountSchema,
  }),
  output: z.object({
    tokenId: z.string(),
    transactionId: z.string(),
    mintedUnits: z.string(),
    newTotalSupplyUnits: z.string(),
    newTotalSupply: z.string(),
  }),
  outputExample: {
    tokenId: "0.0.6512345",
    transactionId: "0.0.4242@1758500010.000000001",
    mintedUnits: "50000000000000",
    newTotalSupplyUnits: "150000000000000",
    newTotalSupply: "1500000",
  },
  ui: {
    label: "Mint tokens",
    category: "hts",
    colour: CATEGORY_COLOUR.hts,
    tooltip: "Mint more supply into the treasury. The token needs a supply key.",
    fields: [
      { key: "tokenId", label: "Token", kind: "tokenId" },
      { key: "amount", label: "Amount", kind: "amount", help: "Whole tokens" },
    ],
    outputs: [
      { key: "tokenId", label: "Token", kind: "tokenId" },
      { key: "transactionId", label: "Mint transaction", kind: "transactionId" },
      { key: "newTotalSupply", label: "New total supply", kind: "amount" },
    ],
  },
  docs: {
    summary: "Mint additional supply into the treasury (requires the supply key).",
    hederaServices: ["HTS"],
  },
  execute: (input, ctx) => mintFungibleToken(ctx.hedera, input),
  codegen: ctx => callOperation(ctx, "mintFungibleToken", ["tokenId", "amount"]),
});
