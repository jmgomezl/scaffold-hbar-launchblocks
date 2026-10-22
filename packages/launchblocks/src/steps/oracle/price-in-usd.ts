import { z } from "zod";

import { DEFAULT_MAX_DEVIATION_BPS, DEFAULT_ORACLE_MAX_AGE_SECONDS, oraclePriceInUsd } from "../../oracle/price-in-usd";
import { defineStep } from "../../registry/define-step";
import { CATEGORY_COLOUR, PositiveAmountSchema, callOperation } from "../shared";

export const oraclePriceInUsdStep = defineStep({
  type: "oracle.priceInUsd",
  input: z.object({
    tokenAmount: PositiveAmountSchema,
    tokenPriceUsd: PositiveAmountSchema,
    maxAgeSeconds: z.number().int().min(0).max(31_536_000).default(DEFAULT_ORACLE_MAX_AGE_SECONDS),
    maxDeviationBps: z.number().int().min(1).max(10_000).default(DEFAULT_MAX_DEVIATION_BPS),
  }),
  output: z.object({
    tokenAmount: z.string(),
    tokenPriceUsd: z.string(),
    hbarAmount: z.string(),
    usdValue: z.string(),
    hbarUsd: z.string(),
    source: z.enum(["chainlink", "pyth"]),
    feedContractId: z.string(),
    roundId: z.string(),
    updatedAt: z.string(),
    priceAgeSeconds: z.number(),
    crossCheckHbarUsd: z.string(),
  }),
  outputExample: {
    tokenAmount: "50000",
    tokenPriceUsd: "0.00002",
    hbarAmount: "12.47174681",
    usdValue: "1",
    hbarUsd: "0.08018123",
    source: "chainlink",
    feedContractId: "0.0.4870176",
    roundId: "18446744073709554475",
    updatedAt: "2026-10-22T15:20:33.000Z",
    priceAgeSeconds: 640,
    crossCheckHbarUsd: "",
  },
  ui: {
    label: "Price in USD (Chainlink)",
    category: "oracle",
    colour: CATEGORY_COLOUR.oracle,
    tooltip:
      "Work out the HBAR to pair with your tokens so the pool opens at a US dollar price, from Chainlink's HBAR/USD feed on Hedera, cross-checked with Pyth.",
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
        advanced: true,
        help: "Refuse an older Chainlink price; it updates on any 0.5% move and at least daily. 0 accepts any age",
      },
      {
        key: "maxDeviationBps",
        label: "Max deviation (bps)",
        kind: "number",
        advanced: true,
        help: "When Pyth's price is fresh too, refuse if the two differ by more than this (100 = 1%)",
      },
    ],
    outputs: [
      { key: "tokenAmount", label: "Tokens", kind: "amount" },
      { key: "hbarAmount", label: "HBAR", kind: "amount" },
      { key: "hbarUsd", label: "HBAR/USD", kind: "amount" },
      { key: "feedContractId", label: "Price feed", kind: "contractId" },
    ],
  },
  docs: {
    summary: "Price a pool in US dollars: the HBAR to pair with a token deposit, from Chainlink's HBAR/USD feed.",
    details: [
      "Wire **Tokens** and **HBAR** into **Seed SaucerSwap pool** and the pool opens at the dollar price you",
      "set. HBAR = tokens × price ÷ HBAR/USD, rounded down to a tinybar.",
      "",
      "Chainlink is a push oracle: its feed on Hedera writes a new round on any 0.5% move and at least once a",
      "day, so the step reads it for free through the mirror node, with no update to post. It refuses a round",
      "older than `maxAgeSeconds` (a day and an hour by default; 0 accepts any age). When Pyth's on-chain price",
      "is fresh too (posted in the last ten minutes), the two must agree within `maxDeviationBps`; when",
      "Chainlink is stale and Pyth is fresh, the step uses Pyth, and `source` says which.",
    ].join("\n"),
    hederaServices: ["SmartContract", "MirrorNode"],
    integrations: ["Chainlink", "Pyth"],
  },
  execute: (input, ctx) => oraclePriceInUsd(ctx.hedera, input, ctx.signal),
  codegen: ctx =>
    callOperation(ctx, "oraclePriceInUsd", ["tokenAmount", "tokenPriceUsd", "maxAgeSeconds", "maxDeviationBps"]),
});
