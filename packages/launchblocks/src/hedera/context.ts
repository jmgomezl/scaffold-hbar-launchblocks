import type { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";

import type { Network } from "../flow/schema";

/**
 * Everything a step needs to talk to Hedera. Built once per run by the API
 * route (or the generated launch script) and handed to every executor.
 */
export type HederaContext = {
  network: Network;
  /** SDK client with the operator already set; signs with the operator key. */
  client: Client;
  operatorId: AccountId;
  operatorKey: PrivateKey;
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
 * The SDK renders transaction ids as `0.0.x@seconds.nanos`; mirror node and
 * Hashscan use `0.0.x-seconds-nanos`. Accepts either and returns the latter.
 */
export function normalizeTransactionId(id: string): string {
  const match = /^(\d+\.\d+\.\d+)[@-](\d+)[.-](\d+)$/.exec(id.trim());
  if (!match) return id;
  return `${match[1]}-${match[2]}-${match[3]}`;
}
