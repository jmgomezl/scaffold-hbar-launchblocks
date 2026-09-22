import { LaunchBlocksError } from "../errors";
import type { HederaContext } from "./context";

/**
 * Minimal mirror node reads. The mirror node lags consensus by a few
 * seconds, so it is used for verification and dashboards, never to gate a
 * transaction that was just submitted.
 */

export type MirrorAccount = {
  accountId: string;
  evmAddress: string | null;
  /** Balance in tinybars. */
  balanceTinybar: bigint;
  /** Whether the account key is ECDSA (EVM-compatible) or ED25519. */
  keyType: string | null;
  deleted: boolean;
};

export async function fetchAccount(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  accountId: string,
  signal?: AbortSignal,
): Promise<MirrorAccount | null> {
  const url = `${hedera.mirrorBaseUrl}/api/v1/accounts/${encodeURIComponent(accountId)}?limit=1`;
  const response = await mirrorFetch(url, signal);
  if (response === null) return null;
  const data = response as {
    account?: string;
    evm_address?: string | null;
    deleted?: boolean;
    balance?: { balance?: number | string };
    key?: { _type?: string } | null;
  };
  return {
    accountId: data.account ?? accountId,
    evmAddress: data.evm_address ?? null,
    balanceTinybar: BigInt(data.balance?.balance ?? 0),
    keyType: data.key?._type ?? null,
    deleted: data.deleted === true,
  };
}

export type MirrorTopicMessage = { sequenceNumber: number; consensusTimestamp: string; contents: string };

/** Read messages back from a topic to prove what consensus recorded. */
export async function fetchTopicMessages(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  topicId: string,
  limit = 25,
  signal?: AbortSignal,
): Promise<MirrorTopicMessage[]> {
  const url = `${hedera.mirrorBaseUrl}/api/v1/topics/${encodeURIComponent(topicId)}/messages?limit=${limit}&order=asc`;
  const response = await mirrorFetch(url, signal);
  if (response === null) return [];
  const data = response as { messages?: { sequence_number: number; consensus_timestamp: string; message: string }[] };
  return (data.messages ?? []).map(message => ({
    sequenceNumber: message.sequence_number,
    consensusTimestamp: message.consensus_timestamp,
    contents: Buffer.from(message.message, "base64").toString("utf8"),
  }));
}

/** GET a mirror node URL. Returns null on 404; throws with a code otherwise. */
async function mirrorFetch(url: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { ...(signal ? { signal } : {}), headers: { accept: "application/json" } });
  } catch (cause) {
    throw new LaunchBlocksError("MIRROR_UNREACHABLE", `Could not reach the mirror node at ${url}`, {
      cause,
      hint: "Check connectivity and HEDERA_MIRROR_URL.",
    });
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new LaunchBlocksError("MIRROR_ERROR", `Mirror node returned ${response.status} for ${url}`);
  }
  return response.json();
}

export const TINYBAR_PER_HBAR = 100_000_000n;

export function formatHbar(tinybar: bigint): string {
  const whole = tinybar / TINYBAR_PER_HBAR;
  const fraction = (tinybar % TINYBAR_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
