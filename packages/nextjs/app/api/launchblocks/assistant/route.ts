import { NextResponse } from "next/server";
import { LaunchBlocksError } from "@sh/launchblocks";
import {
  assistantConfig,
  assistantMessages,
  parseQuestion,
  streamAnswer,
  takeQuestion,
} from "~~/services/launchblocks/assistant";
import {
  clientKey,
  crossSiteRefusal,
  envNumber,
  errorResponse,
  getRegistry,
  jsonError,
  readJsonBody,
} from "~~/services/launchblocks/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const NDJSON = "application/x-ndjson";

/** Whether the assistant is on here, and which model answers. Never the key. */
export async function GET() {
  const config = assistantConfig();
  return NextResponse.json({ enabled: config !== null, model: config?.model ?? null });
}

/**
 * Ask the studio's assistant. The answer streams back as NDJSON:
 * `{ "type": "text", "text": … }` lines as it is written, then `{ "type": "done" }`,
 * or `{ "type": "error", "error": { code, message, hint } }`. Problems found
 * before the answer starts come back as plain JSON errors instead.
 */
export async function POST(req: Request) {
  const elsewhere = crossSiteRefusal(req);
  if (elsewhere) return elsewhere;
  try {
    const parsed = parseQuestion(await readJsonBody(req));
    if (!parsed.ok) {
      return jsonError(400, "QUESTION_INVALID", "The question is missing, too long, or not in the expected shape", {
        issues: parsed.issues,
      });
    }
    const config = assistantConfig();
    if (!config) {
      return jsonError(503, "ASSISTANT_DISABLED", "The assistant is not set up on this deployment", {
        hint: "Set OPENAI_API_KEY in packages/nextjs/.env and restart the app.",
      });
    }
    const visitor = clientKey(req);
    const allowed = takeQuestion(visitor, {
      perVisitor: envNumber("LAUNCHBLOCKS_ASSISTANT_PER_HOUR", 30),
      total: envNumber("LAUNCHBLOCKS_ASSISTANT_TOTAL_PER_HOUR", 600),
    });
    if (!allowed.ok) {
      const minutes = Math.max(1, Math.ceil((allowed.resetAt - Date.now()) / 60_000));
      return jsonError(
        429,
        "ASSISTANT_RATE_LIMITED",
        "The assistant has answered as many questions as it may this hour",
        {
          hint: `Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
        },
      );
    }

    const messages = assistantMessages(getRegistry(), parsed.value);
    const encoder = new TextEncoder();
    const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          for await (const text of streamAnswer(config, messages, visitor, req.signal)) {
            controller.enqueue(line({ type: "text", text }));
          }
          controller.enqueue(line({ type: "done" }));
        } catch (error) {
          const known = error instanceof LaunchBlocksError;
          if (!known) console.error("[launchblocks:assistant]", error);
          controller.enqueue(
            line({
              type: "error",
              error: known
                ? { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) }
                : { code: "ASSISTANT_FAILED", message: "The assistant stopped unexpectedly" },
            }),
          );
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": `${NDJSON}; charset=utf-8`,
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
