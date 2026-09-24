import { NextResponse } from "next/server";
import type { BeforeStep, RunContext, RunEvent } from "@sh/launchblocks";
import { LaunchBlocksError, loadHardhatArtifact, runFlow } from "@sh/launchblocks";
import { errorResponse, getRegistry, guardRun, operatorContext, readJsonBody } from "~~/services/launchblocks/server";

export const runtime = "nodejs";
// A full launch (token, log, SaucerSwap pool) takes 15–30 s on testnet.
export const maxDuration = 120;
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
  let release: (() => void) | undefined;
  try {
    const document = await readJsonBody(req);
    const registry = getRegistry();
    const flow = registry.validateFlow(document);

    const guard = guardRun(req, flow);
    if ("refused" in guard) return guard.refused;
    release = guard.release;

    hedera = operatorContext();
    if (flow.network !== hedera.network) {
      throw new LaunchBlocksError(
        "NETWORK_MISMATCH",
        `This flow targets ${flow.network}, but the server's operator is on ${hedera.network}`,
        { hint: "Change the flow's network, or HEDERA_NETWORK in packages/nextjs/.env." },
      );
    }
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
        streamRun(flow, registry, ctx, beforeStep, () => {
          client.client.close();
          done();
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

    const result = await runFlow(flow, { registry, ctx, ...(beforeStep ? { beforeStep } : {}) });
    return NextResponse.json(result, { status: result.status === "succeeded" ? 200 : 422 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    hedera?.client.close();
    release?.();
  }
}

type StreamLine = RunEvent | { type: "error"; error: { code: string; message: string; hint?: string } };

function streamRun(
  flow: unknown,
  registry: ReturnType<typeof getRegistry>,
  ctx: RunContext,
  beforeStep: BeforeStep | undefined,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: StreamLine) => {
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
