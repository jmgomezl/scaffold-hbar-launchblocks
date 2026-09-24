import { PrecheckStatusError, ReceiptStatusError, Status, StatusError } from "@hiero-ledger/sdk";

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
  TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT:
    "The account has already associated this token, so it needs no association here. The Associate token step counts this as done.",
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

/** Hints that name the wallet account rather than the operator. */
const WALLET_STATUS_HINTS: Readonly<Record<string, string>> = {
  INSUFFICIENT_PAYER_BALANCE: `Your wallet account cannot pay the fee. Fund it at ${FAUCET} (testnet).`,
  INSUFFICIENT_ACCOUNT_BALANCE: `Your wallet account's balance is too low. Fund it at ${FAUCET} (testnet).`,
};

let statusNames: ReadonlySet<string> | null = null;
function isStatusName(name: string): boolean {
  statusNames ??= new Set(
    Object.values(Status)
      .filter((value): value is Status => value instanceof Status)
      .map(String),
  );
  return statusNames.has(name);
}

/**
 * The wallet's own words for a failed request. hedera-wallet-connect's
 * DAppSigner reports one as an Error whose message is JSON holding the
 * transaction attempt's error, the error of a query it retries the request
 * as, and both stacks; wallets themselves reject with plain `{ code, message }`
 * objects.
 */
function walletMessage(error: unknown): string {
  const text =
    error instanceof Error
      ? error.message
      : typeof (error as { message?: unknown } | null)?.message === "string"
        ? (error as { message: string }).message
        : String(error);
  const start = text.indexOf("{");
  if (start < 0) return text;
  try {
    const report = JSON.parse(text.slice(start)) as {
      txError?: { message?: string };
      queryError?: { message?: string };
    };
    return report.txError?.message ?? report.queryError?.message ?? "the wallet did not send the transaction";
  } catch {
    return text;
  }
}

/**
 * A wallet's refusal or failure to send a transaction: declined by the user,
 * a lost session, or a status the network returned to the wallet.
 */
export function translateWalletError(error: unknown, context: string): LaunchBlocksError {
  const message = walletMessage(error);
  if (/reject|declin|denied|cancel/i.test(message)) {
    return new LaunchBlocksError("WALLET_REJECTED", `${context}: declined in the wallet`, {
      hint: "Run again and approve each transaction, or switch back to the default account.",
      cause: error,
    });
  }
  if (/session/i.test(message)) {
    return new LaunchBlocksError("WALLET_DISCONNECTED", `${context}: ${message}`, {
      hint: "Reconnect your wallet in the Run panel and run again.",
      cause: error,
    });
  }
  const status = message.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g)?.find(isStatusName);
  if (status) {
    const hint = WALLET_STATUS_HINTS[status] ?? STATUS_HINTS[status];
    return new HederaError({
      message: `${context}: ${status}`,
      status,
      ...(hint ? { hint } : {}),
      cause: error,
    });
  }
  return new HederaError({ message: `${context}: ${message}`, cause: error });
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
