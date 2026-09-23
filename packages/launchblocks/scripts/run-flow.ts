/**
 * Run a flow from the terminal.
 *
 *   yarn core:run <flow.json | gallery-id> [--dry-run] [--codegen <out.ts>] [--env <path>] [--network <net>]
 *
 * Reads the operator from the environment (see packages/nextjs/.env.example);
 * without --env it loads packages/nextjs/.env, then ./.env. Every run writes
 * its RunResult to packages/launchblocks/runs/ so testnet activity is traceable.
 */
import { config as loadEnv } from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { generateLaunchScript } from "../src/codegen/typescript";
import { FlowValidationError, LaunchBlocksError } from "../src/errors";
import { GALLERY, galleryFlow } from "../src/gallery";
import { hederaContextFromEnv, parseNetwork } from "../src/hedera/client";
import type { RunContext } from "../src/registry/types";
import type { RunEvent, RunResult } from "../src/runner/runner";
import { runFlow } from "../src/runner/runner";
import { createDefaultRegistry } from "../src/steps";
import { findCallerFile } from "./paths";

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const RUNS_DIR = path.join(PACKAGE_ROOT, "runs");

type Args = { source: string; dryRun: boolean; codegen?: string; env?: string; network?: string };

function parseArgs(argv: string[]): Args {
  const args: Args = { source: "", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--codegen") args.codegen = next();
    else if (arg === "--env") args.env = next();
    else if (arg === "--network") args.network = next();
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else if (!args.source) args.source = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  if (!args.source) {
    throw new Error(
      `Usage: run-flow <flow.json | gallery-id> [--dry-run] [--codegen out.ts] [--env path] [--network net]\n` +
        `Gallery: ${GALLERY.map(entry => entry.id).join(", ")}`,
    );
  }
  return args;
}

function loadFlowDocument(source: string): unknown {
  const entry = galleryFlow(source);
  if (entry) return entry.flow;
  const { found, tried } = findCallerFile(source);
  if (!found) throw new Error(`No gallery flow or file named "${source}" (looked at ${tried.join(" and ")})`);
  return JSON.parse(readFileSync(found, "utf8"));
}

function loadEnvironment(explicit: string | undefined): void {
  const candidates = explicit
    ? [path.resolve(explicit)]
    : [path.join(PACKAGE_ROOT, "..", "nextjs", ".env"), path.resolve(".env")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      loadEnv({ path: candidate });
      console.log(`env: ${path.relative(process.cwd(), candidate) || candidate}`);
      return;
    }
  }
  if (explicit) throw new Error(`Env file not found: ${explicit}`);
}

function printEvent(event: RunEvent): void {
  switch (event.type) {
    case "flow:start":
      console.log(`\n▶ ${event.flowId} on ${event.network} (${event.stepCount} steps)\n`);
      break;
    case "step:start":
      console.log(`  … ${event.step.id} (${event.step.type})${event.step.label ? ` — ${event.step.label}` : ""}`);
      break;
    case "step:success":
      console.log(`  ✔ ${event.step.id} in ${event.step.durationMs} ms`);
      for (const link of event.step.links) console.log(`      ${link.label}: ${link.url}`);
      break;
    case "step:error":
      console.log(`  ✖ ${event.step.id}: ${event.step.error?.message}`);
      if (event.step.error?.hint) console.log(`      hint: ${event.step.error.hint}`);
      break;
    case "flow:end":
      break;
  }
}

function saveRun(result: RunResult): string {
  mkdirSync(RUNS_DIR, { recursive: true });
  const stamp = result.startedAt.replace(/[:.]/g, "-");
  const file = path.join(RUNS_DIR, `${result.flowId}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  return file;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const registry = createDefaultRegistry();
  const document = loadFlowDocument(args.source);
  const flow = registry.validateFlow(document);
  console.log(`flow: ${flow.id} — ${flow.name} (${flow.steps.length} steps, ${flow.network})`);

  if (args.codegen) {
    const script = generateLaunchScript(document, registry, { headerLines: [`Source: ${args.source}`] });
    writeFileSync(path.resolve(args.codegen), script);
    console.log(`codegen: wrote ${args.codegen}`);
  }

  if (args.dryRun) {
    flow.steps.forEach((step, index) => console.log(`  ${index + 1}. ${step.id} (${step.type})`));
    console.log("\nDry run: flow is valid; nothing was submitted.");
    return;
  }

  loadEnvironment(args.env);
  const hedera = hederaContextFromEnv(process.env, args.network ? { network: parseNetwork(args.network) } : {});
  console.log(`operator: ${hedera.operatorId.toString()} on ${hedera.network}`);

  const ctx: RunContext = {
    network: hedera.network,
    hedera,
    log: (level, message, meta) => {
      if (level === "debug") return;
      if (level === "error") console.error(`    [${level}] ${message}`, meta ?? "");
    },
  };

  try {
    const result = await runFlow(document, { registry, ctx, onEvent: printEvent });
    const saved = saveRun(result);
    console.log(
      `\n${result.status === "succeeded" ? "✔ Flow succeeded" : "✖ Flow failed"} — record: ${path.relative(process.cwd(), saved)}`,
    );
    if (result.status === "failed") process.exitCode = 1;
  } finally {
    hedera.client.close();
  }
}

main().catch(error => {
  if (error instanceof FlowValidationError) {
    console.error("Flow is invalid:");
    for (const issue of error.issues) console.error(`  ${issue.path}: ${issue.message}`);
  } else if (error instanceof LaunchBlocksError) {
    console.error(`${error.code}: ${error.message}`);
    if (error.hint) console.error(`hint: ${error.hint}`);
  } else {
    console.error(error instanceof Error ? error.message : error);
  }
  process.exitCode = 1;
});
