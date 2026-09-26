import type { ApiError } from "./api";
import type { FlowInput } from "@sh/launchblocks/editor";

/** Client for the studio's assistant (`/api/launchblocks/assistant`). */

export type AssistantStatus = { enabled: boolean; model: string | null };

export type ChatTurn = { role: "user" | "assistant"; content: string };

/** What the studio shows now, sent with each question so the answer is about this launch. */
export type AssistantContext = {
  flow?: FlowInput;
  detachedStepIds?: string[];
  runError?: { code: string; message: string; hint?: string; stepId?: string };
  focus?: { stepId?: string; type?: string };
  signer?: "operator" | "wallet";
};

const ENDPOINT = "/api/launchblocks/assistant";

export async function fetchAssistantStatus(): Promise<AssistantStatus> {
  const response = await fetch(ENDPOINT);
  if (!response.ok) return { enabled: false, model: null };
  return (await response.json()) as AssistantStatus;
}

/**
 * Ask one question and yield the answer's text as it streams in. Refusals
 * (not set up, too many questions) and failures mid-answer throw an ApiError.
 */
export async function* askAssistant(
  question: string,
  history: ChatTurn[],
  context: AssistantContext,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify({ question, history, ...context }),
    ...(signal ? { signal } : {}),
  });
  if (!response.headers.get("content-type")?.includes("ndjson") || !response.body) {
    const body = (await response.json().catch(() => ({}))) as { error?: ApiError };
    throw (
      body.error ?? ({ code: `HTTP_${response.status}`, message: "The assistant did not answer" } satisfies ApiError)
    );
  }

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
      if (line) {
        const event = JSON.parse(line) as { type: string; text?: string; error?: ApiError };
        if (event.type === "text" && event.text) yield event.text;
        if (event.type === "error" && event.error) throw event.error;
      }
      newline = buffer.indexOf("\n");
    }
    if (done) break;
  }
}
