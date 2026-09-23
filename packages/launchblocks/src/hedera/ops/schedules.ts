import type { Transaction } from "@hiero-ledger/sdk";
import { ScheduleCreateTransaction, Timestamp } from "@hiero-ledger/sdk";

import { LaunchBlocksError } from "../../errors";
import type { DecimalAmount } from "../amounts";
import { toUnits } from "../amounts";
import type { HederaContext } from "../context";
import { submit } from "./submit";
import { buildTokenMint, buildTokenTransfer, getTokenInfo } from "./tokens";

/**
 * Scheduled transactions (Hedera Schedule Service). The inner transaction is
 * wrapped in a ScheduleCreate with an expiration time and `waitForExpiry`
 * (HIP-423 long-term schedules), so the network executes it at that time
 * without anyone online. The operator's signature on the ScheduleCreate also
 * counts for the inner transaction, so for the operator's own transfers and
 * mints the schedule is complete when it is created.
 */

/** HIP-423 caps how far ahead a schedule may expire: 62 days on testnet and mainnet. */
export const MAX_SCHEDULE_DELAY_SECONDS = 62 * 24 * 60 * 60;

export type ScheduleOptions = {
  /** Seconds from now until the network executes it. */
  delaySeconds: number;
  memo?: string | undefined;
  /** Give the schedule the operator's key as admin key, so it can be deleted before it runs. */
  adminKey?: boolean | undefined;
};

export type ScheduleResult = {
  scheduleId: string;
  /** The id the inner transaction will carry when it executes. */
  scheduledTransactionId: string;
  /** ISO time the network executes it. */
  executesAt: string;
  transactionId: string;
};

export function buildSchedule(
  hedera: HederaContext,
  inner: Transaction,
  options: ScheduleOptions,
  now: number = Date.now(),
): { transaction: ScheduleCreateTransaction; executesAt: Date } {
  if (!Number.isInteger(options.delaySeconds) || options.delaySeconds < 1) {
    throw new LaunchBlocksError("SCHEDULE_DELAY_INVALID", "A schedule must run at least one second from now");
  }
  if (options.delaySeconds > MAX_SCHEDULE_DELAY_SECONDS) {
    throw new LaunchBlocksError("SCHEDULE_TOO_FAR", "Schedules can run at most 62 days ahead", {
      hint: "For longer vesting, schedule each tranche within 62 days of the run, or lock the tokens in a contract.",
    });
  }
  const executesAt = new Date(now + options.delaySeconds * 1000);
  const transaction = new ScheduleCreateTransaction()
    .setScheduledTransaction(inner)
    .setExpirationTime(Timestamp.fromDate(executesAt))
    .setWaitForExpiry(true);
  if (options.memo) transaction.setScheduleMemo(options.memo);
  if (options.adminKey) transaction.setAdminKey(hedera.operatorKey.publicKey);
  return { transaction, executesAt };
}

async function submitSchedule(
  hedera: HederaContext,
  inner: Transaction,
  options: ScheduleOptions,
  context: string,
): Promise<ScheduleResult> {
  const { transaction, executesAt } = buildSchedule(hedera, inner, options);
  return submit(hedera.client, transaction, context, (receipt, response) => {
    if (!receipt.scheduleId || !receipt.scheduledTransactionId) {
      throw new LaunchBlocksError("RECEIPT_INCOMPLETE", "The schedule was created but the receipt has no schedule id");
    }
    return {
      scheduleId: receipt.scheduleId.toString(),
      scheduledTransactionId: receipt.scheduledTransactionId.toString(),
      executesAt: executesAt.toISOString(),
      transactionId: response.transactionId.toString(),
    };
  });
}

export type ScheduleTransferParams = ScheduleOptions & { tokenId: string; to: string; amount: DecimalAmount };
export type ScheduleTransferResult = ScheduleResult & { tokenId: string; to: string; amountUnits: string };

/**
 * Schedule a token transfer from the operator (the treasury) to `to`, for
 * vesting and unlocks. The recipient must be associated with the token, or
 * have a free association slot, when it runs.
 */
export async function scheduleTokenTransfer(
  hedera: HederaContext,
  params: ScheduleTransferParams,
): Promise<ScheduleTransferResult> {
  const { decimals } = await getTokenInfo(hedera, params.tokenId);
  const inner = buildTokenTransfer(hedera, { tokenId: params.tokenId, to: params.to, amount: params.amount }, decimals);
  const result = await submitSchedule(
    hedera,
    inner,
    params,
    `Scheduling a transfer of ${params.amount} ${params.tokenId} to ${params.to}`,
  );
  return {
    ...result,
    tokenId: params.tokenId,
    to: params.to,
    amountUnits: toUnits(params.amount, decimals).toString(),
  };
}

export type ScheduleMintParams = ScheduleOptions & { tokenId: string; amount: DecimalAmount };
export type ScheduleMintResult = ScheduleResult & { tokenId: string; amountUnits: string };

/** Schedule a mint into the treasury, for a supply unlock on a date. Needs the token's supply key. */
export async function scheduleTokenMint(
  hedera: HederaContext,
  params: ScheduleMintParams,
): Promise<ScheduleMintResult> {
  const { decimals } = await getTokenInfo(hedera, params.tokenId);
  const inner = buildTokenMint({ tokenId: params.tokenId, amount: params.amount }, decimals);
  const result = await submitSchedule(hedera, inner, params, `Scheduling a mint of ${params.amount} ${params.tokenId}`);
  return { ...result, tokenId: params.tokenId, amountUnits: toUnits(params.amount, decimals).toString() };
}
