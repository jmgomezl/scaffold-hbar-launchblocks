import { z } from "zod";

import { MAX_SCHEDULE_DELAY_SECONDS } from "../../hedera/ops/schedules";
import type { FieldSpec, OutputSpec } from "../../registry/types";
import { MemoSchema } from "../shared";

export const scheduleShape = {
  delaySeconds: z
    .number()
    .int()
    .min(1, "a schedule must run at least one second from now")
    .max(MAX_SCHEDULE_DELAY_SECONDS, "schedules can run at most 62 days ahead (5356800 seconds)"),
  memo: MemoSchema.optional(),
  adminKey: z.boolean().default(false),
};

export const scheduleFields: FieldSpec[] = [
  {
    key: "delaySeconds",
    label: "Runs in (seconds)",
    kind: "number",
    help: "3600 = 1 hour, 86400 = 1 day, 2592000 = 30 days; at most 62 days",
  },
  { key: "memo", label: "Schedule memo", kind: "text" },
  {
    key: "adminKey",
    label: "Cancellable",
    kind: "boolean",
    help: "Give the schedule an admin key so it can be deleted",
  },
];

export const scheduleOutputs: OutputSpec[] = [
  { key: "scheduleId", label: "Schedule", kind: "scheduleId" },
  { key: "executesAt", label: "Runs at", kind: "text" },
  { key: "scheduledTransactionId", label: "Scheduled transaction", kind: "transactionId" },
];

export const scheduleOutputShape = {
  scheduleId: z.string(),
  scheduledTransactionId: z.string(),
  executesAt: z.string(),
  transactionId: z.string(),
};

export const scheduleOutputExample = {
  scheduleId: "0.0.6512700",
  scheduledTransactionId: "0.0.4242@1758500090.000000001?scheduled",
  executesAt: "2025-10-22T00:00:00.000Z",
  transactionId: "0.0.4242@1758500090.000000001",
};

export const SCHEDULE_DETAILS = [
  "Wraps the transaction in a ScheduleCreate with an expiration time and `waitForExpiry` (HIP-423",
  "long-term schedules), so the network runs it at that time with nobody online. The operator's",
  "signature on the ScheduleCreate also counts for the scheduled transaction, so the schedule is complete",
  "when it is created. `delaySeconds` can be at most 62 days. With `adminKey` the schedule can be",
  "deleted before it runs; without one it cannot be stopped.",
].join("\n");
