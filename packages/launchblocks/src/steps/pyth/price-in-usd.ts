import { z } from "zod";

import { DEFAULT_MAX_CONFIDENCE_BPS, DEFAULT_MAX_PRICE_AGE_SECONDS, priceInUsd } from "../../pyth/price";
import { defineStep } from "../../registry/define-step";
import { CATEGORY_COLOUR, PositiveAmountSchema, callOperation } from "../shared";

export const pythPriceInUsd = defineStep({
  type: "pyth.priceInUsd",
  input: z.object({
    tokenAmount: PositiveAmountSchema,
    tokenPriceUsd: PositiveAmountSchema,
    maxAgeSeconds: z.number().int().min(0).max(31_536_000).default(DEFAULT_MAX_PRICE_AGE_SECONDS),
    maxConfidenceBps: z.number().int().min(1).max(10_000).default(DEFAULT_MAX_CONFIDENCE_BPS),
  }),
  output: z.object({
    tokenAmount: z.string(),
    tokenPriceUsd: z.string(),
    hbarAmount: z.string(),
    usdValue: z.string(),
    hbarUsd: z.string(),
    confidenceUsd: z.string(),
    publishTime: z.string(),
    priceAgeSeconds: z.number(),
    source: z.enum(["posted", "on-chain"]),
    pythContractId: z.string(),
    updateTransactionId: z.string(),
  }),
  outputExample: {
    tokenAmount: "50000",
    tokenPriceUsd: "0.00002",
    hbarAmount: "12.41464762",
    usdValue: "1",
    hbarUsd: "0.08055",
    confidenceUsd: "0.000055",
    publishTime: "2026-09-24T16:30:05.000Z",
    priceAgeSeconds: 3,
    source: "posted",
    pythContractId: "0.0.3042133",
    updateTransactionId: "0.0.4242@1758500005.000000001",
  },
  ui: {
    label: "Price in USD with Pyth",
    category: "oracle",
    colour: CATEGORY_COLOUR.oracle,
    tooltip:
      "Work out the HBAR to pair with your tokens so the pool opens at a US dollar price, from Pyth's HBAR/USD feed on Hedera.",
    fields: [
      {
        key: "tokenAmount",
        label: "Tokens to deposit",
        kind: "amount",
        help: "In tokens, not smallest units: 1.5 is one and a half",
      },
      { key: "tokenPriceUsd", label: "Opening price (USD)", kind: "amount", help: "The price of one token" },
      {
        key: "maxAgeSeconds",
        label: "Max age (s)",
        kind: "number",
        help: "Refuse an older HBAR/USD price; 0 accepts any age",
      },
      {
        key: "maxConfidenceBps",
        label: "Max confidence (bps)",
        kind: "number",
        help: "Refuse a price whose confidence interval is wider than this (100 = 1%)",
      },
    ],
    outputs: [
      { key: "tokenAmount", label: "Tokens", kind: "amount" },
      { key: "hbarAmount", label: "HBAR", kind: "amount" },
      { key: "hbarUsd", label: "HBAR/USD", kind: "amount" },
      { key: "pythContractId", label: "Pyth contract", kind: "contractId" },
      { key: "updateTransactionId", label: "Price update", kind: "transactionId" },
    ],
  },
  docs: {
    summary: "Price a pool in US dollars: the HBAR to pair with a token deposit, from Pyth's HBAR/USD feed.",
    details: [
      "Wire **Tokens** and **HBAR** into **Seed SaucerSwap pool** and the pool opens at the dollar price you",
      "set. HBAR = tokens × price ÷ HBAR/USD, rounded down to a tinybar.",
      "",
      "Pyth is a pull oracle: its contract on Hedera holds the last price anyone posted. With `PYTH_API_KEY`",
      "(a Hermes key from Pyth Terminal) the step fetches a signed update from Hermes, posts it with",
      "`updatePriceFeeds` (1 tinybar on testnet), and reads the price back, seconds old. Without a key it",
      "reads the price already on-chain through the mirror node, for free, and refuses it if it is older than",
      "`maxAgeSeconds` (0 accepts any age). It also refuses a price whose confidence interval is wider than",
      "`maxConfidenceBps`.",
    ].join("\n"),
    hederaServices: ["SmartContract", "MirrorNode"],
    integrations: ["Pyth"],
  },
  execute: (input, ctx) => priceInUsd(ctx.hedera, input, ctx.signal),
  codegen: ctx =>
    callOperation(ctx, "priceInUsd", ["tokenAmount", "tokenPriceUsd", "maxAgeSeconds", "maxConfidenceBps"]),
});
