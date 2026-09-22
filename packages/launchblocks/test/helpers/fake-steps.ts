import { z } from "zod";

import { defineStep } from "../../src/registry/define-step";
import type { RunContext } from "../../src/registry/types";

/**
 * Network-free step definitions that exercise every part of the registry and
 * runner contract: typed inputs/outputs, references, failures.
 */

export const TOKEN_ID = /^0\.0\.\d+$/;

export const makeToken = defineStep({
  type: "fake.makeToken",
  input: z.object({
    symbol: z.string().min(1).max(8),
    decimals: z.number().int().min(0).max(18).default(8),
  }),
  output: z.object({
    tokenId: z.string().regex(TOKEN_ID),
    decimals: z.number().int(),
    transactionId: z.string(),
  }),
  outputExample: { tokenId: "0.0.1001", decimals: 8, transactionId: "0.0.2@1.0" },
  ui: {
    label: "Make token",
    category: "util",
    colour: 20,
    fields: [
      { key: "symbol", label: "Symbol", kind: "text" },
      { key: "decimals", label: "Decimals", kind: "number" },
    ],
    outputs: [
      { key: "tokenId", label: "Token id", kind: "tokenId" },
      { key: "decimals", label: "Decimals", kind: "number" },
    ],
  },
  docs: { summary: "Fake token creation.", hederaServices: [] },
  async execute(input, ctx) {
    ctx.log("info", `making ${input.symbol}`);
    return { tokenId: `0.0.${1000 + input.symbol.length}`, decimals: input.decimals, transactionId: "0.0.2@1.0" };
  },
  codegen: ctx => ({
    body: `const ${ctx.stepId} = await fakeMakeToken(${ctx.expr("symbol")}, ${ctx.expr("decimals")});`,
  }),
});

export const useToken = defineStep({
  type: "fake.useToken",
  input: z.object({
    tokenId: z.string().regex(TOKEN_ID, "expected a token id like 0.0.123"),
    amount: z.number().positive(),
    memo: z.string().optional(),
  }),
  output: z.object({ ok: z.literal(true), memo: z.string() }),
  outputExample: { ok: true, memo: "" },
  ui: {
    label: "Use token",
    category: "util",
    colour: 20,
    fields: [
      { key: "tokenId", label: "Token", kind: "tokenId" },
      { key: "amount", label: "Amount", kind: "amount" },
      { key: "memo", label: "Memo", kind: "text" },
    ],
    outputs: [{ key: "memo", label: "Memo", kind: "text" }],
  },
  docs: { summary: "Fake token usage.", hederaServices: [] },
  async execute(input) {
    return { ok: true as const, memo: input.memo ?? `${input.amount} of ${input.tokenId}` };
  },
  codegen: ctx => ({
    body: `const ${ctx.stepId} = await fakeUseToken(${ctx.expr("tokenId")}, ${ctx.expr("amount")}, ${ctx.expr("memo")});`,
  }),
});

export const explode = defineStep({
  type: "fake.explode",
  input: z.object({ reason: z.string().default("boom") }),
  output: z.object({ never: z.string() }),
  outputExample: { never: "" },
  ui: { label: "Explode", category: "util", colour: 0, fields: [], outputs: [] },
  docs: { summary: "Always fails.", hederaServices: [] },
  async execute(input): Promise<{ never: string }> {
    throw new Error(input.reason);
  },
  codegen: ctx => ({ body: `const ${ctx.stepId} = await explode();` }),
});

export const FAKE_STEPS = [makeToken, useToken, explode] as const;

export function fakeRunContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    network: "testnet",
    // Fake steps never touch the SDK; a real context is only built by API routes.
    hedera: undefined as unknown as RunContext["hedera"],
    log: () => undefined,
    ...overrides,
  };
}
