import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";

import { LaunchBlocksError } from "../errors";
import type { HederaContext } from "../hedera/context";
import { readContract } from "../hedera/mirror";
import type { ChainlinkFeed } from "./config";

const AGGREGATOR_ABI = parseAbi([
  "function decimals() view returns (uint8)",
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
]);

/** A Chainlink round: the price is `answer × 10^-decimals`. */
export type ChainlinkRound = {
  roundId: bigint;
  answer: bigint;
  decimals: number;
  /** Unix seconds. */
  updatedAt: number;
};

/**
 * The latest round of a Chainlink feed, read for free through the mirror node. Refuses a round that
 * is incomplete or not positive; how old a price may be is the caller's decision.
 */
export async function readChainlinkRound(
  hedera: HederaContext,
  feed: ChainlinkFeed,
  signal?: AbortSignal,
): Promise<ChainlinkRound> {
  const read = async (functionName: "decimals" | "latestRoundData") =>
    readContract(
      hedera,
      { to: feed.evmAddress, data: encodeFunctionData({ abi: AGGREGATOR_ABI, functionName }) },
      signal,
    );
  const [decimalsRaw, roundRaw] = await Promise.all([read("decimals"), read("latestRoundData")]);
  const decimals = decodeFunctionResult({
    abi: AGGREGATOR_ABI,
    functionName: "decimals",
    data: decimalsRaw as `0x${string}`,
  });
  const [roundId, answer, , updatedAt, answeredInRound] = decodeFunctionResult({
    abi: AGGREGATOR_ABI,
    functionName: "latestRoundData",
    data: roundRaw as `0x${string}`,
  });
  if (answer <= 0n || updatedAt === 0n || answeredInRound < roundId) {
    throw new LaunchBlocksError(
      "CHAINLINK_NO_PRICE",
      `Chainlink's ${feed.description} feed on ${hedera.network} has no complete, positive round`,
      { hint: "Run again in a few minutes; if it persists, the feed may be paused." },
    );
  }
  return { roundId, answer, decimals, updatedAt: Number(updatedAt) };
}
