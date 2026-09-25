/**
 * Run a flow from the terminal.
 *
 *   yarn core:run <flow.json | gallery-id> [--dry-run] [--codegen <out.ts>] [--env <path>] [--network <net>] [--wallet]
 *
 * File paths are relative to the directory the command was typed in when the
 * package manager says (npm), else to the project root.
 * Reads the operator from the environment (see packages/nextjs/.env.example);
 * without --env it loads packages/nextjs/.env, then ./.env. Every run writes
 * its RunResult to packages/launchblocks/runs/ so testnet activity is traceable.
 *
 * --wallet signs through the SDK's local Wallet (a Signer holding the operator
 * key) instead of the operator client: the code path a browser wallet takes,
 * testable from the terminal.
 */
import { LocalProvider, Wallet } from "@hiero-ledger/sdk";
import { config as loadEnv } from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { generateLaunchScript } from "../src/codegen/typescript";
import { loadHardhatArtifact } from "../src/contracts/artifacts";
import { FlowValidationError, LaunchBlocksError } from "../src/errors";
import { GALLERY, galleryFlow } from "../src/gallery";
import { hederaContextFromEnv, parseNetwork } from "../src/hedera/client";
import type { HederaContext } from "../src/hedera/context";
import { walletHederaContext } from "../src/hedera/wallet";
import type { RunContext } from "../src/registry/types";
import type { RunEvent, RunResult } from "../src/runner/runner";
import { runFlow } from "../src/runner/runner";
import { createDefaultRegistry } from "../src/steps";
import { estimateFlowFees } from "../src/harness/recipe";
import { preflightFlow } from "../src/runner/runner";
import { PROJECT_ROOT, callerPath, findCallerFile } from "./paths";

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const RUNS_DIR = path.join(PACKAGE_ROOT, "runs");

type Args = {
  source: string;
  dryRun: boolean;
  wallet: boolean;
  help: boolean;
  codegen?: string;
  env?: string;
  network?: string;
};

const USAGE = [
  "Usage: run-flow <flow.json | gallery-id> [options]",
  "",
  "  --dry-run          validate, check what the steps need and estimate the cost; send nothing",
  "  --codegen <out.ts> also write the flow as a launch.ts script",
  "  --env <path>       read the operator from this env file (default: packages/nextjs/.env)",
  "  --network <net>    testnet, mainnet or localnet, instead of HEDERA_NETWORK",
  "  --wallet           sign through the SDK's local Wallet, the code path a browser wallet takes",
  "  -h, --help         show this",
].join("\n");

function parseArgs(argv: string[]): Args {
  const args: Args = { source: "", dryRun: false, wallet: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[i + 1];
      // `--codegen --dry-run` must not write a file named "--dry-run".
      if (value === undefined || value.startsWith("-")) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    // Yarn passes a `--` on to the script where npm drops it; skipping it lets one command work with both.
    if (arg === "--") continue;
    else if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--wallet") args.wallet = true;
    else if (arg === "--codegen") args.codegen = next();
    else if (arg === "--env") args.env = next();
    else if (arg === "--network") args.network = next();
    else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}\n\n${USAGE}`);
    else if (!args.source) args.source = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  if (!args.source && !args.help) throw new Error(`${USAGE}\n\n${galleryLine()}`);
  return args;
}

const galleryLine = () => `Gallery: ${GALLERY.map(entry => entry.id).join(", ")}`;

function loadFlowDocument(source: string): unknown {
  const entry = galleryFlow(source);
  if (entry) return entry.flow;
  const { found, tried } = findCallerFile(source);
  if (!found) throw new Error(`No gallery flow or file named "${source}" (looked at ${tried.join(" and ")})`);
  try {
    return JSON.parse(readFileSync(found, "utf8"));
  } catch (error) {
    throw new Error(`${found} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadEnvironment(explicit: string | undefined): void {
  const candidates = explicit
    ? findCallerFile(explicit).tried
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

/** A wallet context whose signer is the SDK's local Wallet for the operator account. */
async function asWallet(operator: HederaContext): Promise<HederaContext> {
  if (!operator.operatorKey) throw new Error("--wallet needs the operator key in the environment");
  const signer = new Wallet(operator.operatorId, operator.operatorKey, LocalProvider.fromClient(operator.client));
  return walletHederaContext({ signer, network: operator.network, mirrorBaseUrl: operator.mirrorBaseUrl });
}

const round = (hbar: number) => Math.round(hbar * 100) / 100;

function saveRun(result: RunResult): string {
  mkdirSync(RUNS_DIR, { recursive: true });
  const stamp = result.startedAt.replace(/[:.]/g, "-");
  const file = path.join(RUNS_DIR, `${result.flowId}-${stamp}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
  return file;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`${USAGE}\n\n${galleryLine()}`);
    return;
  }
  const registry = createDefaultRegistry();
  const document = loadFlowDocument(args.source);
  const flow = registry.validateFlow(document);
  console.log(`flow: ${flow.id} — ${flow.name} (${flow.steps.length} steps, ${flow.network})`);

  if (args.codegen) {
    const script = generateLaunchScript(document, registry, { headerLines: [`Source: ${args.source}`] });
    const out = callerPath(args.codegen);
    writeFileSync(out, script);
    console.log(`codegen: wrote ${path.relative(PROJECT_ROOT, out) || out}`);
  }

  if (args.dryRun) {
    // What a run checks before its first step, such as a contract that was never compiled.
    await preflightFlow(flow, registry, { network: flow.network, artifacts: name => loadHardhatArtifact(name) });
    const estimate = estimateFlowFees(flow);
    const cost = new Map(estimate.lines.map(line => [line.stepId, line.feeHbar + line.spentHbar]));
    flow.steps.forEach((step, index) =>
      console.log(`  ${index + 1}. ${step.id} (${step.type})  ~${round(cost.get(step.id) ?? 0)} ℏ`),
    );
    const unknown = estimate.unknownAmounts.length
      ? `, plus the HBAR that ${estimate.unknownAmounts.join(", ")} take from earlier steps`
      : "";
    console.log(`\nCosts about ${estimate.perRunHbar} ℏ on ${flow.network}${unknown}.`);
    console.log("Dry run: flow is valid; nothing was submitted.");
    return;
  }

  loadEnvironment(args.env);
  const operator = hederaContextFromEnv(process.env, args.network ? { network: parseNetwork(args.network) } : {});
  const hedera = args.wallet ? await asWallet(operator) : operator;
  console.log(
    `operator: ${hedera.operatorId.toString()} on ${hedera.network}${args.wallet ? ", signing through a local Wallet" : ""}`,
  );

  const ctx: RunContext = {
    network: hedera.network,
    hedera,
    log: (level, message, meta) => {
      if (level === "debug") return;
      if (level === "error") console.error(`    [${level}] ${message}`, meta ?? "");
    },
    artifacts: name => loadHardhatArtifact(name),
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
    if (hedera !== operator) operator.client.close();
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
