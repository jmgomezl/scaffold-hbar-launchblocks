/**
 * Export a flow as a Hedera Harness recipe, written into the project.
 *
 *   yarn core:harness <flow.json> [--force]
 *
 * Writes .harness/<flow-id>.spec.yaml and .harness/<flow-id>/ at the project
 * root, the same files the Launch Studio's export offers as a zip. Existing
 * files are kept unless --force is given.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { FlowValidationError, LaunchBlocksError } from "../src/errors";
import { generateHarnessRecipe, packageManagerFromUserAgent } from "../src/harness/recipe";
import { createDefaultRegistry } from "../src/steps";
import { PROJECT_ROOT, findCallerFile } from "./paths";

type Args = { source: string; force: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { source: "", force: false };
  for (const arg of argv) {
    if (arg === "--force") args.force = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
    else if (!args.source) args.source = arg;
    else throw new Error(`Unexpected argument ${arg}`);
  }
  if (!args.source) throw new Error("Usage: harness-recipe <flow.json> [--force]");
  return args;
}

function projectPackageManager(): string {
  const fromAgent = packageManagerFromUserAgent(process.env.npm_config_user_agent);
  if (fromAgent) return fromAgent;
  const manifest = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")) as {
    packageManager?: string;
  };
  return manifest.packageManager ?? "npm";
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const { found: file, tried } = findCallerFile(args.source);
  if (!file) throw new Error(`No flow file at ${tried.join(" or ")}`);
  const document: unknown = JSON.parse(readFileSync(file, "utf8"));

  const recipe = generateHarnessRecipe(document, createDefaultRegistry(), {
    packageManager: projectPackageManager(),
  });

  const clashes = recipe.files.map(entry => entry.path).filter(rel => existsSync(path.join(PROJECT_ROOT, rel)));
  if (clashes.length && !args.force) {
    throw new Error(`Recipe files already exist (use --force to overwrite):\n  ${clashes.join("\n  ")}`);
  }
  for (const entry of recipe.files) {
    const target = path.join(PROJECT_ROOT, entry.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, entry.content);
    console.log(`wrote ${entry.path}`);
  }

  console.log(`\nOne run costs about ${recipe.estimate.perRunHbar} ℏ.`);
  if (recipe.fundingHbar !== undefined) {
    console.log(`The harness funds its throwaway account with ${recipe.fundingHbar} ℏ and sweeps back the rest.`);
  }
  console.log(`\nCommit the recipe, then:\n  ${recipe.commands.validate}\n  ${recipe.commands.run}`);
}

try {
  main();
} catch (error) {
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
}
