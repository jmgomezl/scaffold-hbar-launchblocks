import { z } from "zod";

import { createPoolWithHbar } from "../../saucerswap/pool";
import { defineStep } from "../../registry/define-step";
import { CATEGORY_COLOUR, PositiveAmountSchema, TokenIdSchema } from "../shared";

export const saucerswapCreatePool = defineStep({
  type: "saucerswap.createPool",
  input: z.object({
    tokenId: TokenIdSchema,
    tokenAmount: PositiveAmountSchema,
    hbarAmount: PositiveAmountSchema,
    slippageBps: z.number().int().min(0).max(9999).default(100),
    deadlineSeconds: z.number().int().min(30).max(3600).default(120),
  }),
  output: z.object({
    tokenId: z.string(),
    pairId: z.string().nullable(),
    pairEvmAddress: z.string().nullable(),
    lpTokenId: z.string().nullable(),
    transactionId: z.string(),
    allowanceTransactionId: z.string(),
    tokenAmountUnits: z.string(),
    hbarAmountTinybar: z.string(),
    liquidityUnits: z.string(),
    creationFeeHbar: z.string(),
    openingPriceHbar: z.string(),
    poolUrl: z.string(),
  }),
  outputExample: {
    tokenId: "0.0.6512345",
    pairId: "0.0.6512500",
    pairEvmAddress: "0xfe7cc3ceb7b1128bfc3889184e2d5561bf74bfb3",
    lpTokenId: "0.0.6512500",
    transactionId: "0.0.4242@1758500070.000000001",
    allowanceTransactionId: "0.0.4242@1758500069.000000001",
    tokenAmountUnits: "10000000000000",
    hbarAmountTinybar: "2000000000",
    liquidityUnits: "4472135954",
    creationFeeHbar: "25.95166934",
    openingPriceHbar: "0.0002",
    poolUrl: "https://testnet.saucerswap.finance/liquidity/0.0.6512500",
  },
  ui: {
    label: "Seed SaucerSwap pool",
    category: "saucerswap",
    colour: CATEGORY_COLOUR.saucerswap,
    tooltip: "Create the token's first SaucerSwap V1 pool against HBAR. The two amounts set the opening price.",
    fields: [
      { key: "tokenId", label: "Token", kind: "tokenId" },
      { key: "tokenAmount", label: "Tokens to deposit", kind: "amount", help: "Whole tokens" },
      {
        key: "hbarAmount",
        label: "HBAR to deposit",
        kind: "amount",
        help: "Sets the opening price together with the token amount",
      },
      { key: "slippageBps", label: "Slippage (bps)", kind: "number", help: "100 = 1% tolerated shortfall" },
      { key: "deadlineSeconds", label: "Deadline (s)", kind: "number" },
    ],
    outputs: [
      { key: "pairId", label: "Pool", kind: "contractId" },
      { key: "lpTokenId", label: "LP token", kind: "tokenId" },
      { key: "transactionId", label: "Create pool transaction", kind: "transactionId" },
      { key: "openingPriceHbar", label: "Opening price (HBAR)", kind: "amount" },
      { key: "creationFeeHbar", label: "Pool creation fee (HBAR)", kind: "amount" },
    ],
  },
  docs: {
    summary: "Create the token's first SaucerSwap V1 liquidity pool against HBAR, making it tradeable.",
    details: [
      "This is the step that turns a token into a market. It does the three things that make pool creation",
      "awkward by hand, in order:",
      "",
      "1. **Prices the pool creation fee.** The factory quotes it in tinycents; the step reads the network's",
      "   live exchange rate and converts to tinybars exactly as the 0x168 precompile does, then adds it to",
      "   `msg.value` on top of the HBAR being deposited. Underpaying reverts after the gas is spent.",
      "2. **Grants the router an HTS allowance** for exactly the tokens being deposited, so the router can",
      "   pull them. Without this the call fails with a spender error.",
      "3. **Refuses to run if a pool already exists**, rather than reverting inside the router.",
      "",
      "The LP token is created during the call, so the operator needs a free auto-association slot for it.",
      "Because the deposits define the starting ratio, `tokenAmount` and `hbarAmount` set the opening price.",
    ].join("\n"),
    hederaServices: ["HTS", "SmartContract", "MirrorNode"],
    integrations: ["SaucerSwap"],
  },
  execute: (input, ctx) => createPoolWithHbar(ctx.hedera, input, ctx.signal),
  codegen: ctx => {
    ctx.addImport(ctx.coreModule, "createPoolWithHbar");
    return {
      body: [
        `return await createPoolWithHbar(ctx, {`,
        `  tokenId: ${ctx.expr("tokenId")},`,
        `  tokenAmount: ${ctx.expr("tokenAmount")},`,
        `  hbarAmount: ${ctx.expr("hbarAmount")},`,
        `  slippageBps: ${ctx.expr("slippageBps")},`,
        `  deadlineSeconds: ${ctx.expr("deadlineSeconds")},`,
        `});`,
      ].join("\n"),
    };
  },
});
