import type { Client, Transaction, TransactionReceipt, TransactionResponse } from "@hiero-ledger/sdk";

import { translateHederaError } from "../errors";

/**
 * Execute a transaction with the operator, wait for the receipt, and
 * translate failures. `context` names the operation in error messages.
 */
export async function submit<T>(
  client: Client,
  transaction: Transaction,
  context: string,
  extract: (receipt: TransactionReceipt, response: TransactionResponse) => T,
): Promise<T> {
  try {
    const response = await transaction.execute(client);
    const receipt = await response.getReceipt(client);
    return extract(receipt, response);
  } catch (error) {
    throw translateHederaError(error, context);
  }
}

/** Like {@link submit} but also fetches the record, for results only the record carries. */
export async function submitForRecord<T>(
  client: Client,
  transaction: Transaction,
  context: string,
  extract: (record: Awaited<ReturnType<TransactionResponse["getRecord"]>>, response: TransactionResponse) => T,
): Promise<T> {
  try {
    const response = await transaction.execute(client);
    // getRecord throws on a failed receipt status, so success is implied here.
    const record = await response.getRecord(client);
    return extract(record, response);
  } catch (error) {
    throw translateHederaError(error, context);
  }
}
