import type { ApiError, RunEvent } from "./api";
import type { Signer } from "@hiero-ledger/sdk";
import type { PythPriceUpdates } from "@sh/launchblocks/browser";
import type { FlowInput } from "@sh/launchblocks/editor";

/** A compiled contract from the app, for a Deploy contract block run in the browser. */
async function fetchArtifact(name: string) {
  const response = await fetch(`/api/launchblocks/artifacts/${encodeURIComponent(name)}`);
  const body = await response.json();
  if (!response.ok) throw Object.assign(new Error(body?.error?.message ?? `No contract ${name}`), body?.error ?? {});
  return body;
}

/**
 * Pyth price updates through the app's route, which holds the Hermes key, when
 * the server has one. Without it, Pyth steps read the price already on-chain.
 */
async function pythPriceUpdates(flow: FlowInput): Promise<PythPriceUpdates | undefined> {
  if (!flow.steps.some(step => step.type.startsWith("pyth."))) return undefined;
  const status: { configured?: boolean } = await fetch("/api/launchblocks/pyth/updates")
    .then(response => (response.ok ? response.json() : {}))
    .catch(() => ({}));
  if (!status.configured) return undefined;
  return async (feedIds, signal) => {
    const query = feedIds.map(id => `ids=${encodeURIComponent(id)}`).join("&");
    const response = await fetch(`/api/launchblocks/pyth/updates?${query}`, signal ? { signal } : {});
    const body = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(body?.error?.message ?? "Could not get a Pyth price update"), body?.error ?? {});
    }
    return body.updates;
  };
}

function toApiError(error: unknown): ApiError {
  const candidate = error as Partial<ApiError> & { issues?: ApiError["issues"] };
  return {
    code: typeof candidate?.code === "string" ? candidate.code : "WALLET_RUN_FAILED",
    message: error instanceof Error ? error.message : String(error),
    ...(candidate?.hint ? { hint: candidate.hint } : {}),
    ...(candidate?.issues ? { issues: candidate.issues } : {}),
  };
}

/**
 * Run a flow in this page with a connected wallet signing each transaction,
 * yielding the same events the server streams, so the Run panel shows either
 * the same way. The core is loaded on first use.
 */
export async function* runFlowWithWallet(flow: FlowInput, signer: Signer): AsyncGenerator<RunEvent> {
  const network = flow.network ?? "testnet";
  if (network !== "testnet") {
    throw { code: "WALLET_TESTNET_ONLY", message: "Wallet runs are testnet only in this studio" } satisfies ApiError;
  }

  const queue: RunEvent[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let failure: unknown = null;
  const notify = () => {
    wake?.();
    wake = null;
  };

  try {
    const core = await import("@sh/launchblocks/browser");
    const pyth = await pythPriceUpdates(flow);
    const hedera = await core.walletHederaContext({ signer, network, ...(pyth ? { pythPriceUpdates: pyth } : {}) });
    void core
      .runFlow(flow, {
        registry: core.createDefaultRegistry(),
        ctx: { network, hedera, log: () => undefined, artifacts: fetchArtifact },
        // Events leave the core as plain data, as they would over the wire.
        onEvent: event => {
          queue.push(JSON.parse(JSON.stringify(event)) as RunEvent);
          notify();
        },
      })
      .catch(error => {
        failure = error;
      })
      .finally(() => {
        finished = true;
        notify();
      });
  } catch (error) {
    throw toApiError(error);
  }

  for (;;) {
    const next = queue.shift();
    if (next) {
      yield next;
      continue;
    }
    if (finished) break;
    await new Promise<void>(resolve => {
      wake = resolve;
    });
  }
  if (failure) throw toApiError(failure);
}
