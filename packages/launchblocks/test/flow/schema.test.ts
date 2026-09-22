import { describe, expect, it } from "vitest";

import { FlowSchema, StepIdSchema, StepTypeSchema } from "../../src/flow/schema";

const minimalFlow = {
  schemaVersion: 1,
  id: "hts-launch",
  name: "HTS launch",
  steps: [{ id: "createToken", type: "hts.createToken", params: { name: "Demo", symbol: "DEMO" } }],
} as const;

describe("FlowSchema", () => {
  it("accepts a minimal flow and applies defaults", () => {
    const flow = FlowSchema.parse(minimalFlow);
    expect(flow.network).toBe("testnet");
    expect(flow.steps[0]?.params).toEqual({ name: "Demo", symbol: "DEMO" });
  });

  it("defaults missing step params to an empty object", () => {
    const flow = FlowSchema.parse({ ...minimalFlow, steps: [{ id: "log", type: "hcs.createTopic" }] });
    expect(flow.steps[0]?.params).toEqual({});
  });

  it("rejects an empty step list", () => {
    const result = FlowSchema.safeParse({ ...minimalFlow, steps: [] });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate step ids and points at the second occurrence", () => {
    const result = FlowSchema.safeParse({
      ...minimalFlow,
      steps: [
        { id: "createToken", type: "hts.createToken" },
        { id: "associate", type: "hts.associate" },
        { id: "createToken", type: "hts.mint" },
      ],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find(i => i.message.includes("duplicate"));
    expect(issue?.path).toEqual(["steps", 2, "id"]);
    expect(issue?.message).toContain("steps[0]");
  });

  it("rejects unknown schema versions", () => {
    expect(FlowSchema.safeParse({ ...minimalFlow, schemaVersion: 2 }).success).toBe(false);
  });

  it.each(["Hts-Launch", "-lead", "trail-", "has space", ""])("rejects flow id %j", id => {
    expect(FlowSchema.safeParse({ ...minimalFlow, id }).success).toBe(false);
  });

  it.each(["testnet", "mainnet", "localnet"] as const)("accepts network %s", network => {
    expect(FlowSchema.parse({ ...minimalFlow, network }).network).toBe(network);
  });

  it("rejects unknown networks", () => {
    expect(FlowSchema.safeParse({ ...minimalFlow, network: "previewnet" }).success).toBe(false);
  });
});

describe("StepIdSchema", () => {
  it.each(["createToken", "a", "step2", "seedPoolV2"])("accepts %j", id => {
    expect(StepIdSchema.safeParse(id).success).toBe(true);
  });

  it.each(["CreateToken", "create-token", "create_token", "2step", "", "x".repeat(41)])("rejects %j", id => {
    expect(StepIdSchema.safeParse(id).success).toBe(false);
  });

  it.each(["new", "class", "await", "return"])("rejects JavaScript keyword %j", id => {
    const result = StepIdSchema.safeParse(id);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toContain("keyword");
  });

  it.each(["steps", "outputs", "ctx", "client"])("rejects reserved runtime identifier %j", id => {
    expect(StepIdSchema.safeParse(id).success).toBe(false);
  });
});

describe("StepTypeSchema", () => {
  it.each(["hts.createToken", "hcs.submitMessage", "saucerswap.seedPool", "a.b.c"])("accepts %j", type => {
    expect(StepTypeSchema.safeParse(type).success).toBe(true);
  });

  it.each(["createToken", "Hts.createToken", "hts.", ".create", "hts.Create", "hts-create"])("rejects %j", type => {
    expect(StepTypeSchema.safeParse(type).success).toBe(false);
  });
});
