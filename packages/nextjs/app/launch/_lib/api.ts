import type { FeeEstimate, FlowInput, HarnessRecipe, StepCatalogEntry } from "@sh/launchblocks/editor";

/** Client for the LaunchBlocks API routes. Types mirror what the server returns. */

export type GalleryEntry = { id: string; title: string; blurb: string; flow: FlowInput };

export type FlowIssue = { path: string; message: string; stepId?: string };

export type ApiError = { code: string; message: string; hint?: string; issues?: FlowIssue[] };

export type StepLink = { label: string; url: string };

export type StepRecord = {
  id: string;
  type: string;
  label?: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  durationMs?: number;
  outputs?: Record<string, unknown>;
  links: StepLink[];
  error?: { code: string; message: string; hint?: string; causeCode?: string };
};

export type RunResult = {
  flowId: string;
  network: string;
  status: "succeeded" | "failed";
  steps: StepRecord[];
  outputs: Record<string, Record<string, unknown>>;
  error?: { stepId: string; code: string; message: string; hint?: string };
};

export type RunEvent =
  | { type: "flow:start"; flowId: string; network: string; stepCount: number }
  | { type: "step:start" | "step:success" | "step:error"; step: StepRecord }
  | { type: "flow:end"; result: RunResult }
  | { type: "error"; error: ApiError };

const BASE = "/api/launchblocks";

/**
 * A lazily loaded part of the app (the core for wallet runs, the wallet
 * connector) that a deploy replaced after this page loaded.
 */
export function isStalePage(error: unknown): boolean {
  const { name, message } = (error ?? {}) as { name?: unknown; message?: unknown };
  return name === "ChunkLoadError" || /Loading (CSS )?chunk \S+ failed/.test(String(message ?? ""));
}

/**
 * Anything thrown during a request or run as an ApiError: the server's errors
 * and the core's LaunchBlocksErrors keep their code and hint; anything else
 * (a dropped connection, say) keeps its message under `fallbackCode`.
 */
export function toApiError(error: unknown, fallbackCode = "REQUEST_FAILED"): ApiError {
  if (isStalePage(error)) {
    return {
      code: "APP_UPDATED",
      message: "LaunchBlocks was updated while this page was open, so part of it could not load.",
      hint: "Reload the page, then run again. Nothing was sent.",
    };
  }
  const candidate = (error ?? {}) as Partial<ApiError>;
  return {
    code: typeof candidate.code === "string" ? candidate.code : fallbackCode,
    message: typeof candidate.message === "string" ? candidate.message : String(error),
    ...(typeof candidate.hint === "string" ? { hint: candidate.hint } : {}),
    ...(Array.isArray(candidate.issues) ? { issues: candidate.issues } : {}),
  };
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: ApiError };
  if (!response.ok && body && typeof body === "object" && "error" in body && body.error) throw body.error;
  if (!response.ok) throw { code: `HTTP_${response.status}`, message: response.statusText } satisfies ApiError;
  return body;
}

export async function fetchCatalog(): Promise<StepCatalogEntry[]> {
  return (await json<{ steps: StepCatalogEntry[] }>(await fetch(`${BASE}/steps`))).steps;
}

export async function fetchGallery(): Promise<GalleryEntry[]> {
  return (await json<{ flows: GalleryEntry[] }>(await fetch(`${BASE}/gallery`))).flows;
}

/** The account that signs when no wallet is connected: its id only, never its key. */
export async function fetchOperator(): Promise<{ accountId: string | null; network: string }> {
  return json(await fetch(`${BASE}/operator`));
}

export async function validateFlow(
  flow: FlowInput,
  signal?: AbortSignal,
): Promise<{ ok: boolean; issues: FlowIssue[]; estimate?: FeeEstimate }> {
  const response = await fetch(`${BASE}/flows/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(flow),
    ...(signal ? { signal } : {}),
  });
  return json(response);
}

export async function generateScript(flow: FlowInput): Promise<string> {
  const response = await fetch(`${BASE}/flows/codegen`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(flow),
  });
  return (await json<{ source: string }>(response)).source;
}

export async function exportHarnessRecipe(flow: FlowInput): Promise<HarnessRecipe> {
  const response = await fetch(`${BASE}/flows/harness`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(flow),
  });
  return json<HarnessRecipe>(response);
}

/**
 * Run a flow and yield its events as they stream in. Errors the server
 * answers before streaming (invalid flow, guards, missing operator) are
 * thrown as ApiError.
 */
export async function* runFlowStream(
  flow: FlowInput,
  options: { runToken?: string | undefined; signal?: AbortSignal } = {},
): AsyncGenerator<RunEvent> {
  const response = await fetch(`${BASE}/flows/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/x-ndjson",
      ...(options.runToken ? { "x-launchblocks-token": options.runToken } : {}),
    },
    body: JSON.stringify(flow),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.headers.get("content-type")?.includes("ndjson")) {
    await json(response);
    throw { code: "UNEXPECTED_RESPONSE", message: "The server did not stream the run" } satisfies ApiError;
  }
  if (!response.body) throw { code: "NO_BODY", message: "The run response had no body" } satisfies ApiError;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line) as RunEvent;
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
  if (buffer.trim()) yield JSON.parse(buffer) as RunEvent;
}
