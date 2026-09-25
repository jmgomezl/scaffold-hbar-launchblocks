/**
 * Regenerate the README's step reference from the registry.
 *
 *   yarn core:docs           rewrite README.md
 *   yarn core:docs:check     exit 1 if README.md is out of date (used in CI)
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { injectBetweenMarkers, renderStepsTable } from "../src/docs/steps-table";
import { createDefaultRegistry } from "../src/steps";

const README = path.resolve(__dirname, "../../../README.md");
const check = process.argv.includes("--check");

const current = readFileSync(README, "utf8");
const next = injectBetweenMarkers(current, renderStepsTable(createDefaultRegistry()));

if (check) {
  if (next !== current) {
    console.error("README.md step reference is out of date. Run the core:docs script and commit the result.");
    process.exitCode = 1;
  } else {
    console.log("README.md step reference is up to date.");
  }
} else if (next !== current) {
  writeFileSync(README, next);
  console.log("Updated the step reference in README.md");
} else {
  console.log("README.md step reference already up to date.");
}
