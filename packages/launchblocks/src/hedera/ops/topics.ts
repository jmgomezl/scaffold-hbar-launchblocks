import { TopicCreateTransaction, TopicId, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";

import { LaunchBlocksError } from "../../errors";
import type { HederaContext } from "../context";
import { submit } from "./submit";

/**
 * Hedera Consensus Service operations behind the `hcs.*` blocks.
 * A launch log is a topic; every step that matters appends a message.
 */

export type CreateTopicParams = {
  memo?: string | undefined;
  /** Operator can update/delete the topic. */
  adminKey: boolean;
  /** Only the operator can post; leave off for a public topic. */
  submitKey: boolean;
};

export type CreateTopicResult = { topicId: string; transactionId: string };

export function buildTopicCreate(hedera: HederaContext, params: CreateTopicParams): TopicCreateTransaction {
  const tx = new TopicCreateTransaction();
  if (params.memo) tx.setTopicMemo(params.memo);
  if (params.adminKey) tx.setAdminKey(hedera.operatorKey.publicKey);
  if (params.submitKey) tx.setSubmitKey(hedera.operatorKey.publicKey);
  return tx;
}

export async function createTopic(hedera: HederaContext, params: CreateTopicParams): Promise<CreateTopicResult> {
  return submit(hedera.client, buildTopicCreate(hedera, params), "Creating topic", (receipt, response) => {
    if (!receipt.topicId) {
      throw new LaunchBlocksError("RECEIPT_INCOMPLETE", "Topic creation succeeded but the receipt has no topic id");
    }
    return { topicId: receipt.topicId.toString(), transactionId: response.transactionId.toString() };
  });
}

/** HCS accepts 1024 bytes per chunk; the SDK splits larger messages automatically. */
export const HCS_CHUNK_BYTES = 1024;

export type SubmitMessageParams = {
  topicId: string;
  /** Strings are sent as-is; objects are JSON-encoded. */
  message: string | Record<string, unknown> | unknown[];
  maxChunks: number;
};

export type SubmitMessageResult = {
  topicId: string;
  sequenceNumber: number;
  transactionId: string;
  bytes: number;
};

export function encodeMessage(message: SubmitMessageParams["message"]): string {
  return typeof message === "string" ? message : JSON.stringify(message);
}

export function buildTopicMessageSubmit(params: SubmitMessageParams): TopicMessageSubmitTransaction {
  const encoded = encodeMessage(params.message);
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes === 0) {
    throw new LaunchBlocksError("MESSAGE_EMPTY", "Topic message must not be empty");
  }
  if (bytes > HCS_CHUNK_BYTES * params.maxChunks) {
    throw new LaunchBlocksError(
      "MESSAGE_TOO_LARGE",
      `Message is ${bytes} bytes but maxChunks=${params.maxChunks} allows ${HCS_CHUNK_BYTES * params.maxChunks}`,
    );
  }
  return new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(params.topicId))
    .setMessage(encoded)
    .setMaxChunks(params.maxChunks);
}

export async function submitTopicMessage(
  hedera: HederaContext,
  params: SubmitMessageParams,
): Promise<SubmitMessageResult> {
  const tx = buildTopicMessageSubmit(params);
  const bytes = Buffer.byteLength(encodeMessage(params.message), "utf8");
  return submit(hedera.client, tx, `Submitting message to ${params.topicId}`, (receipt, response) => ({
    topicId: params.topicId,
    sequenceNumber: Number(receipt.topicSequenceNumber),
    transactionId: response.transactionId.toString(),
    bytes,
  }));
}
