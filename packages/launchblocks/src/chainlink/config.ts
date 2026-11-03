import { LaunchBlocksError } from "../errors";
import type { Network } from "../flow/schema";

/**
 * Chainlink data feeds on Hedera. A push oracle: Chainlink's network writes a new round whenever the
 * price moves by the feed's deviation threshold, and at least once per heartbeat, so reading the feed
 * is free and needs no update first.
 *
 * Proxy addresses, heartbeat and threshold from Chainlink's feed directory
 * (reference-data-directory feeds-hedera-testnet.json / feeds-hedera-mainnet.json); contract ids from
 * the mirror node; `description()` read on-chain on 2026-10-22.
 *
 * @see https://docs.chain.link/data-feeds/price-feeds/addresses?network=hedera
 */
export type ChainlinkFeed = {
  /** The proxy's Hedera contract id. */
  contractId: string;
  /** The proxy to read: it keeps its address when Chainlink upgrades the aggregator behind it. */
  evmAddress: `0x${string}`;
  description: string;
  /** Chainlink writes at least one round per heartbeat. */
  heartbeatSeconds: number;
  /** And one whenever the price moves by this much, in basis points. */
  deviationBps: number;
};

export const CHAINLINK_HBAR_USD: Partial<Record<Network, ChainlinkFeed>> = {
  testnet: {
    contractId: "0.0.4870176",
    evmAddress: "0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a",
    description: "HBAR / USD",
    heartbeatSeconds: 86_400,
    deviationBps: 50,
  },
  mainnet: {
    contractId: "0.0.7887607",
    evmAddress: "0xAF685FB45C12b92b5054ccb9313e135525F9b5d5",
    description: "HBAR / USD",
    heartbeatSeconds: 86_400,
    deviationBps: 50,
  },
};

export function chainlinkHbarUsdFor(network: Network): ChainlinkFeed {
  const feed = CHAINLINK_HBAR_USD[network];
  if (!feed) {
    throw new LaunchBlocksError(
      "CHAINLINK_UNAVAILABLE",
      `Chainlink has no HBAR/USD feed on ${network}; run this flow against testnet or mainnet`,
    );
  }
  return feed;
}
