import type { Long } from "@hiero-ledger/sdk";
import { CustomFixedFee, CustomFractionalFee } from "@hiero-ledger/sdk";
import { afterAll, describe, expect, it } from "vitest";

import type { CreateFungibleTokenParams, TokenKeys } from "../../../src/hedera/ops/tokens";
import {
  buildTokenAirdrop,
  buildTokenAssociate,
  buildTokenCreate,
  buildTokenMint,
  buildTokenTransfer,
} from "../../../src/hedera/ops/tokens";
import { offlineHederaContext } from "../../helpers/hedera";

const hedera = offlineHederaContext();
afterAll(() => hedera.client.close());

const noKeys: TokenKeys = {
  admin: false,
  supply: false,
  freeze: false,
  wipe: false,
  pause: false,
  kyc: false,
  feeSchedule: false,
};

const base: CreateFungibleTokenParams = {
  name: "LaunchBlocks Demo",
  symbol: "LBD",
  decimals: 6,
  initialSupply: "1000000",
  supplyType: "infinite",
  keys: { ...noKeys, admin: true, supply: true },
};

/** Transfers as [accountId, amount] pairs, reading the SDK's internal list. */
function transfersOf(tx: { _tokenTransfers: { tokenId: unknown; accountId: unknown; amount: Long }[] }) {
  return tx._tokenTransfers.map(t => [String(t.tokenId), String(t.accountId), t.amount.toString()]);
}

describe("buildTokenCreate()", () => {
  it("maps the basics onto the SDK transaction with the operator as treasury", () => {
    const tx = buildTokenCreate(hedera, base);
    expect(tx.tokenName).toBe("LaunchBlocks Demo");
    expect(tx.tokenSymbol).toBe("LBD");
    expect(Number(tx.decimals)).toBe(6);
    expect(tx.initialSupply?.toString()).toBe("1000000000000");
    expect(tx.treasuryAccountId?.toString()).toBe("0.0.4242");
    expect(String(tx.tokenType)).toBe("FUNGIBLE_COMMON");
    expect(String(tx.supplyType)).toBe("INFINITE");
    expect(tx.freezeDefault).toBe(false);
  });

  it("sets only the enabled keys, all to the operator's public key", () => {
    const tx = buildTokenCreate(hedera, { ...base, keys: { ...noKeys, supply: true, freeze: true } });
    const operator = hedera.operatorPublicKey.toString();
    expect(tx.supplyKey?.toString()).toBe(operator);
    expect(tx.freezeKey?.toString()).toBe(operator);
    expect(tx.adminKey).toBeNull();
    expect(tx.wipeKey).toBeNull();
    expect(tx.pauseKey).toBeNull();
    expect(tx.kycKey).toBeNull();
    expect(tx.feeScheduleKey).toBeNull();
  });

  it("supports finite supply with a max in whole tokens", () => {
    const tx = buildTokenCreate(hedera, { ...base, supplyType: "finite", maxSupply: "5000000" });
    expect(String(tx.supplyType)).toBe("FINITE");
    expect(tx.maxSupply?.toString()).toBe("5000000000000");
  });

  it("rejects finite supply without or below the initial supply", () => {
    expect(() => buildTokenCreate(hedera, { ...base, supplyType: "finite" })).toThrow(/needs maxSupply/);
    expect(() => buildTokenCreate(hedera, { ...base, supplyType: "finite", maxSupply: "1" })).toThrow(
      /at least initialSupply/,
    );
  });

  it("handles supplies beyond Number.MAX_SAFE_INTEGER units", () => {
    const tx = buildTokenCreate(hedera, { ...base, decimals: 8, initialSupply: "50000000000" });
    expect(tx.initialSupply?.toString()).toBe("5000000000000000000");
  });

  it("adds a fractional fee collected by the operator by default", () => {
    const tx = buildTokenCreate(hedera, {
      ...base,
      fractionalFee: { numerator: 1, denominator: 100, min: "0.5", max: "10", assessment: "exclusive" },
    });
    expect(tx.customFees).toHaveLength(1);
    const fee = tx.customFees[0] as CustomFractionalFee;
    expect(fee).toBeInstanceOf(CustomFractionalFee);
    expect(fee.numerator?.toString()).toBe("1");
    expect(fee.denominator?.toString()).toBe("100");
    expect(fee.min?.toString()).toBe("500000");
    expect(fee.max?.toString()).toBe("10000000");
    expect(String(fee.assessmentMethod)).toBe("EXCLUSIVE");
    expect(fee.feeCollectorAccountId?.toString()).toBe("0.0.4242");
  });

  it("adds a fixed HBAR fee with a custom collector", () => {
    const tx = buildTokenCreate(hedera, { ...base, fixedHbarFee: { amountHbar: "0.1", collectorAccountId: "0.0.77" } });
    const fee = tx.customFees[0] as CustomFixedFee;
    expect(fee).toBeInstanceOf(CustomFixedFee);
    expect(fee.hbarAmount?.toString()).toBe("0.1 ℏ");
    expect(fee.feeCollectorAccountId?.toString()).toBe("0.0.77");
  });

  it("rejects non-positive fractional fees", () => {
    expect(() =>
      buildTokenCreate(hedera, { ...base, fractionalFee: { numerator: 0, denominator: 100, assessment: "inclusive" } }),
    ).toThrow(/positive/);
  });

  it("sets the memo when given", () => {
    expect(buildTokenCreate(hedera, { ...base, memo: "launch #1" }).tokenMemo).toBe("launch #1");
    expect(buildTokenCreate(hedera, base).tokenMemo).toBeNull();
  });
});

describe("buildTokenMint()", () => {
  it("scales the amount by the token's decimals", () => {
    const tx = buildTokenMint({ tokenId: "0.0.9", amount: "12.5" }, 2);
    expect(tx.tokenId?.toString()).toBe("0.0.9");
    expect(tx.amount?.toString()).toBe("1250");
  });
});

describe("buildTokenTransfer()", () => {
  it("debits the operator and credits the recipient by the same units", () => {
    const tx = buildTokenTransfer(hedera, { tokenId: "0.0.9", to: "0.0.55", amount: "3", memo: "gift" }, 4);
    expect(transfersOf(tx as never)).toEqual([
      ["0.0.9", "0.0.4242", "-30000"],
      ["0.0.9", "0.0.55", "30000"],
    ]);
    expect(tx.transactionMemo).toBe("gift");
  });

  it("accepts EVM addresses as recipients", () => {
    const tx = buildTokenTransfer(
      hedera,
      { tokenId: "0.0.9", to: "0x00000000000000000000000000000000000000ab", amount: 1 },
      0,
    );
    expect(transfersOf(tx as never)[1]?.[1]).toMatch(/ab$/);
  });
});

describe("buildTokenAirdrop()", () => {
  it("credits every recipient and debits the operator by the total", () => {
    const tx = buildTokenAirdrop(
      hedera,
      {
        tokenId: "0.0.9",
        recipients: [
          { accountId: "0.0.1", amount: "1" },
          { accountId: "0.0.2", amount: "2.5" },
        ],
      },
      2,
    );
    expect(transfersOf(tx as never)).toEqual([
      ["0.0.9", "0.0.1", "100"],
      ["0.0.9", "0.0.2", "250"],
      ["0.0.9", "0.0.4242", "-350"],
    ]);
  });

  it("rejects empty, oversized and zero-amount airdrops", () => {
    expect(() => buildTokenAirdrop(hedera, { tokenId: "0.0.9", recipients: [] }, 2)).toThrow(/at least one/);
    // With the sender's debit, ten recipients would be eleven transfers.
    const ten = Array.from({ length: 10 }, (_, i) => ({ accountId: `0.0.${i + 1}`, amount: 1 }));
    expect(() => buildTokenAirdrop(hedera, { tokenId: "0.0.9", recipients: ten }, 2)).toThrow(/at most 9/);
    expect(() =>
      buildTokenAirdrop(hedera, { tokenId: "0.0.9", recipients: [{ accountId: "0.0.1", amount: 0 }] }, 2),
    ).toThrow(/positive/);
  });
});

describe("buildTokenAssociate()", () => {
  it("associates the operator with the token", () => {
    const tx = buildTokenAssociate(hedera, "0.0.9");
    expect(tx.accountId?.toString()).toBe("0.0.4242");
    expect(tx.tokenIds?.map(String)).toEqual(["0.0.9"]);
  });
});
