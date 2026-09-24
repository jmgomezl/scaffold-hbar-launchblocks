import { LaunchBlocksError } from "../errors";
import type { Network } from "../flow/schema";

/**
 * Pyth on Hedera. Pyth is a pull oracle: its contract holds the last price
 * someone posted, and anyone can post a fresher one by passing a signed
 * update from Pyth's price service (Hermes) to `updatePriceFeeds`.
 *
 * Contract ids read from the mirror node on 2026-09-24; the EVM address is
 * the same on every chain Pyth deploys to.
 *
 * @see https://docs.pyth.network/price-feeds/core/contract-addresses/evm
 */
export type PythDeployment = {
  contractId: string;
  evmAddress: `0x${string}`;
};

export const PYTH_DEPLOYMENTS: Partial<Record<Network, PythDeployment>> = {
  testnet: { contractId: "0.0.3042133", evmAddress: "0xa2aa501b19aff244d90cc15a4cf739d2725b5729" },
  mainnet: { contractId: "0.0.4622850", evmAddress: "0xa2aa501b19aff244d90cc15a4cf739d2725b5729" },
};

/** Pyth price feed ids, from Hermes' `/v2/price_feeds`. */
export const PYTH_FEEDS = {
  /** Crypto.HBAR/USD */
  hbarUsd: "0x3728e591097635310e6341af53db8b7ee42da9b3a8d918f9463ce9cca886dfbd",
} as const;

/** Pyth's price service. Since 2026-08-26 it answers only requests with an API key. */
export const HERMES_BASE_URL = "https://hermes.pyth.network";

/** Gas for `updatePriceFeeds`: verifying the update's Wormhole signatures dominates. */
export const PYTH_UPDATE_GAS = 1_500_000;

export function pythFor(network: Network): PythDeployment {
  const deployment = PYTH_DEPLOYMENTS[network];
  if (!deployment) {
    throw new LaunchBlocksError(
      "PYTH_UNAVAILABLE",
      `Pyth is not deployed on ${network}; run this flow against testnet or mainnet`,
    );
  }
  return deployment;
}
