import { z } from "zod";

import {
  FLOW_ID_PATTERN,
  JS_RESERVED_WORDS,
  LAUNCHBLOCKS_RESERVED_IDS,
  STEP_ID_PATTERN,
  STEP_TYPE_PATTERN,
} from "./ids";

export { FLOW_ID_PATTERN, STEP_ID_PATTERN, STEP_TYPE_PATTERN } from "./ids";

/**
 * A flow is an ordered list of steps. Steps run strictly in sequence; a step
 * may reference outputs of any step before it via `{{steps.<id>.<key>}}`.
 * Identifier rules live in ./ids.
 */

export const NetworkSchema = z.enum(["testnet", "mainnet", "localnet"]);
export type Network = z.infer<typeof NetworkSchema>;

export const StepIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(STEP_ID_PATTERN, "step id must be a camelCase identifier (e.g. createToken)")
  .refine(id => !JS_RESERVED_WORDS.has(id), { message: "step id must not be a JavaScript keyword" })
  .refine(id => !LAUNCHBLOCKS_RESERVED_IDS.has(id), {
    message: `step id must not be one of: ${[...LAUNCHBLOCKS_RESERVED_IDS].join(", ")}`,
  });

export const StepTypeSchema = z
  .string()
  .regex(STEP_TYPE_PATTERN, "step type must look like namespace.action (e.g. hts.createToken)");

export const StepEnvelopeSchema = z.object({
  id: StepIdSchema,
  type: StepTypeSchema,
  /** Free-text label shown in the editor and run log. */
  label: z.string().max(80).optional(),
  /** Step-specific parameters, validated later against the registered step definition. */
  params: z.record(z.string(), z.unknown()).default({}),
});
export type StepEnvelope = z.infer<typeof StepEnvelopeSchema>;

export const FlowSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1).max(64).regex(FLOW_ID_PATTERN, "flow id must be kebab-case (e.g. hts-launch)"),
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    network: NetworkSchema.default("testnet"),
    steps: z.array(StepEnvelopeSchema).min(1, "a flow needs at least one step"),
  })
  .superRefine((flow, ctx) => {
    const seen = new Map<string, number>();
    flow.steps.forEach((step, index) => {
      const first = seen.get(step.id);
      if (first !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["steps", index, "id"],
          message: `duplicate step id "${step.id}" (first used at steps[${first}])`,
        });
      } else {
        seen.set(step.id, index);
      }
    });
  });

export type Flow = z.infer<typeof FlowSchema>;
/** The shape accepted from JSON before defaults are applied. */
export type FlowInput = z.input<typeof FlowSchema>;
