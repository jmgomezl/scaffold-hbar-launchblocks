import { LaunchBlocksError } from "../errors";
import type { Network } from "../flow/schema";
import { fromUnits } from "../hedera/amounts";
import type { HederaContext } from "../hedera/context";
import {
  fetchSchedule,
  fetchToken,
  fetchTokenBalances,
  fetchTopic,
  fetchTopicMessages,
  mirrorTimestampToIso,
} from "../hedera/mirror";
import { LP_TOKEN_DECIMALS, saucerswapFor } from "../saucerswap/config";
import { openingPrice } from "../saucerswap/pool";

/**
 * A launch as its HCS log records it and as the network shows it now.
 *
 * Every gallery flow opens a topic and writes a JSON event to it at each
 * milestone (`token.launched`, `market.opened`, `liquidity.locked`,
 * `unlocks.scheduled`, …), so the log alone names everything the launch
 * created. `readLaunch` reads it back from the mirror node and adds the
 * current state of those entities: the token's supply, the pool's price,
 * what the lock still holds, which schedules have run. It sends nothing.
 */

export type LaunchLogEntry = {
  sequence: number;
  /** ISO time the message reached consensus. */
  consensusAt: string;
  payerAccountId: string | null;
  /** The message parsed as a JSON object, when it is one; `data.event` names what happened. */
  data: Record<string, unknown> | null;
  text: string;
};

export type LaunchToken = {
  tokenId: string;
  name: string;
  symbol: string;
  decimals: number;
  /** Whole tokens, as a decimal string. */
  totalSupply: string;
  treasuryAccountId: string | null;
};

export type LaunchPool = {
  pairId: string;
  /** Whole tokens and HBAR in the pool now. */
  tokenReserve: string;
  hbarReserve: string;
  /** HBAR per token now, and when the pool opened (from the log). */
  priceHbar: string;
  openingPriceHbar: string | null;
};

export type LaunchLock = {
  contractId: string;
  lpTokenId: string;
  /** LP tokens the lock holds now. */
  lockedLp: string;
  /** ISO time the lock allows release, from the log. */
  releaseAt: string | null;
  released: boolean;
};

export type LaunchSchedule = {
  scheduleId: string;
  /** The key the log filed it under, e.g. `month1`. */
  label: string;
  executedAt: string | null;
  /** ISO time the network runs it, when the log or the schedule says. */
  executesAt: string | null;
  deleted: boolean;
};

export type LaunchRecord = {
  topicId: string;
  network: Network;
  memo: string;
  createdAt: string | null;
  entries: LaunchLogEntry[];
  token: LaunchToken | null;
  pool: LaunchPool | null;
  lock: LaunchLock | null;
  schedules: LaunchSchedule[];
};

const ENTITY_ID = /^\d+\.\d+\.\d+$/;
/** A launch log is a few messages; this many covers any flow the studio builds. */
const MAX_ENTRIES = 100;
const MAX_SCHEDULES = 10;
const HBAR_DECIMALS = 8;

export async function readLaunch(
  hedera: Pick<HederaContext, "mirrorBaseUrl" | "network">,
  topicId: string,
  signal?: AbortSignal,
): Promise<LaunchRecord> {
  if (!ENTITY_ID.test(topicId)) {
    throw new LaunchBlocksError("ENTITY_ID_INVALID", `"${topicId}" is not a topic id`, {
      hint: "A launch log is an HCS topic id such as 0.0.10716076.",
    });
  }
  const [topic, messages] = await Promise.all([
    fetchTopic(hedera, topicId, signal),
    fetchTopicMessages(hedera, topicId, MAX_ENTRIES, signal),
  ]);
  if (!topic) {
    throw new LaunchBlocksError("LAUNCH_NOT_FOUND", `There is no topic ${topicId} on ${hedera.network}`, {
      hint: "Check the id, and that it is a launch log on this network.",
    });
  }

  const entries = messages.map<LaunchLogEntry>(message => ({
    sequence: message.sequenceNumber,
    consensusAt: mirrorTimestampToIso(message.consensusTimestamp),
    payerAccountId: message.payerAccountId,
    data: parseObject(message.contents),
    text: message.contents,
  }));
  const events = entries.map(entry => entry.data).filter((data): data is Record<string, unknown> => data !== null);

  const tokenId = firstString(events, "tokenId", "token.launched");
  const market = events.find(data => data.event === "market.opened");
  const locked = events.find(data => data.event === "liquidity.locked");
  const pairId = stringField(market, "pairId") ?? stringField(locked, "pairId");

  const token = tokenId ? await readToken(hedera, tokenId, signal) : null;
  const [pool, lock, schedules] = await Promise.all([
    pairId && token ? readPool(hedera, pairId, token, stringField(market, "openingPriceHbar"), signal) : null,
    locked ? readLock(hedera, locked, signal) : null,
    readSchedules(hedera, events, signal),
  ]);

  return {
    topicId,
    network: hedera.network,
    memo: topic.memo,
    createdAt: topic.createdTimestamp ? mirrorTimestampToIso(topic.createdTimestamp) : null,
    entries,
    token,
    pool,
    lock,
    schedules,
  };
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringField(data: Record<string, unknown> | undefined, key: string): string | null {
  const value = data?.[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** `key` from the first event named `preferred`, else from the first event that has it. */
function firstString(events: Record<string, unknown>[], key: string, preferred: string): string | null {
  const named = events.find(data => data.event === preferred);
  return stringField(named, key) ?? events.map(data => stringField(data, key)).find(Boolean) ?? null;
}

async function readToken(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  tokenId: string,
  signal?: AbortSignal,
): Promise<LaunchToken | null> {
  if (!ENTITY_ID.test(tokenId)) return null;
  const token = await fetchToken(hedera, tokenId, { afterWrite: false, ...(signal ? { signal } : {}) });
  if (!token) return null;
  return {
    tokenId: token.tokenId,
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
    totalSupply: fromUnits(token.totalSupplyUnits, token.decimals),
    treasuryAccountId: token.treasuryAccountId,
  };
}

/** A SaucerSwap V1 pool holds WHBAR and the token; its price is their ratio. */
async function readPool(
  hedera: Pick<HederaContext, "mirrorBaseUrl" | "network">,
  pairId: string,
  token: LaunchToken,
  openingPriceHbar: string | null,
  signal?: AbortSignal,
): Promise<LaunchPool | null> {
  if (!ENTITY_ID.test(pairId)) return null;
  const balances = await fetchTokenBalances(hedera, pairId, signal);
  const tokenUnits = balances.get(token.tokenId);
  const tinybar = balances.get(saucerswapFor(hedera.network).whbarToken);
  if (tokenUnits === undefined || tinybar === undefined) return null;
  return {
    pairId,
    tokenReserve: fromUnits(tokenUnits, token.decimals),
    hbarReserve: fromUnits(tinybar, HBAR_DECIMALS),
    priceHbar: openingPrice(tinybar, tokenUnits, token.decimals),
    openingPriceHbar,
  };
}

async function readLock(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  event: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<LaunchLock | null> {
  const contractId = stringField(event, "lock");
  const lpTokenId = stringField(event, "lpTokenId");
  if (!contractId || !lpTokenId || !ENTITY_ID.test(contractId)) return null;
  const held = (await fetchTokenBalances(hedera, contractId, signal)).get(lpTokenId) ?? 0n;
  const releaseSeconds = Number(stringField(event, "releaseTime"));
  return {
    contractId,
    lpTokenId,
    lockedLp: fromUnits(held, LP_TOKEN_DECIMALS),
    releaseAt:
      Number.isFinite(releaseSeconds) && releaseSeconds > 0 ? new Date(releaseSeconds * 1000).toISOString() : null,
    released: held === 0n,
  };
}

/** Schedules the log names, as `{ schedule, at }` objects at any depth (see `unlocks.scheduled`). */
async function readSchedules(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  events: Record<string, unknown>[],
  signal?: AbortSignal,
): Promise<LaunchSchedule[]> {
  const found: { scheduleId: string; label: string; at: string | null }[] = [];
  const visit = (value: unknown, label: string) => {
    if (!value || typeof value !== "object" || found.length >= MAX_SCHEDULES) return;
    const record = value as Record<string, unknown>;
    const scheduleId = stringField(record, "schedule") ?? stringField(record, "scheduleId");
    if (scheduleId && ENTITY_ID.test(scheduleId) && !found.some(entry => entry.scheduleId === scheduleId)) {
      found.push({ scheduleId, label, at: stringField(record, "at") ?? stringField(record, "executesAt") });
    }
    for (const [key, child] of Object.entries(record)) visit(child, key);
  };
  for (const event of events) visit(event, String(event.event ?? "schedule"));

  return Promise.all(
    found.map(async ({ scheduleId, label, at }) => {
      const schedule = await fetchSchedule(hedera, scheduleId, signal);
      const expiration = schedule?.expirationTime ? mirrorTimestampToIso(schedule.expirationTime) : null;
      return {
        scheduleId,
        label,
        executedAt: schedule?.executedTimestamp ? mirrorTimestampToIso(schedule.executedTimestamp) : null,
        executesAt: at ?? expiration,
        deleted: schedule?.deleted ?? false,
      };
    }),
  );
}
