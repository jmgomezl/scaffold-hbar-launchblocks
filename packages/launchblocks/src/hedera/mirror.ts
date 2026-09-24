import { LaunchBlocksError } from "../errors";
import type { HederaContext } from "./context";
import { normalizeTransactionId } from "./context";

/**
 * Mirror node reads: free, where a consensus-node query costs a fee. They
 * serve contract reads and dry runs (contracts/call), proof after a run, and
 * wallet contexts, which read here what an operator gets from a paid query or
 * record. The mirror node lags consensus by a few seconds, so a read that
 * follows a write waits for it to catch up (waitForMirror, or a retry on 404).
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
    contents: new TextDecoder().decode(Uint8Array.from(atob(message.message), char => char.charCodeAt(0))),
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
 * The network's HBAR/USD rates as the mirror node reports them: the rate it
 * lists as current and the one it lists as next. Contracts that price fees in
 * tinycents (such as SaucerSwap's pool creation fee) convert with the rate in
 * effect at consensus through the 0x168 precompile, and on testnet that has
 * been observed to match the mirror's `next_rate` while its `current_rate`
 * had already expired — so callers should budget for either.
 */
export async function fetchExchangeRates(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  signal?: AbortSignal,
): Promise<{ current: ExchangeRate; next: ExchangeRate | null }> {
  const response = (await mirrorFetch(`${hedera.mirrorBaseUrl}/api/v1/network/exchangerate`, signal)) as {
    current_rate?: { hbar_equivalent?: number; cent_equivalent?: number };
    next_rate?: { hbar_equivalent?: number; cent_equivalent?: number };
  } | null;
  const toRate = (raw?: { hbar_equivalent?: number; cent_equivalent?: number }): ExchangeRate | null =>
    raw?.hbar_equivalent && raw.cent_equivalent
      ? { hbarEquivalent: raw.hbar_equivalent, centEquivalent: raw.cent_equivalent }
      : null;
  const current = toRate(response?.current_rate);
  if (!current) {
    throw new LaunchBlocksError("EXCHANGE_RATE_UNAVAILABLE", "Mirror node did not return a current exchange rate");
  }
  return { current, next: toRate(response?.next_rate) };
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
  if (response.status === 429 || response.status >= 500) {
    // The mirror node's trouble, not the contract's: a revert comes back as a 400.
    throw new LaunchBlocksError("MIRROR_ERROR", `Mirror node returned ${response.status} for ${url}`);
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

export type SimulatedCall =
  | { reverted: false; result: string }
  | { reverted: true; revertData: string; message: string };

/**
 * Simulate a state-changing contract call through the mirror node, for
 * free, to learn whether it would revert and with what data before paying
 * for the transaction. `value` is what the call would carry.
 */
export async function simulateContractCall(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  args: { to: string; data: string; from?: string; value?: bigint; gas?: number },
  signal?: AbortSignal,
): Promise<SimulatedCall> {
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
        ...(args.value !== undefined ? { value: Number(args.value) } : {}),
        ...(args.gas !== undefined ? { gas: args.gas } : {}),
      }),
    });
  } catch (cause) {
    throw new LaunchBlocksError("MIRROR_UNREACHABLE", `Could not reach the mirror node at ${url}`, { cause });
  }
  const body = (await response.json().catch(() => ({}))) as {
    result?: string;
    _status?: { messages?: { message?: string; data?: string }[] };
  };
  if (response.ok && body.result !== undefined) return { reverted: false, result: body.result };
  const first = body._status?.messages?.[0];
  return { reverted: true, revertData: first?.data ?? "0x", message: first?.message ?? `HTTP ${response.status}` };
}

/**
 * Wait until the mirror node has ingested a block that closes at or after
 * `sinceMs`. Every transaction that reached consensus before then is
 * included, so a read that follows a write sees it. Returns false on timeout
 * rather than throwing: the caller reads anyway, with the lag documented.
 */
export async function waitForMirror(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  sinceMs: number,
  options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  const url = `${hedera.mirrorBaseUrl}/api/v1/blocks?order=desc&limit=1`;
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  for (;;) {
    const body = (await mirrorFetch(url, options.signal)) as { blocks?: { timestamp?: { to?: string } }[] } | null;
    const closedAt = Number(body?.blocks?.[0]?.timestamp?.to ?? 0) * 1000;
    if (closedAt >= sinceMs) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, options.intervalMs ?? 1000));
  }
}

type RetryOptions = { attempts?: number; delayMs?: number; signal?: AbortSignal };

/** GET `url`, retrying while the mirror node answers 404 because it has not ingested the record yet. */
async function mirrorFetchAfterWrite(url: string, what: string, options: RetryOptions): Promise<unknown> {
  const attempts = options.attempts ?? 15;
  for (let attempt = 1; ; attempt += 1) {
    const body = await mirrorFetch(url, options.signal);
    if (body !== null) return body;
    if (attempt >= attempts) {
      throw new LaunchBlocksError("MIRROR_TIMEOUT", `The mirror node has no record of ${what} yet`, {
        hint: "The transaction went through; the mirror node is lagging. Check it on HashScan in a minute.",
      });
    }
    await new Promise(resolve => setTimeout(resolve, options.delayMs ?? 1500));
  }
}

export type MirrorContractResult = {
  /** ABI-encoded return data, `0x` when the call returned nothing. */
  callResult: `0x${string}`;
  gasUsed: number;
};

/**
 * What a contract transaction returned and the gas it used, from the mirror
 * node. A wallet context reads this instead of the transaction record, which
 * is a paid query the wallet would have to approve.
 */
export async function fetchContractResult(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  transactionId: string,
  options: RetryOptions = {},
): Promise<MirrorContractResult> {
  const id = normalizeTransactionId(transactionId);
  const body = (await mirrorFetchAfterWrite(
    `${hedera.mirrorBaseUrl}/api/v1/contracts/results/${encodeURIComponent(id)}`,
    `contract transaction ${id}`,
    options,
  )) as { call_result?: string | null; gas_used?: number | null };
  const callResult = body.call_result && body.call_result !== "0x" ? body.call_result : "0x";
  return { callResult: callResult as `0x${string}`, gasUsed: Number(body.gas_used ?? 0) };
}

export type MirrorTokenTransfer = { tokenId: string; accountId: string; amount: bigint };

/** The token movements a transaction made, from the mirror node, retried until it has the transaction. */
export async function fetchTokenTransfers(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  transactionId: string,
  options: RetryOptions = {},
): Promise<MirrorTokenTransfer[]> {
  const id = normalizeTransactionId(transactionId);
  const body = (await mirrorFetchAfterWrite(
    `${hedera.mirrorBaseUrl}/api/v1/transactions/${encodeURIComponent(id)}`,
    `transaction ${id}`,
    options,
  )) as { transactions?: { token_transfers?: { token_id: string; account: string; amount: number | string }[] }[] };
  return (body.transactions?.[0]?.token_transfers ?? []).map(transfer => ({
    tokenId: transfer.token_id,
    accountId: transfer.account,
    amount: BigInt(transfer.amount),
  }));
}

export type MirrorToken = {
  tokenId: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupplyUnits: string;
  treasuryAccountId: string | null;
};

/**
 * Token metadata from the mirror node, or `null` when there is no such token.
 * A 404 can also mean the mirror node has not ingested a token created moments
 * ago, so before answering `null` it waits for the mirror node to catch up
 * with the time of the first request and asks once more.
 */
export async function fetchToken(
  hedera: Pick<HederaContext, "mirrorBaseUrl">,
  tokenId: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<MirrorToken | null> {
  const url = `${hedera.mirrorBaseUrl}/api/v1/tokens/${encodeURIComponent(tokenId)}`;
  const askedAt = Date.now();
  let body = await mirrorFetch(url, options.signal);
  if (body === null) {
    const caughtUp = await waitForMirror(hedera, askedAt, options);
    body = await mirrorFetch(url, options.signal);
    if (body === null && !caughtUp) {
      throw new LaunchBlocksError("MIRROR_TIMEOUT", `The mirror node has no record of token ${tokenId} yet`, {
        hint: "The mirror node is lagging behind the network. Try again in a minute.",
      });
    }
    if (body === null) return null;
  }
  const token = body as {
    token_id: string;
    name: string;
    symbol: string;
    decimals: string | number;
    total_supply: string | number;
    treasury_account_id?: string | null;
  };
  return {
    tokenId: token.token_id,
    name: token.name,
    symbol: token.symbol,
    decimals: Number(token.decimals),
    totalSupplyUnits: String(token.total_supply),
    treasuryAccountId: token.treasury_account_id ?? null,
  };
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
