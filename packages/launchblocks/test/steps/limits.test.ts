import { describe, expect, it } from "vitest";

import { createDefaultRegistry } from "../../src/steps";

/**
 * Flows that used to validate and then fail on the network, usually after an
 * earlier step had already been paid for. Each must now fail validation.
 */
const registry = createDefaultRegistry();

const flow = (steps: unknown[]) => ({ schemaVersion: 1, id: "limits", name: "Limits", steps });
const token = (params: Record<string, unknown> = {}) => ({
  id: "createToken",
  type: "hts.createToken",
  params: { name: "Demo", symbol: "DMO", ...params },
});
const issues = (...steps: unknown[]) =>
  registry.checkFlow(flow(steps)).issues.map(issue => `${issue.path}: ${issue.message}`);

describe("amounts a token cannot hold", () => {
  it("refuses a supply HTS cannot store, or more decimal places than the token has", () => {
    expect(issues(token({ decimals: 18 }))).toEqual([
      expect.stringMatching(/^steps\[0\]\.params\.initialSupply: .*exceeds/),
    ]);
    expect(issues(token({ decimals: 2, initialSupply: "1.001" }))).toEqual([
      expect.stringMatching(/^steps\[0\]\.params\.initialSupply: .*3 fractional digits but the token has 2 decimals/),
    ]);
  });

  it("refuses a finite maximum of zero or below the initial supply", () => {
    expect(issues(token({ supplyType: "finite", maxSupply: "0" }))).toEqual([
      "steps[0].params.maxSupply: a finite supply needs a maximum above zero",
    ]);
    expect(issues(token({ supplyType: "finite", maxSupply: "10", initialSupply: "11" }))).toEqual([
      "steps[0].params.maxSupply: maxSupply is below the initial supply",
    ]);
  });

  it("refuses custom fees Hedera would reject after charging for the token", () => {
    expect(issues(token({ fixedHbarFee: { amountHbar: "0" } }))).toEqual([
      "steps[0].params.fixedHbarFee.amountHbar: amount must be greater than zero",
    ]);
    expect(issues(token({ fixedHbarFee: { amountHbar: "0.123456789" } }))).toEqual([
      "steps[0].params.fixedHbarFee.amountHbar: HBAR has 8 decimal places (1 tinybar = 0.00000001)",
    ]);
    expect(issues(token({ fractionalFee: { numerator: 1, denominator: 100, min: "5", max: "1" } }))).toEqual([
      "steps[0].params.fractionalFee.min: the fee's minimum is above its maximum",
    ]);
  });
});

describe("text Hedera measures in bytes", () => {
  it("refuses a memo or name over 100 bytes, even under 100 characters, and a NUL", () => {
    expect(issues(token({ memo: "é".repeat(90) }))).toEqual([
      expect.stringMatching(/^steps\[0\]\.params\.memo: a memo is limited to 100 bytes/),
    ]);
    expect(issues(token({ name: "🚀".repeat(30) }))).toEqual([
      expect.stringMatching(/^steps\[0\]\.params\.name: a token name is limited to 100 bytes/),
    ]);
    expect(issues(token({ symbol: "A\u0000B" }))).toEqual([
      "steps[0].params.symbol: a token symbol cannot contain a NUL character",
    ]);
  });

  it("refuses a message longer than its chunks allow", () => {
    const log = { id: "log", type: "hcs.createTopic", params: {} };
    const note = {
      id: "note",
      type: "hcs.submitMessage",
      params: { topicId: "{{steps.log.topicId}}", message: "x".repeat(2000), maxChunks: 1 },
    };
    expect(issues(log, note)).toEqual(["steps[1].params.message: the message is longer than maxChunks × 1024 bytes"]);
  });
});

describe("HBAR amounts", () => {
  it("refuses more than 8 decimal places wherever HBAR is sent", () => {
    const pool = {
      id: "pool",
      type: "saucerswap.createPool",
      params: { tokenId: "{{steps.createToken.tokenId}}", tokenAmount: "10", hbarAmount: "10.123456789" },
    };
    expect(issues(token(), pool)).toEqual([
      "steps[1].params.hbarAmount: HBAR has 8 decimal places (1 tinybar = 0.00000001)",
    ]);
  });
});

describe("amounts of a token the flow creates", () => {
  const mint = (amount: string) => ({
    id: "mint",
    type: "hts.mint",
    params: { tokenId: "{{steps.createToken.tokenId}}", amount },
  });

  it("refuses a mint more precise than the token, before the token is paid for", () => {
    expect(issues(token({ decimals: 2 }), mint("0.001"))).toEqual([
      expect.stringMatching(
        /^steps\[1\]\.params\.amount: .*3 fractional digits but the token has 2 decimals \(the token createToken creates\)$/,
      ),
    ]);
    expect(issues(token({ decimals: 2 }), mint("0.01"))).toEqual([]);
  });

  it("refuses a mint of a token created without a supply key", () => {
    expect(issues(token({ keys: { supply: false } }), mint("1"))).toEqual([
      "steps[1].params.tokenId: createToken creates its token without a supply key, so nothing can mint it",
    ]);
  });

  it("checks each airdrop recipient's amount", () => {
    const airdrop = {
      id: "airdrop",
      type: "hts.airdrop",
      params: {
        tokenId: "{{steps.createToken.tokenId}}",
        recipients: [
          { accountId: "0.0.5", amount: "1" },
          { accountId: "0.0.6", amount: "1.5" },
        ],
      },
    };
    expect(issues(token({ decimals: 0 }), airdrop)).toEqual([
      expect.stringMatching(/^steps\[1\]\.params\.recipients\[1\]\.amount: /),
    ]);
  });
});
