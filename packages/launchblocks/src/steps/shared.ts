import { z } from "zod";

import { LaunchBlocksError } from "../errors";
import { numberToDecimalString, toUnits } from "../hedera/amounts";
import type { CodegenContext, CodegenFragment, EarlierStepLookup, WiringIssue } from "../registry/types";

/** Entity ids in shard.realm.num form. */
export const ENTITY_ID_PATTERN = /^\d+\.\d+\.\d+$/;
/** Accounts may also be given as 20-byte EVM addresses. */
export const ACCOUNT_PATTERN = /^(\d+\.\d+\.\d+|0x[0-9a-fA-F]{40})$/;

export const TokenIdSchema = z.string().trim().regex(ENTITY_ID_PATTERN, "expected a token id like 0.0.12345");
export const TopicIdSchema = z.string().trim().regex(ENTITY_ID_PATTERN, "expected a topic id like 0.0.12345");
export const AccountIdSchema = z
  .string()
  .trim()
  .regex(ACCOUNT_PATTERN, "expected an account id like 0.0.12345 or a 0x EVM address");

/** Human amounts in whole tokens: a non-negative number or decimal string. Large values must be strings. */
export const AmountSchema = z.union([
  z.number().nonnegative().finite(),
  z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, "expected a non-negative decimal amount"),
]);

const isPositive = (value: string | number) => Number(value) > 0 || /[1-9]/.test(String(value));

/** Positive amount for transfers, mints and airdrops. */
export const PositiveAmountSchema = AmountSchema.refine(isPositive, { message: "amount must be greater than zero" });

/** Digits after the decimal point, trailing zeros aside: "1.50" has 1. */
export function fractionDigits(value: string | number): number {
  const text = typeof value === "number" ? numberToDecimalString(value) : value.trim();
  return (/\.(\d+)$/.exec(text)?.[1] ?? "").replace(/0+$/, "").length;
}

/** HBAR: a tinybar is 0.00000001, so at most 8 decimal places. */
export const HbarAmountSchema = AmountSchema.refine(value => fractionDigits(value) <= 8, {
  message: "HBAR has 8 decimal places (1 tinybar = 0.00000001)",
});
export const PositiveHbarAmountSchema = HbarAmountSchema.refine(isPositive, {
  message: "amount must be greater than zero",
});

/** Hedera limits text by UTF-8 bytes, not characters, and refuses a NUL byte. */
export function hederaText(maxBytes: number, what: string) {
  return z
    .string()
    .max(maxBytes, `${what} is limited to ${maxBytes} bytes`)
    .refine(text => new TextEncoder().encode(text).length <= maxBytes, {
      message: `${what} is limited to ${maxBytes} bytes, and accented letters and emoji take 2 to 4 each`,
    })
    .refine(text => !text.includes("\u0000"), { message: `${what} cannot contain a NUL character` });
}

export const MemoSchema = hederaText(100, "a memo");

/** Hedera colour palette for the editor, by step category. */
export const CATEGORY_COLOUR = {
  hts: 200,
  hcs: 290,
  hss: 160,
  saucerswap: 30,
  oracle: 60,
  contract: 260,
  // No shipped step uses it: the test helpers' network-free steps do.
  util: 0,
} as const;

/**
 * Codegen for steps whose input is exactly the params of an exported
 * operation: `return await <fn>(ctx, { ...params });`
 */
export function callOperation(
  ctx: CodegenContext,
  fn: string,
  keys: readonly string[],
  /** Params that are free-form data, such as a message body (see `CodegenContext.expr`). */
  dataKeys: readonly string[] = [],
): CodegenFragment {
  ctx.addImport(ctx.coreModule, fn);
  const entries = keys
    .map(key => `${key}: ${ctx.expr(key, { data: dataKeys.includes(key) })}`)
    .filter(entry => !entry.endsWith(": undefined"));
  return { body: `return await ${fn}(ctx, { ${entries.join(", ")} });` };
}

/** A token an earlier step of the flow creates, when `tokenId` references its `tokenId` and its settings are written out. */
export function tokenMadeInFlow(
  tokenId: unknown,
  earlier: EarlierStepLookup,
): { stepId: string; decimals: number; supplyKey: boolean } | undefined {
  const source = earlier(tokenId);
  if (!source || source.type !== "hts.createToken" || source.key !== "tokenId") return undefined;
  const decimals = source.params.decimals ?? 8;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) return undefined;
  const keys = source.params.keys as Record<string, unknown> | undefined;
  return { stepId: source.stepId, decimals, supplyKey: keys?.supply !== false };
}

/**
 * Amounts of a token the flow creates that the token cannot hold: more
 * decimal places than it has, or more units than HTS stores. Checked before
 * the run, since otherwise the step fails after the token is paid for.
 */
export function tokenAmountIssues(
  params: Readonly<Record<string, unknown>>,
  amounts: readonly { path: string; value: unknown }[],
  earlier: EarlierStepLookup,
): WiringIssue[] {
  const token = tokenMadeInFlow(params.tokenId, earlier);
  if (!token) return [];
  return amounts.flatMap(({ path, value }) => {
    // References and malformed values are someone else's check.
    if (typeof value !== "number" && (typeof value !== "string" || value.includes("{{"))) return [];
    try {
      toUnits(value, token.decimals);
      return [];
    } catch (error) {
      if (!(error instanceof LaunchBlocksError) || error.code === "AMOUNT_INVALID") return [];
      return [{ path, message: `${error.message} (the token ${token.stepId} creates)` }];
    }
  });
}
