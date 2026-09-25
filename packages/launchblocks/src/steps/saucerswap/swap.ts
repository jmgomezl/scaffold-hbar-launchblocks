import { z } from "zod";

import { defineStep } from "../../registry/define-step";
import { swapHbarForTokens } from "../../saucerswap/swap";
import { CATEGORY_COLOUR, PositiveAmountSchema, TokenIdSchema } from "../shared";

export const saucerswapSwap = defineStep({
  type: "saucerswap.swap",
  input: z.object({
    tokenId: TokenIdSchema,
    hbarAmount: PositiveAmountSchema,
    slippageBps: z.number().int().min(0).max(9999).default(100),
    deadlineSeconds: z.number().int().min(30).max(3600).default(120),
    gasLimit: z.number().int().min(500_000).max(15_000_000).optional(),
  }),
  output: z.object({
    tokenId: z.string(),
    transactionId: z.string(),
    hbarInTinybar: z.string(),
    tokensOutUnits: z.string(),
    tokensOut: z.string(),
    quotedUnits: z.string(),
    effectivePriceHbar: z.string(),
  }),
  outputExample: {
    tokenId: "0.0.6512345",
    transactionId: "0.0.4242@1758500080.000000001",
    hbarInTinybar: "100000000",
    tokensOutUnits: "453305446940",
    tokensOut: "4533.0544694",
    quotedUnits: "453305446940",
    effectivePriceHbar: "0.0002206",
  },
  ui: {
    label: "Buy with HBAR on SaucerSwap",
    category: "saucerswap",
    colour: CATEGORY_COLOUR.saucerswap,
    tooltip: "Swap HBAR for the token through its SaucerSwap V1 pool: the first trade proves the market works.",
    fields: [
      { key: "tokenId", label: "Token", kind: "tokenId" },
      { key: "hbarAmount", label: "HBAR to spend", kind: "amount" },
      {
        key: "slippageBps",
        label: "Slippage (bps)",
        kind: "number",
        help: "Tolerated shortfall against the live quote",
        advanced: true,
      },
      { key: "deadlineSeconds", label: "Deadline (s)", kind: "number", advanced: true },
      { key: "gasLimit", label: "Gas limit", kind: "number", help: "Defaults to 2,000,000", advanced: true },
    ],
    outputs: [
      { key: "transactionId", label: "Swap transaction", kind: "transactionId" },
      { key: "tokensOut", label: "Tokens received", kind: "amount" },
      { key: "effectivePriceHbar", label: "Price paid (HBAR)", kind: "amount" },
    ],
  },
  docs: {
    summary: "Buy the token with HBAR through its SaucerSwap V1 pool, proving the market is live.",
    details: [
      "Quotes the trade with the router's own `getAmountsOut` (a free mirror-node call, the same maths the",
      "swap uses), applies the slippage tolerance to that quote as `amountOutMin`, then calls",
      "`swapExactETHForTokens` with the path WHBAR → token. Tokens go to the operator's EVM alias for the",
      "same reason as pool creation: alias-created accounts reject the long-zero address.",
      "",
      "Tokens with custom fees need the fee-on-transfer variant of the swap; this step is for plain tokens.",
    ].join("\n"),
    hederaServices: ["HTS", "SmartContract", "MirrorNode"],
    integrations: ["SaucerSwap"],
  },
  execute: (input, ctx) => swapHbarForTokens(ctx.hedera, input, ctx.signal),
  codegen: ctx => {
    ctx.addImport(ctx.coreModule, "swapHbarForTokens");
    return {
      body: [
        `return await swapHbarForTokens(ctx, {`,
        `  tokenId: ${ctx.expr("tokenId")},`,
        `  hbarAmount: ${ctx.expr("hbarAmount")},`,
        `  slippageBps: ${ctx.expr("slippageBps")},`,
        `  deadlineSeconds: ${ctx.expr("deadlineSeconds")},`,
        `  gasLimit: ${ctx.expr("gasLimit")},`,
        `});`,
      ].join("\n"),
    };
  },
});
