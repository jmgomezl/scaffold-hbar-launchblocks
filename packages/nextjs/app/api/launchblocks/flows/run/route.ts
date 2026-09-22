import { NextResponse } from "next/server";
import type { RunContext } from "@sh/launchblocks";
import { runFlow } from "@sh/launchblocks";
import { errorResponse, getRegistry, guardRun, operatorContext, readJsonBody } from "~~/services/launchblocks/server";

export const runtime = "nodejs";
// Five HTS/HCS steps take ~10–30 s on testnet; keep the route alive for that.
export const maxDuration = 120;

/**
 * Execute a flow with the server's operator account and return the full
 * RunResult (per-step status, outputs, Hashscan links, error + hint).
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
    };
    const result = await runFlow(flow, { registry, ctx });
    return NextResponse.json(result, { status: result.status === "succeeded" ? 200 : 422 });
  } catch (error) {
    return errorResponse(error);
  } finally {
    hedera?.client.close();
  }
}
