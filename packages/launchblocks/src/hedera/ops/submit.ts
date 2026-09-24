import type { Transaction, TransactionReceipt } from "@hiero-ledger/sdk";
import { TransactionId } from "@hiero-ledger/sdk";
import { toHex } from "viem";

import { LaunchBlocksError } from "../../errors";
import type { HederaContext } from "../context";
import { translateHederaError, translateWalletError } from "../errors";
import { fetchContractResult } from "../mirror";

export type Sent = { transactionId: string; receipt: TransactionReceipt };

/**
 * Sign and send a transaction as the context's account, then wait for its
 * receipt. `context` names the operation in error messages.
 *
 * An operator context signs with the client's key. A wallet context freezes
 * the transaction for the wallet account and has the wallet sign and submit
 * it, one approval; the receipt is then read with the plain client, a free
 * query. (Asking the wallet's signer for a failed receipt would retry it as a
 * paid query through the wallet.)
 */
export async function send(hedera: HederaContext, transaction: Transaction, context: string): Promise<Sent> {
  try {
    if (hedera.signer) {
      if (!transaction.isFrozen()) {
        transaction.setTransactionId(TransactionId.generate(hedera.operatorId)).freezeWith(hedera.client);
      }
      const response = await transaction.executeWithSigner(hedera.signer).catch((error: unknown) => {
        throw translateWalletError(error, context);
      });
      const receipt = await response.getReceipt(hedera.client);
      return { transactionId: response.transactionId.toString(), receipt };
    }
    const response = await transaction.execute(hedera.client);
    const receipt = await response.getReceipt(hedera.client);
    return { transactionId: response.transactionId.toString(), receipt };
  } catch (error) {
    if (error instanceof LaunchBlocksError) throw error;
    throw translateHederaError(error, context);
  }
}

/** {@link send}, then build a result from the receipt and transaction id. */
export async function submit<T>(
  hedera: HederaContext,
  transaction: Transaction,
  context: string,
  extract: (receipt: TransactionReceipt, transactionId: string) => T,
): Promise<T> {
  const { receipt, transactionId } = await send(hedera, transaction, context);
  return extract(receipt, transactionId);
}

export type ContractOutcome = Sent & {
  /** ABI-encoded return data; `0x` when the function returned nothing. */
  output: `0x${string}`;
  gasUsed: number;
};

/**
 * Send a contract transaction and read what it returned and the gas it used:
 * from the transaction record in an operator context, and from the mirror
 * node in a wallet context, where a record query is a paid query the wallet
 * would have to approve.
 */
export async function sendContract(
  hedera: HederaContext,
  transaction: Transaction,
  context: string,
  signal?: AbortSignal,
): Promise<ContractOutcome> {
  if (hedera.signer) {
    const sent = await send(hedera, transaction, context);
    const result = await fetchContractResult(hedera, sent.transactionId, signal ? { signal } : {});
    return { ...sent, output: result.callResult, gasUsed: result.gasUsed };
  }
  try {
    const response = await transaction.execute(hedera.client);
    // getRecord throws on a failed receipt status, so success is implied here.
    const record = await response.getRecord(hedera.client);
    const result = record.contractFunctionResult;
    if (!result) throw new LaunchBlocksError("CONTRACT_NO_RESULT", `${context} produced no contract result`);
    return {
      transactionId: response.transactionId.toString(),
      receipt: record.receipt,
      output: result.bytes.length ? toHex(result.bytes) : "0x",
      gasUsed: Number(result.gasUsed ?? 0),
    };
  } catch (error) {
    if (error instanceof LaunchBlocksError) throw error;
    throw translateHederaError(error, context);
  }
}
