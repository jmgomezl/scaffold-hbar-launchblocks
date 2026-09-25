import { z } from "zod";

import { HCS_CHUNK_BYTES, messageBytes, submitTopicMessage } from "../../hedera/ops/topics";
import { defineStep } from "../../registry/define-step";
import { CATEGORY_COLOUR, TopicIdSchema, callOperation } from "../shared";

export const hcsSubmitMessage = defineStep({
  type: "hcs.submitMessage",
  input: z
    .object({
      topicId: TopicIdSchema,
      message: z.union([z.string().min(1), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
      maxChunks: z.number().int().min(1).max(20).default(10),
    })
    // Checked with references filled in by example outputs, so a message near the limit may still differ at run time.
    .refine(input => messageBytes(input.message) <= HCS_CHUNK_BYTES * input.maxChunks, {
      path: ["message"],
      message: `the message is longer than maxChunks × ${HCS_CHUNK_BYTES} bytes`,
    }),
  output: z.object({
    topicId: z.string(),
    sequenceNumber: z.number().int(),
    transactionId: z.string(),
    bytes: z.number().int(),
  }),
  outputExample: {
    topicId: "0.0.6512400",
    sequenceNumber: 1,
    transactionId: "0.0.4242@1758500060.000000001",
    bytes: 96,
  },
  ui: {
    label: "Log to HCS topic",
    category: "hcs",
    colour: CATEGORY_COLOUR.hcs,
    tooltip: "Append a message (text or JSON) to a topic. References to earlier steps are interpolated.",
    fields: [
      { key: "topicId", label: "Topic", kind: "topicId" },
      {
        key: "message",
        label: "Message",
        kind: "json",
        help: 'Text or JSON; e.g. {"event":"launch","tokenId":"{{steps.createToken.tokenId}}"}',
      },
      { key: "maxChunks", label: "Max chunks", kind: "number", help: "1024 bytes per chunk" },
    ],
    outputs: [
      { key: "topicId", label: "Topic", kind: "topicId" },
      { key: "sequenceNumber", label: "Sequence number", kind: "number" },
      { key: "transactionId", label: "Message transaction", kind: "transactionId" },
    ],
  },
  docs: {
    summary: "Append a text or JSON message to a topic, with consensus timestamp and sequence number.",
    hederaServices: ["HCS"],
  },
  execute: (input, ctx) => submitTopicMessage(ctx.hedera, input),
  codegen: ctx => callOperation(ctx, "submitTopicMessage", ["topicId", "message", "maxChunks"], ["message"]),
});
