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
    gasLimit: z.number().int().min(1_000_000).max(15_000_000).optional(),
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
    gasUsed: z.number().int(),
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
    gasUsed: 6788255,
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
      {
        key: "gasLimit",
        label: "Gas limit",
        kind: "number",
        help: "Defaults to 5,000,000; the association path is gas-hungry",
      },
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
      "This is the step that turns a token into a market. Because the deposits define the starting ratio,",
      "`tokenAmount` and `hbarAmount` set the opening price. It calls the router's `addLiquidityETHNewPool`,",
      "which deploys the pair, mints its LP token and deposits both sides in one transaction.",
      "",
      "What it handles that is easy to get wrong:",
      "",
      "- **LP recipient = the operator's EVM alias.** Passing `AccountId.toSolidityAddress()` (the",
      "  long-zero form) fails for alias-created ECDSA accounts with INVALID_ALIAS_KEY on the final",
      "  transfer, after the pair is already created and funded; the router only says",
      '  "Safe token transfer failed!". The alias is read from the mirror node.',
      "- **Creation fee in tinycents**, converted with the live exchange rate exactly as the 0x168",
      "  precompile does and added to `msg.value` on top of the deposit.",
      "- **Gas**: the documented 3,200,000 is not enough; a measured run used 6,788,255.",
      "- **Allowance** for the router, granted on the token's ERC-20 facade.",
      "- **Existing pools** are refused up front instead of reverting inside the router.",
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
        `  gasLimit: ${ctx.expr("gasLimit")},`,
        `});`,
      ].join("\n"),
    };
  },
});
