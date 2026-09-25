import { NextResponse } from "next/server";
import type { BeforeStep, RunContext, RunEvent } from "@sh/launchblocks";
import { LaunchBlocksError, loadHardhatArtifact, mirrorFromEnv, runFlow } from "@sh/launchblocks";
import type { RunGuard } from "~~/services/launchblocks/server";
import {
  crossSiteRefusal,
  errorResponse,
  getRegistry,
  guardRun,
  operatorContext,
  readJsonBody,
} from "~~/services/launchblocks/server";

type Release = Extract<RunGuard, { release: unknown }>["release"];

export const runtime = "nodejs";
// A full launch takes about a minute on testnet; the longest gallery flow, about 40 s of it in transactions.
export const maxDuration = 180;
/** `maxDuration` only binds on serverless hosts; this stops a run under `next start` too. */
const RUN_TIMEOUT_MS = 180_000;

const NDJSON = "application/x-ndjson";

/**
 * Execute a flow with the server's operator account.
 *
 * - `Accept: application/x-ndjson` streams one RunEvent per line as each
 *   step starts and finishes, ending with `flow:end` (or an `error` line).
 * - Otherwise the full RunResult is returned once the flow completes.
 *
 * Validation, guard, network and operator errors are always plain JSON
 * responses, sent before any streaming starts.
 */
export async function POST(req: Request) {
  let hedera: ReturnType<typeof operatorContext> | undefined;
  let release: Release | undefined;
  // Whether a step began, so a transaction may have gone out. A run that stops before that (no
  // operator, a failed preflight, a refusal) gives its share of the public budget back.
  let started = false;
  const noteStart = (event: RunEvent) => {
    if (event.type === "step:start") started = true;
  };
  const elsewhere = crossSiteRefusal(req);
  if (elsewhere) return elsewhere;
  try {
    const document = await readJsonBody(req);
    const registry = getRegistry();
    const flow = registry.validateFlow(document);

    // Before the guard, so a flow that could never run here uses none of the visitor's runs or the budget.
    const { network } = mirrorFromEnv(process.env);
    if (flow.network !== network) {
      throw new LaunchBlocksError(
        "NETWORK_MISMATCH",
        `This flow targets ${flow.network}, but the server's operator is on ${network}`,
        { hint: "Change the flow's network, or HEDERA_NETWORK in packages/nextjs/.env." },
      );
    }

    const guard = guardRun(req, flow);
    if ("refused" in guard) return guard.refused;
    release = guard.release;

    hedera = operatorContext();
    const ctx: RunContext = {
      network: hedera.network,
      hedera,
      log: (level, message, meta) => {
        if (level === "error" || level === "warn") console[level](`[launchblocks:${flow.id}] ${message}`, meta ?? "");
      },
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]),
      artifacts: name => loadHardhatArtifact(name),
    };
    const beforeStep = guard.beforeStep;

    if (req.headers.get("accept")?.includes(NDJSON)) {
      // The stream now owns the client and the guard's release.
      const client = hedera;
      const done = release;
      hedera = undefined;
      release = undefined;
      return new Response(
        streamRun(flow, registry, ctx, beforeStep, noteStart, () => {
          client.client.close();
          done({ sentNothing: !started });
        }),
        {
          headers: {
            "content-type": `${NDJSON}; charset=utf-8`,
            "cache-control": "no-store",
            // Stop reverse proxies (nginx) from buffering the stream.
            "x-accel-buffering": "no",
          },
        },
      );
    }

    const result = await runFlow(flow, { registry, ctx, onEvent: noteStart, ...(beforeStep ? { beforeStep } : {}) });
    return NextResponse.json(result, { status: result.status === "succeeded" ? 200 : 422 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    hedera?.client.close();
    release?.({ sentNothing: !started });
  }
}

type StreamLine = RunEvent | { type: "error"; error: { code: string; message: string; hint?: string } };

function streamRun(
  flow: unknown,
  registry: ReturnType<typeof getRegistry>,
  ctx: RunContext,
  beforeStep: BeforeStep | undefined,
  onEvent: (event: RunEvent) => void,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: StreamLine) => {
        if (line.type !== "error") onEvent(line);
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          // The client went away; the run still finishes and is logged server-side.
        }
      };
      try {
        await runFlow(flow, { registry, ctx, onEvent: send, ...(beforeStep ? { beforeStep } : {}) });
      } catch (error) {
        if (error instanceof LaunchBlocksError) {
          send({
            type: "error",
            error: { code: error.code, message: error.message, ...(error.hint ? { hint: error.hint } : {}) },
          });
        } else {
          console.error("[launchblocks] stream run failed", error);
          send({ type: "error", error: { code: "INTERNAL", message: "The run stopped unexpectedly" } });
        }
      } finally {
        onDone();
        controller.close();
      }
    },
  });
}
