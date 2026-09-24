import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { LaunchBlocksError } from "../../src/errors";
import { defineStep } from "../../src/registry/define-step";
import { createRegistry } from "../../src/registry/registry";
import { runFlow } from "../../src/runner/runner";
import { contractDeploy } from "../../src/steps/contract/deploy";
import { FAKE_STEPS, fakeRunContext } from "../helpers/fake-steps";

describe("step preflight", () => {
  it("refuses the run before the first step when a later step's needs are missing", async () => {
    const execute = vi.fn(async () => ({ done: true }));
    const needy = defineStep({
      type: "fake.needy",
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      outputExample: { done: true },
      ui: { label: "Needy", category: "util", colour: 0, fields: [], outputs: [] },
      docs: { summary: "Needs something.", hederaServices: [] },
      preflight: async () => {
        throw new LaunchBlocksError("NEEDS_MISSING", "missing");
      },
      execute,
      codegen: () => ({ body: "return { done: true };" }),
    });
    const registry = createRegistry([...FAKE_STEPS, needy]);
    const makeToken = vi.spyOn(FAKE_STEPS[0]!, "execute");
    await expect(
      runFlow(
        {
          schemaVersion: 1,
          id: "needy",
          name: "Needy",
          steps: [
            { id: "mint", type: "fake.makeToken", params: { symbol: "LB" } },
            { id: "needs", type: "fake.needy", params: {} },
          ],
        },
        { registry, ctx: fakeRunContext() },
      ),
    ).rejects.toMatchObject({ code: "NEEDS_MISSING" });
    expect(makeToken).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("contract.deploy preflight", () => {
  const ctx = (artifacts: (name: string) => Promise<never>) => ({ ...fakeRunContext(), artifacts }) as never;

  it("loads the contract it will deploy, so a missing compile is caught before the run", async () => {
    const artifacts = vi.fn(async () => {
      throw new LaunchBlocksError("CONTRACT_ARTIFACT_MISSING", 'No compiled contract named "TokenLock"');
    });
    await expect(contractDeploy.preflight!({ contract: "TokenLock" }, ctx(artifacts))).rejects.toMatchObject({
      code: "CONTRACT_ARTIFACT_MISSING",
    });
    expect(artifacts).toHaveBeenCalledWith("TokenLock");
  });

  it("leaves a contract name wired from an earlier step to the run", async () => {
    const artifacts = vi.fn();
    await contractDeploy.preflight!({ contract: "{{steps.pick.name}}" }, ctx(artifacts));
    expect(artifacts).not.toHaveBeenCalled();
  });
});
