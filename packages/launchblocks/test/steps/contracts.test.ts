import { describe, expect, it } from "vitest";

import { renderExpr } from "../../src/codegen/typescript";
import { ref } from "../../src/flow/refs";
import type { AnyStepDefinition, CodegenContext } from "../../src/registry/types";
import { contractCall, contractDeploy } from "../../src/steps";

function codegenWith(step: AnyStepDefinition, params: Record<string, unknown>) {
  const imports: string[] = [];
  const ctx: CodegenContext = {
    stepId: "s",
    coreModule: "core",
    expr: key => renderExpr(params[key]),
    addImport: (_specifier, ...names) => imports.push(...names),
  };
  return { imports, ...step.codegen(ctx) };
}

function issues(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return (result.error?.issues ?? []).map(issue => `${issue.path.join(".")}: ${issue.message}`);
}

describe("contract.deploy input", () => {
  it("defaults to no token slots, no admin key and the measured gas", () => {
    expect(contractDeploy.input.parse({ contract: "TokenLock" })).toEqual({
      contract: "TokenLock",
      autoAssociations: 0,
      gas: 1_000_000,
      adminKey: false,
    });
  });

  it("refuses a gap between arguments", () => {
    const result = contractDeploy.input.safeParse({ contract: "TokenLock", arg1: "0.0.1", arg3: 60 });
    expect(issues(result)).toEqual(["arg2: fill the arguments in order, without gaps"]);
  });

  it("refuses something that is not a contract name", () => {
    expect(contractDeploy.input.safeParse({ contract: "rm -rf" }).success).toBe(false);
  });
});

describe("contract.call input", () => {
  const read = "function lockedAmount() view returns (uint256)";

  it("checks the filled arguments against the signature", () => {
    expect(contractCall.input.safeParse({ contractId: "0.0.5", function: read }).success).toBe(true);
    const extra = contractCall.input.safeParse({ contractId: "0.0.5", function: read, arg1: "1" });
    expect(issues(extra)).toEqual(["function: the function takes 0 arguments; 1 filled in"]);
    const short = contractCall.input.safeParse({
      contractId: "0.0.5",
      function: "function transfer(address to, uint256 amount) returns (bool)",
      arg1: "0.0.7",
    });
    expect(issues(short)).toEqual(["function: the function takes 2 arguments; 1 filled in"]);
  });

  it("explains a signature it cannot parse", () => {
    const result = contractCall.input.safeParse({ contractId: "0.0.5", function: "lockedAmount" });
    expect(issues(result)[0]).toMatch(/^function: expected a Solidity signature/);
  });
});

describe("contract codegen", () => {
  it("deploys a Hardhat artifact with the filled arguments, referencing earlier steps", () => {
    const { body, imports } = codegenWith(contractDeploy, {
      contract: "TokenLock",
      arg1: ref("seedPool", "lpTokenId"),
      arg2: ref("createToken", "treasury"),
      arg3: 2592000,
      autoAssociations: 1,
    });
    expect(imports).toEqual(["deployContract", "loadHardhatArtifact"]);
    expect(body).toContain('artifact: loadHardhatArtifact("TokenLock"),');
    expect(body).toContain("args: [seedPool.lpTokenId, createToken.treasury, 2592000],");
    expect(body).toContain("autoAssociations: 1,");
    expect(body).not.toContain("initialHbar");
  });

  it("calls a function by signature", () => {
    const { body } = codegenWith(contractCall, {
      contractId: ref("deployLock", "contractId"),
      function: "function lockedAmount() view returns (uint256)",
    });
    expect(body).toContain("contractId: deployLock.contractId,");
    expect(body).toContain('function: "function lockedAmount() view returns (uint256)",');
    expect(body).toContain("args: [],");
  });
});
