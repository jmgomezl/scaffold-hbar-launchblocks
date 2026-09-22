import { PrivateKey } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";

import { createHederaContext, hederaContextFromEnv, parseNetwork, parsePrivateKey } from "../../src/hedera/client";

const ed25519 = PrivateKey.generateED25519();
const ecdsa = PrivateKey.generateECDSA();

describe("parsePrivateKey()", () => {
  it("accepts DER-encoded keys of either curve without a type hint", () => {
    expect(parsePrivateKey(ed25519.toStringDer()).toStringDer()).toBe(ed25519.toStringDer());
    expect(parsePrivateKey(ecdsa.toStringDer()).toStringDer()).toBe(ecdsa.toStringDer());
  });

  it("accepts raw hex keys when the curve is given", () => {
    expect(parsePrivateKey(ed25519.toStringRaw(), "ed25519").toStringDer()).toBe(ed25519.toStringDer());
    expect(parsePrivateKey(`0x${ecdsa.toStringRaw()}`, "ecdsa").toStringDer()).toBe(ecdsa.toStringDer());
  });

  it("explains how to fix an unparsable key", () => {
    expect(() => parsePrivateKey("not-a-key")).toThrow(/HEDERA_OPERATOR_KEY_TYPE/);
    expect(() => parsePrivateKey("not-a-key", "ecdsa")).toThrow(/valid ecdsa private key/);
  });
});

describe("parseNetwork()", () => {
  it("defaults to testnet and normalizes case", () => {
    expect(parseNetwork(undefined)).toBe("testnet");
    expect(parseNetwork("")).toBe("testnet");
    expect(parseNetwork("MainNet")).toBe("mainnet");
  });

  it("rejects unknown networks", () => {
    expect(() => parseNetwork("previewnet")).toThrow(/testnet, mainnet, localnet/);
  });
});

describe("createHederaContext()", () => {
  it("builds a client with the operator set and a normalized mirror URL", () => {
    const ctx = createHederaContext({
      network: "testnet",
      operatorId: "0.0.1234",
      operatorKey: ed25519.toStringDer(),
      mirrorBaseUrl: "https://example.test/",
    });
    try {
      expect(ctx.operatorId.toString()).toBe("0.0.1234");
      expect(ctx.client.operatorAccountId?.toString()).toBe("0.0.1234");
      expect(ctx.mirrorBaseUrl).toBe("https://example.test");
    } finally {
      ctx.client.close();
    }
  });

  it("defaults the mirror URL per network", () => {
    const ctx = createHederaContext({ network: "mainnet", operatorId: "0.0.5", operatorKey: ecdsa.toStringDer() });
    try {
      expect(ctx.mirrorBaseUrl).toBe("https://mainnet.mirrornode.hedera.com");
    } finally {
      ctx.client.close();
    }
  });

  it("rejects malformed account ids", () => {
    expect(() =>
      createHederaContext({ network: "testnet", operatorId: "abc", operatorKey: ed25519.toStringDer() }),
    ).toThrow(/not a valid account id/);
  });
});

describe("hederaContextFromEnv()", () => {
  it("reads the operator from the documented variables", () => {
    const ctx = hederaContextFromEnv({
      HEDERA_NETWORK: "testnet",
      HEDERA_OPERATOR_ID: "0.0.99",
      HEDERA_OPERATOR_KEY: ecdsa.toStringRaw(),
      HEDERA_OPERATOR_KEY_TYPE: "ecdsa",
    });
    try {
      expect(ctx.network).toBe("testnet");
      expect(ctx.operatorId.toString()).toBe("0.0.99");
    } finally {
      ctx.client.close();
    }
  });

  it("lets explicit overrides win over the environment", () => {
    const ctx = hederaContextFromEnv(
      { HEDERA_NETWORK: "mainnet", HEDERA_OPERATOR_ID: "0.0.1", HEDERA_OPERATOR_KEY: ed25519.toStringDer() },
      { network: "testnet" },
    );
    try {
      expect(ctx.network).toBe("testnet");
    } finally {
      ctx.client.close();
    }
  });

  it("fails with a faucet hint when the operator is missing", () => {
    expect(() => hederaContextFromEnv({})).toThrow(/portal\.hedera\.com/);
    expect(() => hederaContextFromEnv({})).toThrow(/HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY/);
  });

  it("rejects an invalid key type variable", () => {
    expect(() =>
      hederaContextFromEnv({ HEDERA_OPERATOR_ID: "0.0.1", HEDERA_OPERATOR_KEY: "x", HEDERA_OPERATOR_KEY_TYPE: "rsa" }),
    ).toThrow(/ed25519 or ecdsa/);
  });
});
