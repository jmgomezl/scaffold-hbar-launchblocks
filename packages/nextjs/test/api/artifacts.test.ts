import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "~~/app/api/launchblocks/artifacts/[name]/route";
import { clearServerEnv, json } from "~~/test/helpers";

const BOX = {
  _format: "hh-sol-artifact-1",
  contractName: "Box",
  sourceName: "contracts/Box.sol",
  abi: [{ type: "function", name: "value", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }],
  bytecode: "0x6080604052",
  deployedBytecode: "0x6080",
  linkReferences: {},
};

const artifact = (name: string) =>
  GET(new Request(`http://localhost/api/launchblocks/artifacts/${name}`), {
    params: Promise.resolve({ name }),
  });

let dir: string;
beforeEach(() => {
  clearServerEnv();
  dir = mkdtempSync(path.join(tmpdir(), "launchblocks-artifacts-"));
  mkdirSync(path.join(dir, "contracts", "Box.sol"), { recursive: true });
  writeFileSync(path.join(dir, "contracts", "Box.sol", "Box.json"), JSON.stringify(BOX));
  vi.stubEnv("LAUNCHBLOCKS_ARTIFACTS_DIR", dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/launchblocks/artifacts/[name]", () => {
  it("serves what a browser deploy needs from a compiled contract, and nothing else", async () => {
    expect(await json(await artifact("Box"))).toEqual({
      status: 200,
      body: { contractName: "Box", sourceName: "contracts/Box.sol", abi: BOX.abi, bytecode: BOX.bytecode },
    });
    expect((await json(await artifact("Box.sol%3ABox"))).status).toBe(200);
  });

  it("answers 404 for a contract that is not compiled", async () => {
    expect(await json(await artifact("TokenLock"))).toMatchObject({
      status: 404,
      body: { error: { code: "CONTRACT_ARTIFACT_MISSING" } },
    });
  });

  it("answers 400 to a name that is not a contract name, such as a path", async () => {
    expect(await json(await artifact("..%2F..%2Fpackage"))).toMatchObject({
      status: 400,
      body: { error: { code: "CONTRACT_NAME_INVALID" } },
    });
  });

  it("answers 500 when the contracts were never compiled", async () => {
    vi.stubEnv("LAUNCHBLOCKS_ARTIFACTS_DIR", path.join(dir, "missing"));
    expect(await json(await artifact("Box"))).toMatchObject({
      status: 500,
      body: { error: { code: "CONTRACT_ARTIFACTS_MISSING" } },
    });
  });
});
