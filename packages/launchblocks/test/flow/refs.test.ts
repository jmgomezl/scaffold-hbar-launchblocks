import { describe, expect, it } from "vitest";

import { RefResolutionError } from "../../src/errors";
import { findRefs, parseRef, ref, resolveRefs } from "../../src/flow/refs";

const outputs = {
  createToken: { tokenId: "0.0.12345", decimals: 8, transactionId: "0.0.1@1.2" },
  createTopic: { topicId: "0.0.777" },
};

describe("ref()", () => {
  it("builds the canonical reference string", () => {
    expect(ref("createToken", "tokenId")).toBe("{{steps.createToken.tokenId}}");
  });
});

describe("parseRef()", () => {
  it("parses a whole-string reference", () => {
    expect(parseRef("{{steps.createToken.tokenId}}")).toEqual({
      stepId: "createToken",
      key: "tokenId",
      raw: "{{steps.createToken.tokenId}}",
    });
  });

  it("tolerates inner whitespace", () => {
    expect(parseRef("{{ steps.createToken.tokenId }}")?.key).toBe("tokenId");
  });

  it("returns null for interpolated strings and non-strings", () => {
    expect(parseRef("Token {{steps.createToken.tokenId}}")).toBeNull();
    expect(parseRef(42)).toBeNull();
    expect(parseRef(null)).toBeNull();
  });

  it("returns null for malformed references", () => {
    expect(parseRef("{{steps.createToken}}")).toBeNull();
    expect(parseRef("{{outputs.createToken.tokenId}}")).toBeNull();
    expect(parseRef("{{steps.CreateToken.tokenId}}")).toBeNull();
  });
});

describe("findRefs()", () => {
  it("finds references nested in objects, arrays and interpolated strings", () => {
    const refs = findRefs({
      tokenId: "{{steps.createToken.tokenId}}",
      memo: "Launched {{steps.createToken.tokenId}} on topic {{steps.createTopic.topicId}}",
      accounts: ["0.0.1", "{{steps.createTopic.topicId}}"],
      amount: 5,
    });
    expect(refs.map(r => `${r.stepId}.${r.key}`)).toEqual([
      "createToken.tokenId",
      "createToken.tokenId",
      "createTopic.topicId",
      "createTopic.topicId",
    ]);
  });

  it("returns an empty list when there is nothing to resolve", () => {
    expect(findRefs({ a: 1, b: "plain", c: [true] })).toEqual([]);
  });
});

describe("resolveRefs()", () => {
  it("keeps the original type for whole-string references", () => {
    expect(resolveRefs({ decimals: "{{steps.createToken.decimals}}" }, outputs)).toEqual({ decimals: 8 });
  });

  it("interpolates references inside longer strings", () => {
    expect(resolveRefs("Token {{steps.createToken.tokenId}} / topic {{ steps.createTopic.topicId }}", outputs)).toBe(
      "Token 0.0.12345 / topic 0.0.777",
    );
  });

  it("resolves recursively through arrays and objects without mutating the input", () => {
    const params = { nested: { ids: ["{{steps.createToken.tokenId}}", "0.0.2"] }, keep: 1 };
    const resolved = resolveRefs(params, outputs);
    expect(resolved).toEqual({ nested: { ids: ["0.0.12345", "0.0.2"] }, keep: 1 });
    expect(params.nested.ids[0]).toBe("{{steps.createToken.tokenId}}");
  });

  it("throws a RefResolutionError naming the missing step", () => {
    expect(() => resolveRefs("{{steps.missing.tokenId}}", outputs)).toThrowError(RefResolutionError);
    expect(() => resolveRefs("{{steps.missing.tokenId}}", outputs)).toThrow(/step "missing" has not produced/);
  });

  it("throws a RefResolutionError listing available keys for a missing output", () => {
    expect(() => resolveRefs("{{steps.createTopic.tokenId}}", outputs)).toThrow(/available: topicId/);
  });

  it("leaves non-reference values untouched", () => {
    expect(resolveRefs({ a: 1, b: null, c: "text", d: [true] }, outputs)).toEqual({
      a: 1,
      b: null,
      c: "text",
      d: [true],
    });
  });
});
