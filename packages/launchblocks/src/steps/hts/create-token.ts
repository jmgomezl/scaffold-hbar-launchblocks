import { z } from "zod";

import { createFungibleToken } from "../../hedera/ops/tokens";
import { defineStep } from "../../registry/define-step";
import { AccountIdSchema, AmountSchema, CATEGORY_COLOUR, MemoSchema, callOperation } from "../shared";

const KeysSchema = z
  .object({
    admin: z.boolean().default(true),
    supply: z.boolean().default(true),
    freeze: z.boolean().default(false),
    wipe: z.boolean().default(false),
    pause: z.boolean().default(false),
    kyc: z.boolean().default(false),
    feeSchedule: z.boolean().default(false),
  })
  .prefault({});

const FractionalFeeSchema = z.object({
  numerator: z.number().int().positive(),
  denominator: z.number().int().positive(),
  min: AmountSchema.optional(),
  max: AmountSchema.optional(),
  collectorAccountId: AccountIdSchema.optional(),
  assessment: z.enum(["inclusive", "exclusive"]).default("inclusive"),
});

const FixedHbarFeeSchema = z.object({
  amountHbar: AmountSchema,
  collectorAccountId: AccountIdSchema.optional(),
});

const InputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    symbol: z.string().trim().min(1).max(100),
    decimals: z.number().int().min(0).max(18).default(8),
    initialSupply: AmountSchema.default("1000000"),
    supplyType: z.enum(["infinite", "finite"]).default("infinite"),
    maxSupply: AmountSchema.optional(),
    memo: MemoSchema.optional(),
    keys: KeysSchema,
    fractionalFee: FractionalFeeSchema.optional(),
    fixedHbarFee: FixedHbarFeeSchema.optional(),
  })
  .refine(input => input.supplyType === "infinite" || input.maxSupply !== undefined, {
    message: "maxSupply is required for a finite supply",
    path: ["maxSupply"],
  });

const OutputSchema = z.object({
  tokenId: z.string(),
  transactionId: z.string(),
  treasuryAccountId: z.string(),
  symbol: z.string(),
  decimals: z.number().int(),
  initialSupply: z.string(),
  initialSupplyUnits: z.string(),
  supplyType: z.enum(["infinite", "finite"]),
  maxSupplyUnits: z.string().nullable(),
});

export const htsCreateToken = defineStep({
  type: "hts.createToken",
  input: InputSchema,
  output: OutputSchema,
  outputExample: {
    tokenId: "0.0.6512345",
    transactionId: "0.0.4242@1758500000.123456789",
    treasuryAccountId: "0.0.4242",
    symbol: "LBD",
    decimals: 8,
    initialSupply: "1000000",
    initialSupplyUnits: "100000000000000",
    supplyType: "infinite",
    maxSupplyUnits: null,
  },
  ui: {
    label: "Create HTS token",
    category: "hts",
    colour: CATEGORY_COLOUR.hts,
    tooltip: "Create a fungible token with the operator as treasury and key holder.",
    fields: [
      { key: "name", label: "Name", kind: "text", placeholder: "LaunchBlocks Demo" },
      { key: "symbol", label: "Symbol", kind: "text", placeholder: "LBD" },
      { key: "decimals", label: "Decimals", kind: "number", help: "0–18; 8 matches HBAR" },
      { key: "initialSupply", label: "Initial supply", kind: "amount", help: "Whole tokens minted to the treasury" },
      {
        key: "supplyType",
        label: "Supply",
        kind: "select",
        options: [
          { value: "infinite", label: "Infinite" },
          { value: "finite", label: "Finite (needs max supply)" },
        ],
      },
      { key: "maxSupply", label: "Max supply", kind: "amount", help: "Only for finite supply" },
      { key: "memo", label: "Memo", kind: "text" },
      {
        key: "keys.admin",
        label: "Admin key",
        kind: "boolean",
        help: "Update or delete the token later",
        advanced: true,
      },
      { key: "keys.supply", label: "Supply key", kind: "boolean", help: "Mint or burn later", advanced: true },
      { key: "keys.freeze", label: "Freeze key", kind: "boolean", advanced: true },
      { key: "keys.wipe", label: "Wipe key", kind: "boolean", advanced: true },
      { key: "keys.pause", label: "Pause key", kind: "boolean", advanced: true },
      { key: "keys.kyc", label: "KYC key", kind: "boolean", advanced: true },
      {
        key: "keys.feeSchedule",
        label: "Fee schedule key",
        kind: "boolean",
        help: "Change custom fees later",
        advanced: true,
      },
      {
        key: "fractionalFee.numerator",
        label: "Fee numerator",
        kind: "number",
        help: "1 with denominator 100 = 1%",
        advanced: true,
      },
      { key: "fractionalFee.denominator", label: "Fee denominator", kind: "number", advanced: true },
      {
        key: "fractionalFee.assessment",
        label: "Fee charged",
        kind: "select",
        options: [
          { value: "inclusive", label: "Out of the amount sent" },
          { value: "exclusive", label: "On top, to the sender" },
        ],
        advanced: true,
      },
      {
        key: "fixedHbarFee.amountHbar",
        label: "Fixed HBAR fee",
        kind: "amount",
        help: "Per transfer, paid by the sender",
        advanced: true,
      },
    ],
    outputs: [
      { key: "tokenId", label: "Token", kind: "tokenId" },
      { key: "treasuryAccountId", label: "Treasury", kind: "accountId" },
      { key: "transactionId", label: "Create transaction", kind: "transactionId" },
      { key: "symbol", label: "Symbol", kind: "text" },
      { key: "decimals", label: "Decimals", kind: "number" },
      { key: "initialSupply", label: "Initial supply", kind: "amount" },
    ],
  },
  docs: {
    summary: "Create a fungible HTS token with configurable keys, supply type and custom fees.",
    details:
      "The operator account becomes the treasury and holds every enabled key, so the flow signs with one key. " +
      "Enable the supply key to mint later, the admin key to update, and add a fractional fee to earn on every transfer.",
    hederaServices: ["HTS"],
  },
  execute: (input, ctx) => createFungibleToken(ctx.hedera, input),
  codegen: ctx =>
    callOperation(ctx, "createFungibleToken", [
      "name",
      "symbol",
      "decimals",
      "initialSupply",
      "supplyType",
      "maxSupply",
      "memo",
      "keys",
      "fractionalFee",
      "fixedHbarFee",
    ]),
});
