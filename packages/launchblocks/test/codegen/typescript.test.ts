import ts from "typescript";
import { describe, expect, it } from "vitest";

import { generateLaunchScript, renderExpr } from "../../src/codegen/typescript";
import { FlowValidationError } from "../../src/errors";
import { ref } from "../../src/flow/refs";
import { GALLERY } from "../../src/gallery";
import { createRegistry } from "../../src/registry/registry";
import { createDefaultRegistry } from "../../src/steps";
import { FAKE_STEPS } from "../helpers/fake-steps";

const registry = createRegistry(FAKE_STEPS);

const flow = {
  schemaVersion: 1,
  id: "launch",
  name: "Launch",
  description: "Mint then spend.",
  steps: [
    { id: "mint", type: "fake.makeToken", label: "Mint it", params: { symbol: "LB", decimals: 6 } },
    {
      id: "spend",
      type: "fake.useToken",
      params: { tokenId: ref("mint", "tokenId"), amount: 3, memo: `spent ${ref("mint", "tokenId")} today` },
    },
  ],
};

/** Fails on any syntax error so a broken template cannot slip through. */
function assertParses(source: string): void {
  const file = ts.createSourceFile("launch.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const diagnostics = (file as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
  expect(diagnostics.map(d => d.messageText)).toEqual([]);
}

describe("renderExpr()", () => {
  it("renders literals as JSON", () => {
    expect(renderExpr("LB")).toBe('"LB"');
    expect(renderExpr(6)).toBe("6");
    expect(renderExpr(true)).toBe("true");
    expect(renderExpr(null)).toBe("null");
    expect(renderExpr(undefined)).toBe("undefined");
  });

  it("renders a __proto__ key as a property, not a prototype", () => {
    // JSON.parse makes "__proto__" an own key, as a flow document read from JSON has it.
    const rendered = renderExpr(JSON.parse('{ "__proto__": 1, "a-b": 2 }'));
    expect(rendered).toBe('{ ["__proto__"]: 1, "a-b": 2 }');
  });

  it("renders whole references as member access", () => {
    expect(renderExpr(ref("mint", "tokenId"))).toBe("mint.tokenId");
  });

  it("renders interpolated strings as template literals with escaping", () => {
    expect(renderExpr(`spent ${ref("mint", "tokenId")} today`)).toBe("`spent ${mint.tokenId} today`");
    expect(renderExpr("`${x}` \\ " + ref("a", "b"))).toBe("`\\`\\${x}\\` \\\\ ${a.b}`");
  });

  it("renders arrays and objects recursively", () => {
    expect(renderExpr(["0.0.1", ref("mint", "tokenId")])).toBe('["0.0.1", mint.tokenId]');
    expect(renderExpr({ tokenId: ref("mint", "tokenId"), "odd-key": 1, empty: {} })).toBe(
      '{ tokenId: mint.tokenId, "odd-key": 1, empty: {} }',
    );
  });
});

describe("generateLaunchScript() naming and comments", () => {
  const registry = createDefaultRegistry();

  it("renames a step whose id matches an imported operation, and every reference to it", () => {
    const source = generateLaunchScript(GALLERY.find(entry => entry.id === "hts-launch-usd-price")!.flow, registry);
    expect(source).toContain('const priceInUsdResult = await step("priceInUsd", async () => {');
    expect(source).toContain("return await priceInUsd(ctx, {");
    expect(source).toContain("hbarAmount: priceInUsdResult.hbarAmount");
    expect(source).not.toMatch(/const priceInUsd =/);
  });

  it("checks outputs that may be null before passing them on", () => {
    const source = generateLaunchScript(
      GALLERY.find(entry => entry.id === "hts-launch-locked-liquidity")!.flow,
      registry,
    );
    expect(source).toContain('required(seedPool.lpTokenId, "seedPool.lpTokenId")');
    expect(source).toContain("function required<T>(");
  });

  it("writes an output into a string as the runner does, and closes the client even when a step fails", () => {
    const source = generateLaunchScript(
      {
        schemaVersion: 1,
        id: "text",
        name: "Text",
        network: "testnet",
        steps: [
          { id: "createToken", type: "hts.createToken", params: { name: "Demo", symbol: "DMO" } },
          { id: "log", type: "hcs.createTopic", params: {} },
          {
            id: "note",
            type: "hcs.submitMessage",
            params: {
              topicId: "{{steps.log.topicId}}",
              message: "max={{steps.createToken.maxSupplyUnits}} token={{steps.createToken.tokenId}}",
            },
          },
        ],
      },
      registry,
    );
    // null becomes "" as in the runner, not "null"; a plain string needs no helper.
    expect(source).toContain("`max=${asText(createToken.maxSupplyUnits)} token=${createToken.tokenId}`");
    expect(source).toContain("function asText(value: unknown): string {");
    expect(source).toMatch(/ {2}try \{\n[\s\S]*\n {2}\} finally \{\n {4}client\.close\(\);\n {2}\}/);
    expect(source).not.toContain("operatorKey");
  });

  it("keeps labels, names and descriptions inside their comments", () => {
    const source = generateLaunchScript(
      {
        schemaVersion: 1,
        id: "comments",
        name: "Name */ process.exit(1); /*",
        description: "First line\nSecond */ line",
        network: "testnet",
        steps: [
          {
            id: "createToken",
            type: "hts.createToken",
            label: "Label\nprocess.exit(1)",
            params: { name: "Demo", symbol: "DMO", initialSupply: "1" },
          },
        ],
      },
      registry,
    );
    expect(source).toContain("// 1. createToken: Label process.exit(1) (hts.createToken)");
    expect(source).not.toMatch(/^process\.exit/m);
    // The only "*/" left is the one that closes the header.
    expect(source.indexOf("*/")).toBe(source.indexOf(" */\n") + 1);
  });
});

describe("generateLaunchScript()", () => {
  const source = generateLaunchScript(flow, registry);

  it("produces syntactically valid TypeScript", () => {
    assertParses(source);
  });

  it("is deterministic", () => {
    expect(generateLaunchScript(flow, registry)).toBe(source);
  });

  it("declares one const per step, wrapped in the step helper, in flow order", () => {
    const mintAt = source.indexOf('const mint = await step("mint", async () => {');
    const spendAt = source.indexOf('const spend = await step("spend", async () => {');
    expect(mintAt).toBeGreaterThan(0);
    expect(spendAt).toBeGreaterThan(mintAt);
  });

  it("applies schema defaults for omitted params while keeping references", () => {
    const defaulted = generateLaunchScript(
      { ...flow, steps: [{ id: "mint", type: "fake.makeToken", params: { symbol: "LB" } }, flow.steps[1]] },
      registry,
    );
    expect(defaulted).toContain('return await fakeMakeToken("LB", 8);');
    expect(defaulted).toContain("fakeUseToken(mint.tokenId, 3,");
  });

  it("passes literals, references and interpolations through to step bodies", () => {
    expect(source).toContain('return await fakeMakeToken("LB", 6);');
    expect(source).toContain("return await fakeUseToken(mint.tokenId, 3, `spent ${mint.tokenId} today`);");
  });

  it("collects and deduplicates imports, sorted by specifier", () => {
    const importLines = source.split("\n").filter(line => line.startsWith("import "));
    expect(importLines).toEqual([
      'import { fakeMakeToken, fakeUseToken } from "./fake-sdk";',
      'import { hederaContextFromEnv } from "@sh/launchblocks";',
    ]);
  });

  it("documents the flow and its network in the header and bootstraps the operator", () => {
    expect(source).toMatch(/^\/\*\*\n \* Generated by LaunchBlocks from flow "launch" \(Launch\)\./);
    expect(source).toContain(" * Mint then spend.");
    expect(source).toContain('hederaContextFromEnv(process.env, { network: "testnet" })');
    expect(source).toContain("// 1. mint: Mint it (fake.makeToken)");
    expect(source).toContain("// 2. spend: fake.useToken");
    expect(source).toContain('console.log("Flow complete", { mint, spend });');
  });

  it("honours the core module and header options", () => {
    const custom = generateLaunchScript(flow, registry, {
      coreModule: "../src",
      headerLines: ["Source: flows/launch.json"],
    });
    expect(custom).toContain('import { hederaContextFromEnv } from "../src";');
    expect(custom).toContain(" * Source: flows/launch.json");
    assertParses(custom);
  });

  it("refuses invalid flows", () => {
    expect(() => generateLaunchScript({ ...flow, steps: [] }, registry)).toThrowError(FlowValidationError);
  });
});
