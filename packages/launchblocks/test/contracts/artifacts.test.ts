import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hardhatArtifactsDir, loadHardhatArtifact } from "../../src/contracts/artifacts";
import { LaunchBlocksError } from "../../src/errors";

const ABI = [{ type: "constructor", inputs: [{ name: "token_", type: "address" }], stateMutability: "nonpayable" }];

let root: string;
let artifacts: string;

function writeArtifact(file: string, contract: string, bytecode = "0x6080") {
  const dir = path.join(artifacts, file);
  mkdirSync(dir, { recursive: true });
  const body = { contractName: contract, sourceName: `contracts/${file}`, abi: ABI, bytecode };
  writeFileSync(path.join(dir, `${contract}.json`), JSON.stringify(body));
  writeFileSync(path.join(dir, `${contract}.dbg.json`), JSON.stringify({ buildInfo: "x" }));
}

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof LaunchBlocksError ? error.code : "not a LaunchBlocksError";
  }
  return undefined;
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "lb-artifacts-"));
  artifacts = path.join(root, "packages/hardhat/artifacts/contracts");
  mkdirSync(artifacts, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("hardhatArtifactsDir", () => {
  it("walks up from a package to the project's Hardhat artifacts", () => {
    const nextjs = path.join(root, "packages/nextjs");
    mkdirSync(nextjs, { recursive: true });
    expect(hardhatArtifactsDir(nextjs, {})).toBe(artifacts);
  });

  it("prefers LAUNCHBLOCKS_ARTIFACTS_DIR", () => {
    expect(hardhatArtifactsDir(root, { LAUNCHBLOCKS_ARTIFACTS_DIR: "/somewhere/else" })).toBe("/somewhere/else");
  });
});

describe("loadHardhatArtifact", () => {
  it("finds a contract by name, skipping debug files", () => {
    writeArtifact("TokenLock.sol", "TokenLock");
    const artifact = loadHardhatArtifact("TokenLock", { dir: artifacts });
    expect(artifact).toMatchObject({
      contractName: "TokenLock",
      sourceName: "contracts/TokenLock.sol",
      bytecode: "0x6080",
    });
    expect(artifact.abi).toEqual(ABI);
  });

  it("asks for the file when two files declare the same name, and accepts it", () => {
    writeArtifact("A.sol", "Vault");
    writeArtifact("B.sol", "Vault");
    expect(codeOf(() => loadHardhatArtifact("Vault", { dir: artifacts }))).toBe("CONTRACT_NAME_AMBIGUOUS");
    expect(loadHardhatArtifact("B.sol:Vault", { dir: artifacts }).sourceName).toBe("contracts/B.sol");
  });

  it("explains what to do when the contract or the artifacts are missing", () => {
    expect(codeOf(() => loadHardhatArtifact("Nope", { dir: artifacts }))).toBe("CONTRACT_ARTIFACT_MISSING");
    expect(codeOf(() => loadHardhatArtifact("Nope", { dir: path.join(root, "absent") }))).toBe(
      "CONTRACT_ARTIFACTS_MISSING",
    );
    try {
      loadHardhatArtifact("Nope", { dir: artifacts });
    } catch (error) {
      expect((error as LaunchBlocksError).hint).toMatch(/hardhat:compile/);
    }
  });

  it("refuses interfaces and abstract contracts, which have no bytecode", () => {
    writeArtifact("IThing.sol", "IThing", "0x");
    expect(codeOf(() => loadHardhatArtifact("IThing", { dir: artifacts }))).toBe("CONTRACT_NOT_DEPLOYABLE");
  });

  it("rejects names that are not contract names", () => {
    expect(codeOf(() => loadHardhatArtifact("../../etc/passwd", { dir: artifacts }))).toBe("CONTRACT_NAME_INVALID");
  });
});
