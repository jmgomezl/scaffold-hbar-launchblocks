import { afterAll, describe, expect, it } from "vitest";

import { buildTopicCreate, buildTopicMessageSubmit, encodeMessage } from "../../../src/hedera/ops/topics";
import { offlineHederaContext } from "../../helpers/hedera";

const hedera = offlineHederaContext();
afterAll(() => hedera.client.close());

describe("buildTopicCreate()", () => {
  it("sets memo and keys from the params", () => {
    const tx = buildTopicCreate(hedera, { memo: "launch log", adminKey: true, submitKey: true });
    const operator = hedera.operatorPublicKey.toString();
    expect(tx.topicMemo).toBe("launch log");
    expect(tx.adminKey?.toString()).toBe(operator);
    expect(tx.submitKey?.toString()).toBe(operator);
  });

  it("creates a public, immutable topic when both keys are off", () => {
    const tx = buildTopicCreate(hedera, { adminKey: false, submitKey: false });
    expect(tx.adminKey).toBeNull();
    expect(tx.submitKey).toBeNull();
  });
});

describe("buildTopicMessageSubmit()", () => {
  it("sends strings verbatim and JSON-encodes objects", () => {
    expect(encodeMessage("hi")).toBe("hi");
    expect(encodeMessage({ event: "launch", tokenId: "0.0.9" })).toBe('{"event":"launch","tokenId":"0.0.9"}');
    const tx = buildTopicMessageSubmit({ topicId: "0.0.3", message: { a: 1 }, maxChunks: 1 });
    expect(Buffer.from(tx.message as Uint8Array).toString()).toBe('{"a":1}');
    expect(tx.topicId?.toString()).toBe("0.0.3");
    expect(tx.maxChunks).toBe(1);
  });

  it("rejects empty messages and messages beyond the chunk budget", () => {
    expect(() => buildTopicMessageSubmit({ topicId: "0.0.3", message: "", maxChunks: 1 })).toThrow(/not be empty/);
    expect(() => buildTopicMessageSubmit({ topicId: "0.0.3", message: "x".repeat(1025), maxChunks: 1 })).toThrow(
      /1025 bytes but maxChunks=1 allows 1024/,
    );
    expect(() => buildTopicMessageSubmit({ topicId: "0.0.3", message: "x".repeat(1025), maxChunks: 2 })).not.toThrow();
  });
});
