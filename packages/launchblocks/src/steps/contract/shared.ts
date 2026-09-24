import { z } from "zod";

import type { CodegenContext, FieldSpec } from "../../registry/types";

/** Contract blocks take up to four arguments, one socket each. */
export const ARG_KEYS = ["arg1", "arg2", "arg3", "arg4"] as const;

/** A literal or a reference; the ABI coder converts it for the parameter's type when the step runs. */
export const ContractArgSchema = z.union([z.string(), z.number(), z.boolean()]);

export const contractArgShape = Object.fromEntries(ARG_KEYS.map(key => [key, ContractArgSchema.optional()])) as {
  [K in (typeof ARG_KEYS)[number]]: z.ZodOptional<typeof ContractArgSchema>;
};

type ArgInput = { [K in (typeof ARG_KEYS)[number]]?: z.infer<typeof ContractArgSchema> | undefined };

/** The filled arguments in order, or the first gap (an empty socket before a filled one). */
export function collectArgs(input: ArgInput): { args: unknown[]; gap?: number } {
  const filled = ARG_KEYS.map(key => input[key]);
  const last = filled.map(value => value !== undefined).lastIndexOf(true);
  const args = filled.slice(0, last + 1);
  const gap = args.findIndex(value => value === undefined);
  return gap >= 0 ? { args, gap: gap + 1 } : { args };
}

export const argFields: FieldSpec[] = ARG_KEYS.map((key, index) => ({
  key,
  label: `Argument ${index + 1}`,
  kind: "value",
  ...(index === 0
    ? {
        help: "Fill arguments in order. Ids like 0.0.123 become addresses; whole numbers are in smallest units.",
      }
    : {}),
}));

/** `[arg1, arg2, …]` for generated code, stopping at the last filled argument. */
export function argsExpression(ctx: CodegenContext): string {
  const expressions = ARG_KEYS.map(key => ctx.expr(key));
  const last = expressions.map(expression => expression !== "undefined").lastIndexOf(true);
  return `[${expressions.slice(0, last + 1).join(", ")}]`;
}
