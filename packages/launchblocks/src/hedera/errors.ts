import { PrecheckStatusError, ReceiptStatusError, StatusError } from "@hiero-ledger/sdk";

import { LaunchBlocksError } from "../errors";

/**
 * A failed Hedera call, translated into something a user can act on.
 * `code` is `HEDERA_<STATUS>` for consensus/precheck failures so the UI can
 * link to docs, and `HEDERA_ERROR` for transport problems.
 */
export class HederaError extends LaunchBlocksError {
  readonly status: string | undefined;
  readonly transactionId: string | undefined;

  constructor(args: { message: string; status?: string; transactionId?: string; hint?: string; cause?: unknown }) {
    super(args.status ? `HEDERA_${args.status}` : "HEDERA_ERROR", args.message, {
      cause: args.cause,
      ...(args.hint ? { hint: args.hint } : {}),
    });
    this.status = args.status;
    this.transactionId = args.transactionId;
  }
}

const FAUCET = "https://portal.hedera.com/faucet";

/** Remediation per response code. Only statuses a template user can fix are listed. */
export const STATUS_HINTS: Readonly<Record<string, string>> = {
  INSUFFICIENT_PAYER_BALANCE: `The operator account cannot pay the fee. Fund it at ${FAUCET} (testnet).`,
  INSUFFICIENT_ACCOUNT_BALANCE: `The operator account balance is too low. Fund it at ${FAUCET} (testnet).`,
  INSUFFICIENT_TX_FEE: "The transaction fee was too low; retry or raise the max transaction fee.",
  INVALID_SIGNATURE:
    "A required signature is missing: HEDERA_OPERATOR_KEY must match HEDERA_OPERATOR_ID, and treasury/admin/supply keys must be the operator's.",
  INVALID_ACCOUNT_ID: "Check the account id: it must exist on the selected network.",
  INVALID_TOKEN_ID: "Check the token id: it must exist on the selected network.",
  INVALID_TOPIC_ID: "Check the topic id: it must exist on the selected network.",
  TOKEN_NOT_ASSOCIATED_TO_ACCOUNT:
    "The receiving account has not associated this token. Use hts.airdrop (no association needed) or associate first.",
  TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT: "The account already holds this token; remove the associate step.",
  INSUFFICIENT_TOKEN_BALANCE: "The treasury does not hold enough tokens. Mint more or lower the amount.",
  TOKEN_HAS_NO_SUPPLY_KEY: "Minting needs a supply key. Recreate the token with supplyKey enabled.",
  TOKEN_MAX_SUPPLY_REACHED: "The token's max supply is exhausted; raise maxSupply or mint less.",
  TOKEN_IS_IMMUTABLE: "The token has no admin key, so it cannot be updated.",
  INVALID_TOKEN_INITIAL_SUPPLY: "Initial supply must fit the token's decimals and the 2^63-1 unit limit.",
  INVALID_TOKEN_DECIMALS: "Decimals must be between 0 and 18 for this template.",
  INVALID_TOKEN_MAX_SUPPLY: "maxSupply must be at least the initial supply and fit in 2^63-1 units.",
  MISSING_TOKEN_SYMBOL: "Token symbol is required.",
  MISSING_TOKEN_NAME: "Token name is required.",
  TOKEN_SYMBOL_TOO_LONG: "Token symbol must be at most 100 bytes.",
  TOKEN_NAME_TOO_LONG: "Token name must be at most 100 bytes.",
  MEMO_TOO_LONG: "Memos must be at most 100 bytes.",
  MESSAGE_SIZE_TOO_LARGE:
    "Topic messages must be at most 1024 bytes per chunk; enable chunking or shorten the message.",
  UNAUTHORIZED: "The topic has a submit key that is not the operator's.",
  TRANSACTION_EXPIRED: "The transaction expired before consensus. Check the machine clock and retry.",
  BUSY: "The network node is busy; retry in a few seconds.",
  PLATFORM_TRANSACTION_NOT_CREATED: "The node could not accept the transaction; retry.",
  DUPLICATE_TRANSACTION: "This transaction id was already submitted; retry with a fresh run.",
  PAYER_ACCOUNT_NOT_FOUND: "HEDERA_OPERATOR_ID does not exist on the selected network.",
  MAX_CUSTOM_FEES_LIMIT_EXCEEDED: "Too many custom fees; HTS allows at most 10 per token.",
  CUSTOM_FEE_MUST_BE_POSITIVE: "Custom fee amounts must be positive.",
  FRACTION_DIVIDES_BY_ZERO: "Fractional fee denominator must be greater than zero.",
  INVALID_CUSTOM_FEE_COLLECTOR: "The fee collector account must exist and, for HTS fee tokens, be associated.",
};

/** Wrap any error thrown by the SDK into a {@link HederaError} with a hint. Idempotent. */
export function translateHederaError(error: unknown, context: string): HederaError {
  if (error instanceof HederaError) return error;

  const status = statusOf(error);
  if (status) {
    const transactionId = transactionIdOf(error);
    const hint = STATUS_HINTS[status];
    return new HederaError({
      message: `${context}: ${status}${transactionId ? ` (transaction ${transactionId})` : ""}`,
      status,
      ...(transactionId ? { transactionId } : {}),
      ...(hint ? { hint } : {}),
      cause: error,
    });
  }

  const message = error instanceof Error ? error.message : String(error);
  const isNetwork = /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|UNAVAILABLE|DEADLINE_EXCEEDED|network/i.test(
    message,
  );
  return new HederaError({
    message: `${context}: ${message}`,
    ...(isNetwork
      ? { hint: "Could not reach the Hedera network. Check connectivity, HEDERA_NETWORK and any proxy." }
      : {}),
    cause: error,
  });
}

function statusOf(error: unknown): string | undefined {
  if (error instanceof ReceiptStatusError || error instanceof PrecheckStatusError || error instanceof StatusError) {
    return error.status.toString();
  }
  // Some SDK paths throw plain errors that still carry a status object.
  const status = (error as { status?: { toString(): string } } | null)?.status;
  return status && typeof status.toString === "function" && /^[A-Z_]+$/.test(status.toString())
    ? status.toString()
    : undefined;
}

function transactionIdOf(error: unknown): string | undefined {
  const id = (error as { transactionId?: { toString(): string } } | null)?.transactionId;
  return id ? id.toString() : undefined;
}
