import { NextResponse } from "next/server";
import type { BeforeStep, Flow, HederaContext, PublicRunLimits, StepRegistry } from "@sh/launchblocks";
import {
  DEFAULT_PUBLIC_RUN_LIMITS,
  FlowValidationError,
  LaunchBlocksError,
  checkPublicFlow,
  createDefaultRegistry,
  hederaContextFromEnv,
  packageManagerFromUserAgent,
  publicRunHbarEstimate,
  publicStepGuard,
} from "@sh/launchblocks";
import { readFileSync } from "node:fs";
import path from "node:path";
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

/**
 * The package manager this project runs its scripts with, for commands in
 * exported recipes: the one that started the server, else the root
 * package.json's `packageManager`, else npm.
 */
export function projectPackageManager(): string {
  const fromAgent = packageManagerFromUserAgent(process.env.npm_config_user_agent);
  if (fromAgent) return fromAgent;
  try {
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "..", "..", "package.json"), "utf8")) as {
      packageManager?: string;
    };
    if (manifest.packageManager) return manifest.packageManager;
  } catch {
    // Deployed without the monorepo around it.
  }
  return "npm";
}

/** Build the operator context for one request; the caller must close the client. */
export function operatorContext(): HederaContext {
  return hederaContextFromEnv(process.env);
}

export type ApiError = { error: { code: string; message: string; hint?: string; issues?: unknown } };

export function jsonError(status: number, code: string, message: string, extra: Partial<ApiError["error"]> = {}) {
  return NextResponse.json<ApiError>({ error: { code, message, ...extra } }, { status });
}

/** Errors that are not the request's fault. Everything else a LaunchBlocksError reports is a 400. */
const HTTP_STATUS: Readonly<Record<string, number>> = {
  CONTRACT_ARTIFACT_MISSING: 404,
  BODY_TOO_LARGE: 413,
  BODY_NOT_JSON: 415,
  NETWORK_MISMATCH: 409,
  // The server's own setup: contracts not compiled, no operator, a bad Hermes URL.
  CONTRACT_ARTIFACTS_MISSING: 500,
  CONTRACT_ARTIFACTS_UNAVAILABLE: 500,
  PYTH_URL_INVALID: 500,
  OPERATOR_MISSING: 503,
  // A service the server depends on failed or refused it.
  MIRROR_UNREACHABLE: 502,
  MIRROR_ERROR: 502,
  PYTH_UNREACHABLE: 502,
  PYTH_UPDATE_FAILED: 502,
  PYTH_API_KEY_REJECTED: 502,
  PYTH_NOT_ENTITLED: 502,
};

/** Map thrown errors to HTTP responses without leaking internals. */
export function errorResponse(error: unknown) {
  if (error instanceof FlowValidationError) {
    return jsonError(400, error.code, "Flow is invalid", { issues: error.issues });
  }
  if (error instanceof LaunchBlocksError) {
    const status = HTTP_STATUS[error.code] ?? 400;
    return jsonError(status, error.code, error.message, error.hint ? { hint: error.hint } : {});
  }
  console.error("[launchblocks]", error);
  return jsonError(500, "INTERNAL", "Unexpected server error");
}

/** Flows are a few KB; this leaves room for any the studio can build. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * The JSON body of a POST. It must be sent as application/json: a browser
 * sends that type cross-site only after a CORS preflight this app never
 * grants, so another site cannot post a form or text body in a visitor's name.
 */
export async function readJsonBody(req: Request): Promise<unknown> {
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new LaunchBlocksError("BODY_NOT_JSON", "Send the flow as application/json");
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new LaunchBlocksError("BODY_TOO_LARGE", `A request body may be at most ${MAX_BODY_BYTES / 1024} KB`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LaunchBlocksError("BODY_INVALID", "Request body must be JSON");
  }
}

// ── Run guards ──────────────────────────────────────────────────────────────

const RUN_TOKEN_HEADER = "x-launchblocks-token";
const DEFAULT_RUNS_PER_HOUR = 20;
const DEFAULT_PUBLIC_HBAR_PER_HOUR = 400;
const HOUR_MS = 60 * 60 * 1000;

type Window = { count: number; resetAt: number };
const windows = new Map<string, Window>();
/** Visitors with a run in progress; public deployments allow one each. */
const activeRuns = new Set<string>();
/** Worst-case HBAR of the public runs started in the last hour. */
let publicSpend: { at: number; hbar: number }[] = [];

/**
 * `release` ends the visitor's run. `sentNothing: true` also gives back its
 * share of the hourly budget, for a run that stopped before its first
 * transaction (a failed preflight, say).
 */
export type RunGuard =
  | { refused: NextResponse }
  | { release: (options?: { sentNothing?: boolean }) => void; beforeStep?: BeforeStep };

/** A limit from the environment; blank, negative or non-numeric values keep the default. */
const envNumber = (name: string, fallback: number) => {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

/**
 * Browsers say where a request comes from. A run spends the operator's HBAR,
 * so it must start from this app's own pages, not from a script on another site.
 */
function crossSite(req: Request): boolean {
  // Browsers set Sec-Fetch-Site and no page can forge it, and it holds behind a proxy that rewrites Host.
  const site = req.headers.get("sec-fetch-site");
  if (site) return site !== "same-origin" && site !== "none";
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== req.headers.get("host");
  } catch {
    return true;
  }
}

/**
 * Decide whether a run may start. Every deployment refuses mainnet without an
 * explicit flag, a missing shared token when one is set, and more runs per
 * hour per visitor than allowed (in memory, per instance).
 *
 * A public deployment (`LAUNCHBLOCKS_PUBLIC_DEMO=true`), whose operator pays
 * for anonymous visitors, also applies the core's public-run policy: value
 * only goes to tokens and contracts the run creates, capped per step; one run
 * at a time per visitor; and an hourly HBAR budget across all visitors.
 *
 * The caller must call `release()` when the run ends.
 */
/** A 403 for a run another site's page started, or null. Checked before anything else, the body included. */
export function crossSiteRefusal(req: Request): NextResponse | null {
  return crossSite(req)
    ? jsonError(403, "CROSS_SITE_REFUSED", "Runs start from this app's own pages", {
        hint: "Open the Launch Studio on this site and press Run there.",
      })
    : null;
}

export function guardRun(req: Request, flow: Flow): RunGuard {
  const elsewhere = crossSiteRefusal(req);
  if (elsewhere) return { refused: elsewhere };
  if (flow.network === "mainnet" && process.env.LAUNCHBLOCKS_ALLOW_MAINNET !== "true") {
    return {
      refused: jsonError(403, "MAINNET_DISABLED", "Mainnet runs are disabled on this deployment", {
        hint: "Set LAUNCHBLOCKS_ALLOW_MAINNET=true on the server to allow them.",
      }),
    };
  }

  const requiredToken = process.env.LAUNCHBLOCKS_RUN_TOKEN;
  if (requiredToken && req.headers.get(RUN_TOKEN_HEADER) !== requiredToken) {
    return {
      refused: jsonError(401, "RUN_TOKEN_REQUIRED", `Runs on this deployment need the ${RUN_TOKEN_HEADER} header`),
    };
  }

  const key = clientKey(req);
  const isPublic = process.env.LAUNCHBLOCKS_PUBLIC_DEMO === "true";
  const limits: PublicRunLimits = {
    maxSteps: DEFAULT_PUBLIC_RUN_LIMITS.maxSteps,
    maxHbarPerStep: envNumber("LAUNCHBLOCKS_PUBLIC_MAX_HBAR_PER_STEP", DEFAULT_PUBLIC_RUN_LIMITS.maxHbarPerStep),
  };
  let cost = 0;
  if (isPublic) {
    const issues = checkPublicFlow(flow, limits);
    if (issues.length) {
      return {
        refused: jsonError(403, "PUBLIC_RUN_REFUSED", "This flow does more than this public demo runs", {
          issues,
          hint: "The demo only sends value to tokens and contracts the launch creates. Run it on your own deployment, or sign with your own wallet.",
        }),
      };
    }
    if (activeRuns.has(key)) {
      return {
        refused: jsonError(429, "RUN_IN_PROGRESS", "Your previous run is still going", {
          hint: "Wait for it to finish, then run again.",
        }),
      };
    }
    const now = Date.now();
    publicSpend = publicSpend.filter(entry => entry.at > now - HOUR_MS);
    const spent = publicSpend.reduce((sum, entry) => sum + entry.hbar, 0);
    const budget = envNumber("LAUNCHBLOCKS_PUBLIC_HBAR_PER_HOUR", DEFAULT_PUBLIC_HBAR_PER_HOUR);
    cost = publicRunHbarEstimate(flow, limits);
    if (spent + cost > budget) {
      const retryIn = Math.ceil(((publicSpend[0]?.at ?? now) + HOUR_MS - now) / 60_000);
      return {
        refused: jsonError(429, "PUBLIC_BUDGET_SPENT", "This demo's HBAR budget for the hour is spent", {
          hint: `It frees up in about ${retryIn} minutes. You can also sign with your own testnet wallet.`,
        }),
      };
    }
  }

  const limit = envNumber("LAUNCHBLOCKS_RUNS_PER_HOUR", DEFAULT_RUNS_PER_HOUR);
  if (limit > 0) {
    const now = Date.now();
    if (windows.size > 10_000) for (const [k, w] of windows) if (w.resetAt <= now) windows.delete(k);
    const window = windows.get(key);
    if (!window || window.resetAt <= now) {
      windows.set(key, { count: 1, resetAt: now + HOUR_MS });
    } else if (window.count >= limit) {
      const retryIn = Math.ceil((window.resetAt - now) / 1000);
      return {
        refused: jsonError(429, "RATE_LIMITED", `Run limit of ${limit} per hour reached`, {
          hint: `Try again in ${retryIn} seconds, or run the flow locally with yarn core:run.`,
        }),
      };
    } else {
      window.count += 1;
    }
  }

  if (!isPublic) return { release: () => undefined };
  const spend = { at: Date.now(), hbar: cost };
  publicSpend.push(spend);
  activeRuns.add(key);
  let released = false;
  return {
    beforeStep: publicStepGuard(flow, limits),
    release: ({ sentNothing = false } = {}) => {
      if (released) return;
      released = true;
      activeRuns.delete(key);
      if (sentNothing) publicSpend = publicSpend.filter(entry => entry !== spend);
    },
  };
}

/**
 * The caller's address, as the reverse proxy saw it. X-Real-IP comes first:
 * proxies such as nginx overwrite it, whereas the first X-Forwarded-For entry
 * is whatever the client sent, so trusting it would let a script dodge the
 * limit by inventing a new address per request.
 */
function clientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const address = req.headers.get("x-real-ip")?.trim() || forwarded?.split(",").pop()?.trim() || "local";
  return visitorKey(address);
}

/**
 * One key per visitor, whatever form the address came in: IPv4-mapped IPv6
 * is plain IPv4, case and zero-compression do not matter, and one IPv6 host
 * usually holds a whole /64, so the /64 is the visitor.
 */
export function visitorKey(address: string): string {
  const text = address.trim().toLowerCase().replace(/%.*$/, "");
  const mapped = /^[0:]*ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (mapped) return mapped[1] as string;
  if (!text.includes(":")) return text;
  const [head = "", tail = ""] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = text.includes("::")
    ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return groups
    .slice(0, 4)
    .map(group => group.replace(/^0+(?=.)/, ""))
    .join(":");
}
