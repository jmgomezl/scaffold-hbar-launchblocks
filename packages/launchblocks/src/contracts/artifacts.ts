import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { LaunchBlocksError } from "../errors";
import type { ContractArtifact } from "./types";
import { CONTRACT_NAME_PATTERN } from "./types";

/**
 * Compiled contracts from the project's Hardhat package, for the
 * `contract.deploy` step. Node-only: it reads `packages/hardhat/artifacts`,
 * which `yarn hardhat:compile` writes.
 */

const ARTIFACTS_FROM_ROOT = path.join("packages", "hardhat", "artifacts", "contracts");
const COMPILE_HINT = "Compile the Hardhat contracts first with yarn hardhat:compile, then run again.";

/**
 * The Hardhat artifacts directory: LAUNCHBLOCKS_ARTIFACTS_DIR when set, else
 * the first `packages/hardhat/artifacts/contracts` found walking up from
 * `from`, so the app, the CLI and a generated launch.ts all find it.
 */
export function hardhatArtifactsDir(from: string = process.cwd(), env = process.env): string | undefined {
  if (env.LAUNCHBLOCKS_ARTIFACTS_DIR) return path.resolve(env.LAUNCHBLOCKS_ARTIFACTS_DIR);
  let dir = path.resolve(from);
  for (;;) {
    const candidate = path.join(dir, ARTIFACTS_FROM_ROOT);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Every `<Name>.json` artifact under `dir`, skipping Hardhat's `.dbg.json` files. */
function artifactFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return artifactFiles(full);
    return entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json") ? [full] : [];
  });
}

export function loadHardhatArtifact(name: string, options: { dir?: string } = {}): ContractArtifact {
  if (!CONTRACT_NAME_PATTERN.test(name)) {
    throw new LaunchBlocksError("CONTRACT_NAME_INVALID", `"${name}" is not a contract name`, {
      hint: "Use the Solidity contract name, e.g. TokenLock, or File.sol:Name.",
    });
  }
  const dir = options.dir ?? hardhatArtifactsDir();
  if (!dir || !existsSync(dir)) {
    throw new LaunchBlocksError("CONTRACT_ARTIFACTS_MISSING", "No compiled Hardhat contracts were found", {
      hint: COMPILE_HINT,
    });
  }

  const [file, contract] = name.includes(":") ? (name.split(":") as [string, string]) : [undefined, name];
  const matches = artifactFiles(dir).filter(
    candidate =>
      path.basename(candidate) === `${contract}.json` &&
      (file === undefined || path.basename(path.dirname(candidate)) === path.basename(file)),
  );
  if (matches.length === 0) {
    throw new LaunchBlocksError("CONTRACT_ARTIFACT_MISSING", `No compiled contract named "${name}"`, {
      hint: `Check the name against packages/hardhat/contracts. ${COMPILE_HINT}`,
    });
  }
  if (matches.length > 1) {
    throw new LaunchBlocksError("CONTRACT_NAME_AMBIGUOUS", `More than one compiled contract is named "${contract}"`, {
      hint: "Qualify it with its file, e.g. TokenLock.sol:TokenLock.",
    });
  }

  const raw = JSON.parse(readFileSync(matches[0] as string, "utf8")) as Partial<ContractArtifact>;
  if (!raw.abi || !raw.bytecode || raw.bytecode === "0x") {
    throw new LaunchBlocksError("CONTRACT_NOT_DEPLOYABLE", `"${name}" has no bytecode to deploy`, {
      hint: "Interfaces and abstract contracts cannot be deployed; name a concrete contract.",
    });
  }
  return {
    contractName: raw.contractName ?? contract,
    sourceName: raw.sourceName ?? "",
    abi: raw.abi,
    bytecode: raw.bytecode,
  };
}
