import type { AccountId, Client, PrivateKey, PublicKey, Signer } from "@hiero-ledger/sdk";

import type { Network } from "../flow/schema";

/**
 * Everything a step needs to talk to Hedera, handed to every executor. Two
 * kinds exist: an operator context on the server (the API route, the CLI, a
 * generated launch script), whose client holds the operator key and signs;
 * and a wallet context in the browser, where a connected wallet signs each
 * transaction and the client only runs free queries.
 */
export type HederaContext = {
  network: Network;
  /**
   * SDK client. In an operator context it carries the operator and signs; in
   * a wallet context it has no operator and only freezes transactions and
   * reads receipts, which are free.
   */
  client: Client;
  /** The account that pays for and signs every step. */
  operatorId: AccountId;
  /** That account's public key: the key a flow gives the tokens, topics, contracts and schedules it creates. */
  operatorPublicKey: PublicKey;
  /** Operator contexts only: the private key the client signs with. Never serialized. */
  operatorKey?: PrivateKey;
  /** Wallet contexts only: signs and submits every transaction, one approval each. */
  signer?: Signer;
  /** Mirror node REST base URL without trailing slash, e.g. https://testnet.mirrornode.hedera.com */
  mirrorBaseUrl: string;
};

const HASHSCAN_NETWORK_PATH: Record<Network, string> = {
  testnet: "testnet",
  mainnet: "mainnet",
  // Hashscan has no localnet; links still render but will not resolve.
  localnet: "testnet",
};

export type HashscanEntity = "account" | "token" | "topic" | "contract" | "transaction" | "schedule";

/** Explorer link for an entity id (`0.0.x`) or a transaction id (`0.0.x@s.n` / `0.0.x-s-n`). */
export function hashscanUrl(network: Network, entity: HashscanEntity, id: string): string {
  const path =
    entity === "transaction" ? `transaction/${encodeURIComponent(normalizeTransactionId(id))}` : `${entity}/${id}`;
  return `https://hashscan.io/${HASHSCAN_NETWORK_PATH[network]}/${path}`;
}

/**
 * The SDK renders transaction ids as `0.0.x@seconds.nanos`, with a
 * `?scheduled` suffix for a scheduled transaction; mirror node and Hashscan
 * use `0.0.x-seconds-nanos`. Accepts either and returns the latter, whose
 * Hashscan page lists the schedule's creation and its execution.
 */
export function normalizeTransactionId(id: string): string {
  const match = /^(\d+\.\d+\.\d+)[@-](\d+)[.-](\d+)(?:\?scheduled(?:=true)?)?$/.exec(id.trim());
  if (!match) return id;
  return `${match[1]}-${match[2]}-${match[3]}`;
}
