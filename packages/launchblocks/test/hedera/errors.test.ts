import { AccountId, PrecheckStatusError, ReceiptStatusError, Status, TransactionId } from "@hiero-ledger/sdk";
import { describe, expect, it } from "vitest";

import { HederaError, STATUS_HINTS, translateHederaError } from "../../src/hedera/errors";

const txId = TransactionId.fromString("0.0.1234@1700000000.000000001");

describe("translateHederaError()", () => {
  it("maps receipt status errors to a coded error with a hint", () => {
    const sdkError = new ReceiptStatusError({
      status: Status.InsufficientPayerBalance,
      transactionId: txId,
      transactionReceipt: {} as never,
    });
    const error = translateHederaError(sdkError, "Creating token");
    expect(error).toBeInstanceOf(HederaError);
    expect(error.code).toBe("HEDERA_INSUFFICIENT_PAYER_BALANCE");
    expect(error.status).toBe("INSUFFICIENT_PAYER_BALANCE");
    expect(error.transactionId).toBe(txId.toString());
    expect(error.message).toBe(`Creating token: INSUFFICIENT_PAYER_BALANCE (transaction ${txId.toString()})`);
    expect(error.hint).toBe(STATUS_HINTS.INSUFFICIENT_PAYER_BALANCE);
    expect(error.cause).toBe(sdkError);
  });

  it("maps precheck status errors", () => {
    const sdkError = new PrecheckStatusError({
      status: Status.InvalidSignature,
      transactionId: txId,
      contractFunctionResult: null,
      nodeId: new AccountId(3),
    });
    const error = translateHederaError(sdkError, "Minting");
    expect(error.code).toBe("HEDERA_INVALID_SIGNATURE");
    expect(error.hint).toMatch(/HEDERA_OPERATOR_KEY/);
  });

  it("leaves statuses without a curated hint hint-less", () => {
    const sdkError = new ReceiptStatusError({
      status: Status.InvalidTransactionBody,
      transactionId: txId,
      transactionReceipt: {} as never,
    });
    expect(translateHederaError(sdkError, "x").hint).toBeUndefined();
  });

  it("recognizes network failures", () => {
    const error = translateHederaError(new Error("fetch failed: ECONNREFUSED"), "Submitting message");
    expect(error.code).toBe("HEDERA_ERROR");
    expect(error.hint).toMatch(/Could not reach the Hedera network/);
  });

  it("wraps unknown errors and is idempotent", () => {
    const error = translateHederaError("boom", "Doing thing");
    expect(error.message).toBe("Doing thing: boom");
    expect(error.hint).toBeUndefined();
    expect(translateHederaError(error, "again")).toBe(error);
  });
});
