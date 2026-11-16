import { describe, expect, it } from "vitest";

import { renderExpr } from "../../src/codegen/typescript";
import { ref } from "../../src/flow/refs";
import { estimateFlowFees } from "../../src/harness/recipe";
import type { AnyStepDefinition, CodegenContext } from "../../src/registry/types";
import { PUBLIC_MAX_RUN_HBAR, checkPublicFlow, publicStepGuard } from "../../src/runner/public-policy";
import { createDefaultRegistry, hssSelfReleasingLock, hssVesting } from "../../src/steps";

const registry = createDefaultRegistry();
const DAY = 86_400;

function issues(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return (result.error?.issues ?? []).map(issue => `${issue.path.join(".")}: ${issue.message}`);
}

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

/** A launch that creates a token and a pool, then locks the LP tokens and vests team tokens. */
const launch = (lock: Record<string, unknown> = {}, vesting: Record<string, unknown> = {}) =>
  registry.validateFlow({
    schemaVersion: 1,
    id: "self-running",
    name: "Self-running",
    network: "testnet",
    steps: [
      { id: "createToken", type: "hts.createToken", params: { name: "Demo", symbol: "DMO", initialSupply: "1000000" } },
      {
        id: "seedPool",
        type: "saucerswap.createPool",
        params: { tokenId: "{{steps.createToken.tokenId}}", tokenAmount: "50000", hbarAmount: "10" },
      },
      {
        id: "lockLiquidity",
        type: "hss.selfReleasingLock",
        params: {
          tokenId: "{{steps.seedPool.lpTokenId}}",
          amount: "{{steps.seedPool.liquidity}}",
          beneficiary: "{{steps.createToken.treasuryAccountId}}",
          lockSeconds: 30 * DAY,
          ...lock,
        },
      },
      {
        id: "vestTeam",
        type: "hss.vesting",
        params: {
          tokenId: "{{steps.createToken.tokenId}}",
          amount: "100000",
          beneficiary: "{{steps.createToken.treasuryAccountId}}",
          startInSeconds: 60,
          intervalSeconds: 60,
          tranches: 3,
          ...vesting,
        },
      },
    ],
  });

describe("hss.selfReleasingLock input", () => {
  it("defaults the gas per run and leaves the HBAR to the schedule", () => {
    expect(
      hssSelfReleasingLock.input.parse({ tokenId: "0.0.5", amount: "1", beneficiary: "0.0.7", lockSeconds: 60 }),
    ).toEqual({ tokenId: "0.0.5", amount: "1", beneficiary: "0.0.7", lockSeconds: 60, scheduledGas: 2_000_000 });
  });

  it("refuses too little HBAR for the runs, and locks shorter than a minute or longer than two years", () => {
    const base = { tokenId: "0.0.5", amount: "1", beneficiary: "0.0.7" };
    expect(issues(hssSelfReleasingLock.input.safeParse({ ...base, lockSeconds: 90 * DAY, runHbar: "1" }))).toEqual([
      "runHbar: the network's runs for this lock need about 1.9 HBAR; leave it empty to send that",
    ]);
    expect(hssSelfReleasingLock.input.safeParse({ ...base, lockSeconds: 59 }).success).toBe(false);
    expect(hssSelfReleasingLock.input.safeParse({ ...base, lockSeconds: 731 * DAY }).success).toBe(false);
  });
});

describe("hss.vesting input", () => {
  const base = { tokenId: "0.0.5", amount: "1", beneficiary: "0.0.7", startInSeconds: 60 };

  it("keeps to the contract's limits: 1 to 120 tranches, at least a minute apart", () => {
    expect(hssVesting.input.safeParse({ ...base, intervalSeconds: 60, tranches: 120 }).success).toBe(true);
    expect(hssVesting.input.safeParse({ ...base, intervalSeconds: 59, tranches: 3 }).success).toBe(false);
    expect(hssVesting.input.safeParse({ ...base, intervalSeconds: 60, tranches: 121 }).success).toBe(false);
    expect(hssVesting.input.safeParse({ ...base, intervalSeconds: 60, tranches: 0 }).success).toBe(false);
  });

  it("refuses too little HBAR for the runs", () => {
    expect(
      issues(hssVesting.input.safeParse({ ...base, intervalSeconds: 30 * DAY, tranches: 12, runHbar: "5" })),
    ).toEqual(["runHbar: the network's runs for this vesting need about 21.1 HBAR; leave it empty to send that"]);
  });
});

describe("self-scheduling flows", () => {
  it("wire an LP token into a lock and a launch's token into vesting", () => {
    expect(launch().steps.map(step => step.type)).toEqual([
      "hts.createToken",
      "saucerswap.createPool",
      "hss.selfReleasingLock",
      "hss.vesting",
    ]);
  });

  it("count the HBAR parked for the runs in the fee estimate", () => {
    const lines = estimateFlowFees(launch()).lines.filter(line => line.type.startsWith("hss."));
    expect(lines.map(line => [line.type, line.feeHbar, line.spentHbar])).toEqual([
      ["hss.selfReleasingLock", 4, 0.2],
      ["hss.vesting", 4, 4],
    ]);
  });

  it("generate a script that loads the compiled contract", () => {
    const { body, imports } = codegenWith(hssSelfReleasingLock, {
      tokenId: ref("seedPool", "lpTokenId"),
      amount: ref("seedPool", "liquidity"),
      beneficiary: ref("createToken", "treasuryAccountId"),
      lockSeconds: 2592000,
      scheduledGas: 2000000,
    });
    expect(imports).toEqual(["createSelfReleasingLock", "loadHardhatArtifact"]);
    expect(body).toBe(
      [
        "return await createSelfReleasingLock(ctx, {",
        '  artifact: loadHardhatArtifact("SelfReleasingLock"),',
        "  tokenId: seedPool.lpTokenId,",
        "  amount: seedPool.liquidity,",
        "  beneficiary: createToken.treasuryAccountId,",
        "  lockSeconds: 2592000,",
        "  scheduledGas: 2000000,",
        "});",
      ].join("\n"),
    );
    expect(codegenWith(hssVesting, { tranches: 3 }).body).toContain('loadHardhatArtifact("VestingSchedule")');
  });
});

describe("self-scheduling in a public run", () => {
  it("is allowed when it pays this launch's treasury and parks little HBAR", () => {
    expect(checkPublicFlow(launch())).toEqual([]);
  });

  it("refuses another beneficiary, a token typed in by hand, and too much parked HBAR", () => {
    const flow = launch({ beneficiary: "0.0.666", tokenId: "0.0.777" }, { intervalSeconds: 30 * DAY, tranches: 12 });
    expect(checkPublicFlow(flow).map(issue => issue.path)).toEqual([
      "steps[2].params.beneficiary",
      "steps[2].params.tokenId",
      "steps[3].params.runHbar",
    ]);
    expect(PUBLIC_MAX_RUN_HBAR).toBe(5);
  });

  it("checks the resolved beneficiary and token at run time", () => {
    const flow = launch();
    const guard = publicStepGuard(flow);
    const lock = flow.steps[2]!;
    const earlier = {
      createToken: { tokenId: "0.0.500", treasuryAccountId: "0.0.4242" },
      seedPool: { lpTokenId: "0.0.501", pairId: "0.0.502" },
    };
    const input = { ...lock.params, tokenId: "0.0.501", amount: "1", beneficiary: "0.0.4242" };
    expect(() => guard(lock, input, earlier)).not.toThrow();
    expect(() => guard(lock, { ...input, beneficiary: "0.0.999" }, earlier)).toThrow(/treasury/);
    expect(() => guard(lock, { ...input, tokenId: "0.0.42" }, earlier)).toThrow(/not created by this launch/);
  });
});
