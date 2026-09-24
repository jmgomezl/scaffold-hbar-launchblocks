import { NextResponse } from "next/server";
import type { RunContext, RunEvent } from "@sh/launchblocks";
import { loadHardhatArtifact, runFlow } from "@sh/launchblocks";
import { errorResponse, getRegistry, guardRun, operatorContext, readJsonBody } from "~~/services/launchblocks/server";

export const runtime = "nodejs";
// A full launch (token, log, SaucerSwap pool) takes 15–30 s on testnet.
export const maxDuration = 120;

const NDJSON = "application/x-ndjson";

/**
 * Execute a flow with the server's operator account.
 *
 * - `Accept: application/x-ndjson` streams one RunEvent per line as each
 *   step starts and finishes, ending with `flow:end` (or an `error` line).
 * - Otherwise the full RunResult is returned once the flow completes.
 *
 * Validation, guard and operator errors are always plain JSON responses,
 * sent before any streaming starts.
 */
export async function POST(req: Request) {
  let hedera: ReturnType<typeof operatorContext> | undefined;
  try {
    const document = await readJsonBody(req);
    const registry = getRegistry();
    const flow = registry.validateFlow(document);

    const refused = guardRun(req, flow.network);
    if (refused) return refused;

    hedera = operatorContext();
    const ctx: RunContext = {
      network: hedera.network,
      hedera,
      log: (level, message, meta) => {
        if (level === "error" || level === "warn") console[level](`[launchblocks:${flow.id}] ${message}`, meta ?? "");
      },
      signal: req.signal,
      artifacts: name => loadHardhatArtifact(name),
    };

    if (req.headers.get("accept")?.includes(NDJSON)) {
      const client = hedera;
      hedera = undefined; // the stream now owns the client
      return new Response(
        streamRun(flow, registry, ctx, () => client.client.close()),
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

    const result = await runFlow(flow, { registry, ctx });
    return NextResponse.json(result, { status: result.status === "succeeded" ? 200 : 422 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    hedera?.client.close();
  }
}

type StreamLine = RunEvent | { type: "error"; error: { code: string; message: string } };

function streamRun(
  flow: unknown,
  registry: ReturnType<typeof getRegistry>,
  ctx: RunContext,
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
        await runFlow(flow, { registry, ctx, onEvent: send });
      } catch (error) {
        console.error("[launchblocks] stream run failed", error);
        send({ type: "error", error: { code: "INTERNAL", message: "The run stopped unexpectedly" } });
      } finally {
        onDone();
        controller.close();
      }
    },
  });
}
