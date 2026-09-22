import { describe, expect, it } from "vitest";
import { z } from "zod";

import { LaunchBlocksError } from "../../src/errors";
import { defineStep } from "../../src/registry/define-step";
import { createRegistry } from "../../src/registry/registry";
import { runFlow } from "../../src/runner/runner";
import { fakeRunContext } from "../helpers/fake-steps";

describe("runFlow() error propagation", () => {
  it("keeps the hint and code of LaunchBlocksErrors thrown by executors", async () => {
    const broke = defineStep({
      type: "fake.broke",
      input: z.object({}),
      output: z.object({}),
      outputExample: {},
      ui: { label: "Broke", category: "util", colour: 0, fields: [], outputs: [] },
      docs: { summary: "", hederaServices: [] },
      async execute(): Promise<Record<string, never>> {
        throw new LaunchBlocksError("HEDERA_INSUFFICIENT_PAYER_BALANCE", "no funds", { hint: "Use the faucet" });
      },
      codegen: () => ({ body: "" }),
    });
    const result = await runFlow(
      { schemaVersion: 1, id: "f", name: "f", steps: [{ id: "b", type: "fake.broke" }] },
      { registry: createRegistry([broke]), ctx: fakeRunContext() },
    );
    expect(result.error).toEqual({
      stepId: "b",
      code: "STEP_FAILED",
      causeCode: "HEDERA_INSUFFICIENT_PAYER_BALANCE",
      message: 'Step "b" (fake.broke) failed: no funds',
      hint: "Use the faucet",
    });
  });
});
