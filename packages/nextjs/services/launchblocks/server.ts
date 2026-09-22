import { NextResponse } from "next/server";
import type { HederaContext, StepRegistry } from "@sh/launchblocks";
import { FlowValidationError, LaunchBlocksError, createDefaultRegistry, hederaContextFromEnv } from "@sh/launchblocks";
import "server-only";

/**
 * Server-side plumbing shared by the LaunchBlocks API routes.
 * Nothing here is imported by client components.
 */

let registry: StepRegistry | undefined;

export function getRegistry(): StepRegistry {
  registry ??= createDefaultRegistry();
  return registry;
}

/** Build the operator context for one request; the caller must close the client. */
export function operatorContext(): HederaContext {
  return hederaContextFromEnv(process.env);
}

export type ApiError = { error: { code: string; message: string; hint?: string; issues?: unknown } };

export function jsonError(status: number, code: string, message: string, extra: Partial<ApiError["error"]> = {}) {
  return NextResponse.json<ApiError>({ error: { code, message, ...extra } }, { status });
}

/** Map thrown errors to HTTP responses without leaking internals. */
export function errorResponse(error: unknown) {
  if (error instanceof FlowValidationError) {
    return jsonError(400, error.code, "Flow is invalid", { issues: error.issues });
  }
  if (error instanceof LaunchBlocksError) {
    const status = error.code === "OPERATOR_MISSING" ? 503 : error.code === "NETWORK_MISMATCH" ? 409 : 400;
    return jsonError(status, error.code, error.message, error.hint ? { hint: error.hint } : {});
  }
  console.error("[launchblocks]", error);
  return jsonError(500, "INTERNAL", "Unexpected server error");
}

export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new LaunchBlocksError("BODY_INVALID", "Request body must be JSON");
  }
}

// ── Run guards ──────────────────────────────────────────────────────────────

const RUN_TOKEN_HEADER = "x-launchblocks-token";
const DEFAULT_RUNS_PER_HOUR = 20;

type Window = { count: number; resetAt: number };
const windows = new Map<string, Window>();

/**
 * Refuse runs that the deployment has not opted into: mainnet without an
 * explicit flag, missing shared token when one is configured, and more
 * runs per hour from one client than allowed (in-memory, per instance).
 */
export function guardRun(req: Request, network: string): NextResponse | null {
  if (network === "mainnet" && process.env.LAUNCHBLOCKS_ALLOW_MAINNET !== "true") {
    return jsonError(403, "MAINNET_DISABLED", "Mainnet runs are disabled on this deployment", {
      hint: "Set LAUNCHBLOCKS_ALLOW_MAINNET=true on the server to allow them.",
    });
  }

  const requiredToken = process.env.LAUNCHBLOCKS_RUN_TOKEN;
  if (requiredToken && req.headers.get(RUN_TOKEN_HEADER) !== requiredToken) {
    return jsonError(401, "RUN_TOKEN_REQUIRED", `Runs on this deployment need the ${RUN_TOKEN_HEADER} header`);
  }

  const limit = Number(process.env.LAUNCHBLOCKS_RUNS_PER_HOUR ?? DEFAULT_RUNS_PER_HOUR);
  if (Number.isFinite(limit) && limit > 0) {
    const key = clientKey(req);
    const now = Date.now();
    const window = windows.get(key);
    if (!window || window.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + 60 * 60 * 1000 });
    } else if (window.count >= limit) {
      const retryIn = Math.ceil((window.resetAt - now) / 1000);
      return jsonError(429, "RATE_LIMITED", `Run limit of ${limit} per hour reached`, {
        hint: `Try again in ${retryIn} seconds, or run the flow locally with yarn core:run.`,
      });
    } else {
      window.count += 1;
    }
  }
  return null;
}

function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}
