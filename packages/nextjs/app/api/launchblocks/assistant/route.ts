import { NextResponse } from "next/server";
import { LaunchBlocksError } from "@sh/launchblocks";
import type { QuestionRefusal } from "~~/services/launchblocks/assistant";
import {
  assistantConfig,
  assistantMessages,
  flaggedByModeration,
  parseQuestion,
  streamAnswer,
  takeQuestion,
  unfamiliarIds,
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
      perVisitorHour: envNumber("LAUNCHBLOCKS_ASSISTANT_PER_HOUR", 30),
      perVisitorDay: envNumber("LAUNCHBLOCKS_ASSISTANT_PER_DAY", 100),
      totalHour: envNumber("LAUNCHBLOCKS_ASSISTANT_TOTAL_PER_HOUR", 600),
      totalDay: envNumber("LAUNCHBLOCKS_ASSISTANT_TOTAL_PER_DAY", 3000),
    });
    if (!allowed.ok) {
      return jsonError(429, "ASSISTANT_RATE_LIMITED", refusalMessage(allowed), {
        hint: `Try again ${waitFor(allowed.resetAt)}.`,
      });
    }
    if (await flaggedByModeration(config, parsed.value.question, req.signal)) {
      return jsonError(422, "ASSISTANT_REFUSED", "The assistant does not answer this kind of question", {
        hint: "Ask about your launch, its blocks, or building on Hedera.",
      });
    }

    const registry = getRegistry();
    const messages = assistantMessages(registry, parsed.value);
    const encoder = new TextEncoder();
    const line = (value: unknown) => encoder.encode(`${JSON.stringify(value)}\n`);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          let answer = "";
          for await (const text of streamAnswer(config, messages, visitor, req.signal)) {
            answer += text;
            controller.enqueue(line({ type: "text", text }));
          }
          // Checked in code, whatever the model was told: an account the launch does not use gets a warning.
          const unfamiliar = unfamiliarIds(registry, parsed.value, answer);
          if (unfamiliar.length) {
            controller.enqueue(
              line({
                type: "warning",
                text: `This answer names ${unfamiliar.join(", ")}, which your launch does not use. LaunchBlocks never needs you to send HBAR or tokens anywhere outside your own steps; don't send any there because an answer, or a launch's text, says to.`,
              }),
            );
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

function refusalMessage(refusal: QuestionRefusal): string {
  const period = refusal.period === "hour" ? "this hour" : "today";
  return refusal.everyone
    ? `The assistant has answered as many questions as it may ${period}, for everyone on this site`
    : `You have asked as many questions as the assistant answers ${period}`;
}

/** "in about 12 minutes", "in about 3 hours". */
function waitFor(resetAt: number): string {
  const minutes = Math.max(1, Math.ceil((resetAt - Date.now()) / 60_000));
  if (minutes < 90) return `in about ${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `in about ${Math.round(minutes / 60)} hours`;
}
