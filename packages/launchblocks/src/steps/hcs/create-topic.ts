import { z } from "zod";

import { createTopic } from "../../hedera/ops/topics";
import { defineStep } from "../../registry/define-step";
import { CATEGORY_COLOUR, MemoSchema, callOperation } from "../shared";

export const hcsCreateTopic = defineStep({
  type: "hcs.createTopic",
  input: z.object({
    memo: MemoSchema.optional(),
    adminKey: z.boolean().default(true),
    submitKey: z.boolean().default(true),
  }),
  output: z.object({ topicId: z.string(), transactionId: z.string() }),
  outputExample: { topicId: "0.0.6512400", transactionId: "0.0.4242@1758500050.000000001" },
  ui: {
    label: "Create HCS topic",
    category: "hcs",
    colour: CATEGORY_COLOUR.hcs,
    tooltip: "Create a consensus topic to use as a tamper-evident launch log.",
    fields: [
      { key: "memo", label: "Memo", kind: "text", placeholder: "LBD launch log" },
      { key: "adminKey", label: "Admin key", kind: "boolean", help: "Operator can update the topic" },
      {
        key: "submitKey",
        label: "Submit key",
        kind: "boolean",
        help: "Only you can post. Leave it on for a launch log: without it anyone can write to the log",
      },
    ],
    outputs: [
      { key: "topicId", label: "Topic", kind: "topicId" },
      { key: "transactionId", label: "Create transaction", kind: "transactionId" },
    ],
  },
  docs: {
    summary: "Create an HCS topic as the launch's public, ordered, timestamped log.",
    hederaServices: ["HCS"],
  },
  execute: (input, ctx) => createTopic(ctx.hedera, input),
  codegen: ctx => callOperation(ctx, "createTopic", ["memo", "adminKey", "submitKey"]),
});
