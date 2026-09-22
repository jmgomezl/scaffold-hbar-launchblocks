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
  /** Hex-encoded public key on the account, for verifying an operator key. */
  publicKey: string | null;
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
    key?: { _type?: string; key?: string } | null;
  };
  return {
    accountId: data.account ?? accountId,
    evmAddress: data.evm_address ?? null,
    balanceTinybar: BigInt(data.balance?.balance ?? 0),
    keyType: data.key?._type ?? null,
    publicKey: data.key?.key ?? null,
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

export type ExchangeRate = { hbarEquivalent: number; centEquivalent: number };

/**
 * The network's current HBAR/USD rate, the same one the exchange rate
 * precompile at 0x168 uses. Contracts that price fees in tinycents (such as
 * SaucerSwap's pool creation fee) convert with it.
 */
export async function fetchExchangeRate(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  signal?: AbortSignal,
): Promise<ExchangeRate> {
  const response = await mirrorFetch(`${hedera.mirrorBaseUrl}/api/v1/network/exchangerate`, signal);
  const rate = (response as { current_rate?: { hbar_equivalent?: number; cent_equivalent?: number } } | null)
    ?.current_rate;
  if (!rate?.hbar_equivalent || !rate.cent_equivalent) {
    throw new LaunchBlocksError("EXCHANGE_RATE_UNAVAILABLE", "Mirror node did not return a current exchange rate");
  }
  return { hbarEquivalent: rate.hbar_equivalent, centEquivalent: rate.cent_equivalent };
}

/** Convert tinycents to tinybars exactly as the 0x168 precompile does. */
export function tinycentsToTinybars(tinycents: bigint, rate: ExchangeRate): bigint {
  return (tinycents * BigInt(rate.hbarEquivalent)) / BigInt(rate.centEquivalent);
}

/**
 * Read-only contract call through the mirror node. Unlike ContractCallQuery
 * this costs nothing, so quoting a fee never spends HBAR.
 */
export async function readContract(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  args: { to: string; data: string; from?: string },
  signal?: AbortSignal,
): Promise<string> {
  const url = `${hedera.mirrorBaseUrl}/api/v1/contracts/call`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      ...(signal ? { signal } : {}),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        to: args.to,
        data: args.data,
        estimate: false,
        ...(args.from ? { from: args.from } : {}),
      }),
    });
  } catch (cause) {
    throw new LaunchBlocksError("MIRROR_UNREACHABLE", `Could not reach the mirror node at ${url}`, { cause });
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new LaunchBlocksError(
      "CONTRACT_READ_FAILED",
      `Contract read on ${args.to} failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  const body = (await response.json()) as { result?: string };
  if (!body.result) {
    throw new LaunchBlocksError("CONTRACT_READ_FAILED", `Contract read on ${args.to} returned no result`);
  }
  return body.result;
}

/**
 * Resolve an EVM address to its Hedera contract id. Contracts deployed with
 * CREATE2 — SaucerSwap pairs among them — have aliased addresses that cannot
 * be derived arithmetically, so the mirror node is the only way back.
 */
export async function resolveContractId(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  evmAddress: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = `${hedera.mirrorBaseUrl}/api/v1/contracts/${encodeURIComponent(evmAddress)}`;
  const response = await mirrorFetch(url, signal);
  if (response === null) return null;
  return (response as { contract_id?: string }).contract_id ?? null;
}

/**
 * The EVM address an account is actually addressed by.
 *
 * Accounts created from an ECDSA alias are addressed by a keccak-derived
 * address, not by the long-zero form of their account id. Passing the
 * long-zero form as a transfer recipient inside a contract call fails with
 * INVALID_ALIAS_KEY, so anything handing an account to the EVM must resolve
 * it here first rather than calling `AccountId.toSolidityAddress()`.
 */
export async function resolveEvmAddress(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  accountId: string,
  signal?: AbortSignal,
): Promise<string> {
  const account = await fetchAccount(hedera, accountId, signal);
  if (!account) {
    throw new LaunchBlocksError("ACCOUNT_NOT_FOUND", `Account ${accountId} does not exist on this network`);
  }
  if (account.evmAddress) return account.evmAddress;
  // Accounts without an alias are addressed by the long-zero form of their id.
  const num = accountId.trim().split(".")[2];
  return `0x${BigInt(num ?? "0")
    .toString(16)
    .padStart(40, "0")}`;
}

export const TINYBAR_PER_HBAR = 100_000_000n;

export function formatHbar(tinybar: bigint): string {
  const whole = tinybar / TINYBAR_PER_HBAR;
  const fraction = (tinybar % TINYBAR_PER_HBAR).toString().padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
