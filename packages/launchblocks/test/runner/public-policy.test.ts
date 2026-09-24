import { describe, expect, it } from "vitest";

import { GALLERY } from "../../src/gallery";
import { createRegistry } from "../../src/registry/registry";
import { checkPublicFlow, publicRunHbarEstimate, publicStepGuard } from "../../src/runner/public-policy";
import { runFlow } from "../../src/runner/runner";
import { createDefaultRegistry } from "../../src/steps";
import { FAKE_STEPS, fakeRunContext } from "../helpers/fake-steps";

const registry = createDefaultRegistry();
const flowOf = (steps: unknown[]) =>
  registry.validateFlow({ schemaVersion: 1, id: "public", name: "Public", network: "testnet", steps });

const createToken = {
  id: "createToken",
  type: "hts.createToken",
  params: { name: "Demo", symbol: "DMO", initialSupply: "1000" },
};

describe("checkPublicFlow()", () => {
  it("lets every gallery launch through", () => {
    for (const entry of GALLERY) expect(checkPublicFlow(registry.validateFlow(entry.flow)), entry.id).toEqual([]);
  });

  it("refuses payable HBAR, targets typed in by hand, large deposits and long flows", () => {
    const flow = flowOf([
      {
        id: "drain",
        type: "contract.call",
        params: { contractId: "0.0.666", function: "function drain() payable", payableHbar: "500" },
      },
      { id: "swap", type: "saucerswap.swap", params: { tokenId: "0.0.777", hbarAmount: "1000" } },
    ]);
    expect(checkPublicFlow(flow).map(issue => issue.path)).toEqual([
      "steps[0].params.payableHbar",
      "steps[0].params.contractId",
      "steps[1].params.hbarAmount",
      "steps[1].params.tokenId",
    ]);
    expect(checkPublicFlow(flow, { maxSteps: 1, maxHbarPerStep: 25 })[0]).toMatchObject({ path: "steps" });
  });

  it("lets a view call read any contract", () => {
    const flow = flowOf([
      {
        id: "read",
        type: "contract.call",
        params: { contractId: "0.0.666", function: "function total() view returns (uint256)" },
      },
    ]);
    expect(checkPublicFlow(flow)).toEqual([]);
  });
});

describe("publicStepGuard()", () => {
  const flow = flowOf([
    createToken,
    { id: "associate", type: "hts.associate", params: { tokenId: "0.0.777" } },
    { id: "swap", type: "saucerswap.swap", params: { tokenId: "{{steps.createToken.tokenId}}", hbarAmount: "1" } },
  ]);
  const guard = publicStepGuard(flow);
  const swap = flow.steps[2]!;
  const earlier = { createToken: { tokenId: "0.0.500" }, associate: { tokenId: "0.0.777", accountId: "0.0.1" } };

  it("sends value to a token the run created", () => {
    expect(() => guard(swap, { tokenId: "0.0.500", hbarAmount: "10" }, earlier)).not.toThrow();
  });

  it("refuses a token an earlier step only named, such as one it associated", () => {
    expect(() => guard(swap, { tokenId: "0.0.777", hbarAmount: "1" }, earlier)).toThrow(
      expect.objectContaining({ code: "PUBLIC_RUN_REFUSED" }),
    );
  });

  it("caps an HBAR amount that only became known at run time", () => {
    expect(() => guard(swap, { tokenId: "0.0.500", hbarAmount: "80" }, earlier)).toThrow(/at most 25/);
  });

  it("stops the run at the refused step, after the steps before it", async () => {
    const fakeRegistry = createRegistry(FAKE_STEPS);
    const result = await runFlow(
      {
        schemaVersion: 1,
        id: "launch",
        name: "Launch",
        steps: [
          { id: "mint", type: "fake.makeToken", params: { symbol: "LB" } },
          { id: "spend", type: "fake.useToken", params: { tokenId: "{{steps.mint.tokenId}}", amount: 3 } },
        ],
      },
      {
        registry: fakeRegistry,
        ctx: fakeRunContext(),
        beforeStep: step => {
          if (step.id === "spend") throw Object.assign(new Error("refused"), { code: "PUBLIC_RUN_REFUSED" });
        },
      },
    );
    expect(result.steps.map(step => step.status)).toEqual(["succeeded", "failed"]);
    expect(result.error?.stepId).toBe("spend");
  });
});

describe("publicRunHbarEstimate()", () => {
  it("counts HBAR wired from an earlier step at the per-step cap", () => {
    const usd = registry.validateFlow(GALLERY.find(entry => entry.id === "hts-launch-usd-price")!.flow);
    const hero = registry.validateFlow(GALLERY.find(entry => entry.id === "hts-launch-saucerswap")!.flow);
    expect(publicRunHbarEstimate(usd)).toBeGreaterThanOrEqual(25);
    expect(publicRunHbarEstimate(hero)).toBeLessThan(80);
  });
});
