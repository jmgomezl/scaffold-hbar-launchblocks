import { z } from "zod";

import { createFungibleToken } from "../../hedera/ops/tokens";
import { defineStep } from "../../registry/define-step";
import { LaunchBlocksError } from "../../errors";
import { toUnits } from "../../hedera/amounts";
import {
  AccountIdSchema,
  AmountSchema,
  CATEGORY_COLOUR,
  MemoSchema,
  PositiveHbarAmountSchema,
  callOperation,
  hederaText,
} from "../shared";

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
  // Hedera refuses a zero fee (CUSTOM_FEE_MUST_BE_POSITIVE), after charging for the token.
  amountHbar: PositiveHbarAmountSchema,
  collectorAccountId: AccountIdSchema.optional(),
});

const InputSchema = z
  .object({
    name: hederaText(100, "a token name").pipe(z.string().trim().min(1)),
    symbol: hederaText(100, "a token symbol").pipe(z.string().trim().min(1)),
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
  })
  // What Hedera would refuse only after the fee is paid: amounts it cannot hold, a max below the supply.
  .superRefine((input, ctx) => {
    // zod still runs this when a field failed; with bad decimals every amount check would repeat that one issue.
    if (!Number.isInteger(input.decimals) || input.decimals < 0 || input.decimals > 18) return;
    const units = (key: string, amount: string | number | undefined) => {
      if (amount === undefined) return undefined;
      try {
        return toUnits(amount, input.decimals);
      } catch (error) {
        if (!(error instanceof LaunchBlocksError)) throw error;
        ctx.addIssue({ code: "custom", path: key.split("."), message: error.message });
        return undefined;
      }
    };
    const initial = units("initialSupply", input.initialSupply);
    const max = units("maxSupply", input.maxSupply);
    if (input.supplyType === "finite" && max !== undefined) {
      if (max === 0n)
        ctx.addIssue({ code: "custom", path: ["maxSupply"], message: "a finite supply needs a maximum above zero" });
      else if (initial !== undefined && max < initial) {
        ctx.addIssue({ code: "custom", path: ["maxSupply"], message: "maxSupply is below the initial supply" });
      }
    }
    const fee = input.fractionalFee;
    if (fee) {
      const min = units("fractionalFee.min", fee.min);
      const most = units("fractionalFee.max", fee.max);
      if (fee.numerator > fee.denominator) {
        ctx.addIssue({
          code: "custom",
          path: ["fractionalFee", "numerator"],
          message: "a fee cannot be more than the whole transfer",
        });
      }
      if (min !== undefined && most !== undefined && most > 0n && min > most) {
        ctx.addIssue({
          code: "custom",
          path: ["fractionalFee", "min"],
          message: "the fee's minimum is above its maximum",
        });
      }
    }
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
