import { z } from "zod";

import type { CodegenContext, CodegenFragment } from "../registry/types";

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

/** Positive amount for transfers, mints and airdrops. */
export const PositiveAmountSchema = AmountSchema.refine(v => Number(v) > 0 || /[1-9]/.test(String(v)), {
  message: "amount must be greater than zero",
});

export const MemoSchema = z.string().max(100, "memos are limited to 100 bytes");

/** Hedera colour palette for the editor, by step category. */
export const CATEGORY_COLOUR = {
  hts: 200,
  hcs: 290,
  hss: 160,
  saucerswap: 30,
  oracle: 60,
  contract: 260,
  util: 0,
} as const;

/**
 * Codegen for steps whose input is exactly the params of an exported
 * operation: `return await <fn>(ctx, { ...params });`
 */
export function callOperation(ctx: CodegenContext, fn: string, keys: readonly string[]): CodegenFragment {
  ctx.addImport(ctx.coreModule, fn);
  const entries = keys.map(key => `${key}: ${ctx.expr(key)}`).filter(entry => !entry.endsWith(": undefined"));
  return { body: `return await ${fn}(ctx, { ${entries.join(", ")} });` };
}
