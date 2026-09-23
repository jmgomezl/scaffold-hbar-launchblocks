import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { FlowValidationError, LaunchBlocksError } from "../../src/errors";
import { galleryFlow } from "../../src/gallery";
import {
  estimateFlowFees,
  generateHarnessRecipe,
  packageManagerFromUserAgent,
  scriptCommands,
} from "../../src/harness/recipe";
import { createDefaultRegistry } from "../../src/steps";

const registry = createDefaultRegistry();

/** A gallery flow under a new id, as the studio exports a renamed launch. */
function renamed(galleryId: string, id: string, overrides: Record<string, unknown> = {}) {
  const entry = galleryFlow(galleryId);
  if (!entry) throw new Error(`no gallery flow ${galleryId}`);
  return { ...structuredClone(entry.flow), id, name: "My market launch", ...overrides };
}

function file(recipe: ReturnType<typeof generateHarnessRecipe>, suffix: string): string {
  const found = recipe.files.find(entry => entry.path.endsWith(suffix));
  if (!found) throw new Error(`no file ending ${suffix}`);
  return found.content;
}

describe("generateHarnessRecipe", () => {
  const recipe = generateHarnessRecipe(renamed("hts-launch-saucerswap", "my-market-launch"), registry, {
    packageManager: "npm",
  });

  it("lays the recipe out beside the template's own, spec directly in .harness/", () => {
    expect(recipe.specPath).toBe(".harness/my-market-launch.spec.yaml");
    expect(recipe.files.map(entry => entry.path).sort()).toEqual(
      [
        ".harness/my-market-launch.spec.yaml",
        ".harness/my-market-launch/README.md",
        ".harness/my-market-launch/acceptance-contract.json",
        ".harness/my-market-launch/flow.json",
        ".harness/my-market-launch/prd.md",
        ".harness/my-market-launch/validators/commands.json",
        ".harness/my-market-launch/validators/playwright-smoke.yaml",
        ".harness/my-market-launch/validators/static.json",
      ].sort(),
    );
    expect(recipe.commands.run).toBe("npx hedera-harness run .harness/my-market-launch.spec.yaml");
  });

  it("writes a spec whose every path is a file of the recipe", () => {
    const spec = parseYaml(file(recipe, ".spec.yaml"));
    expect(spec).toMatchObject({
      schemaVersion: 2,
      name: "launchblocks-flow-my-market-launch",
      agent: "claude",
      maxAttempts: 3,
      validator: { enabled: true },
    });
    const referenced = [spec.prd, spec.contract, ...Object.values(spec.validators as Record<string, string>)];
    const paths = new Set(recipe.files.map(entry => entry.path));
    for (const reference of referenced) expect(paths).toContain(reference);
    expect(spec.baseline.commands.map((entry: { name: string }) => entry.name)).toContain("install");
  });

  it("runs the flow on testnet by its gallery id, as the harness's throwaway account", () => {
    const spec = parseYaml(file(recipe, ".spec.yaml"));
    expect(spec.chainValidation).toMatchObject({ enabled: true, network: "testnet", sweepBack: true });
    const deploy: string = spec.chainValidation.deploy.commands[0].command;
    expect(deploy).toContain('HEDERA_OPERATOR_ID="$HARNESS_SIGNER_ACCOUNT_ID"');
    expect(deploy).toContain('HEDERA_OPERATOR_KEY="$HARNESS_SIGNER_PRIVATE_KEY"');
    expect(deploy).toContain("HEDERA_OPERATOR_KEY_TYPE=ecdsa");
    expect(deploy.endsWith("npm run core:run -- my-market-launch")).toBe(true);
    expect(spec.chainValidation.fundingHbar).toBe(recipe.fundingHbar);
  });

  it("funds three attempts of the estimated cost with headroom", () => {
    // createToken 13, createLog 0.4, recordLaunch 0.1, seedPool 36 + 10, firstTrade 0.5 + 1, recordMarket 0.1
    expect(recipe.estimate.perRunHbar).toBe(61.1);
    expect(recipe.fundingHbar).toBe(Math.ceil(61.1 * 1.25 * 3));
  });

  it("ships the validated flow, and a static validator pinned to its ids and types", () => {
    const flow = JSON.parse(file(recipe, "flow.json"));
    expect(flow).toEqual(registry.validateFlow(renamed("hts-launch-saucerswap", "my-market-launch")));

    const validator = JSON.parse(file(recipe, "validators/static.json"));
    const target = "packages/launchblocks/flows/my-market-launch.json";
    expect(validator.fileAssertions.required).toContain(target);
    expect(validator.fileAssertions.forbidden).toContain("packages/nextjs/.env");
    expect(validator.jsonAssertions).toEqual([
      { file: target, path: "id", equals: "my-market-launch" },
      { file: target, path: "network", equals: "testnet" },
    ]);
    const pinned = validator.textAssertions[1];
    expect(pinned.file).toBe(target);
    for (const step of flow.steps as { id: string; type: string }[]) {
      expect(pinned.contains).toContain(`"id": "${step.id}"`);
      expect(pinned.contains).toContain(`"type": "${step.type}"`);
      // Pinned text must match the file as the recipe ships it.
      expect(file(recipe, "flow.json")).toContain(`"id": "${step.id}"`);
    }
    expect(validator.textAssertions[0]).toEqual({
      file: "packages/launchblocks/src/gallery.ts",
      contains: ["flows/my-market-launch.json", '"my-market-launch"'],
    });
  });

  it("gates on the CI checks and a dry run by gallery id, with no secrets", () => {
    const validator = JSON.parse(file(recipe, "validators/commands.json"));
    expect(validator.requiresNoSecrets).toBe(true);
    const commands = Object.fromEntries(
      validator.commands.map((entry: { name: string; command: string }) => [entry.name, entry.command]),
    );
    expect(commands["flow-dry-run"]).toBe("npm run core:run -- my-market-launch --dry-run");
    expect(commands["core-lint"]).toBe("npm run core:lint -- --max-warnings=0");
    expect(commands.install).toBe("npm install");
    expect(validator.forbiddenCommands).toEqual(["pnpm install", "pnpm run"]);
  });

  it("smoke-tests the example link, and grades the studio against the exported steps", () => {
    const smoke = parseYaml(file(recipe, "playwright-smoke.yaml"));
    expect(smoke.server.command).toBe("npm run next:dev");
    expect(smoke.routes).toContainEqual({ name: "example", path: "/launch?example=my-market-launch" });

    const contract = JSON.parse(file(recipe, "acceptance-contract.json"));
    expect(contract.assertions.map((entry: { id: string }) => entry.id)).toEqual(["C1", "C2", "C3", "C4"]);
    const c1 = contract.assertions[0].howToVerify.join("\n");
    expect(c1).toContain("'My market launch'");
    expect(c1).toContain("'Create HTS token', 'Create HCS topic', 'Log to HCS topic', 'Seed SaucerSwap pool'");
    expect(contract.assertions[3].howToVerify.join("\n")).toContain("'// 1. createToken:'");
  });

  it("tells the agent exactly where the flow goes, and to leave it unchanged", () => {
    const prd = file(recipe, "prd.md");
    expect(prd).toContain(
      "Copy `.harness/my-market-launch/flow.json` to `packages/launchblocks/flows/my-market-launch.json`",
    );
    expect(prd).toContain('id: "my-market-launch"');
    expect(prd).toContain("| 4 | `seedPool` | Seed SaucerSwap pool | `saucerswap.createPool` |");
    expect(prd).toContain("npm run core:run -- my-market-launch --dry-run");
  });

  it("checks the copy against the export with a command that really runs", () => {
    const validator = JSON.parse(file(recipe, "validators/commands.json"));
    const unchanged: string = validator.commands.find(
      (entry: { name: string }) => entry.name === "flow-unchanged",
    ).command;
    const root = mkdtempSync(path.join(tmpdir(), "lb-recipe-"));
    try {
      const source = file(recipe, "flow.json");
      mkdirSync(path.join(root, ".harness/my-market-launch"), { recursive: true });
      mkdirSync(path.join(root, "packages/launchblocks/flows"), { recursive: true });
      writeFileSync(path.join(root, ".harness/my-market-launch/flow.json"), source);
      writeFileSync(path.join(root, "packages/launchblocks/flows/my-market-launch.json"), source);
      expect(() => execSync(unchanged, { cwd: root, stdio: "pipe" })).not.toThrow();

      const edited = JSON.parse(source);
      edited.steps[3].params.hbarAmount = "11";
      writeFileSync(path.join(root, "packages/launchblocks/flows/my-market-launch.json"), JSON.stringify(edited));
      expect(() => execSync(unchanged, { cwd: root, stdio: "pipe" })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a flow that is already a gallery example", () => {
    const hero = galleryFlow("hts-launch-saucerswap")?.flow;
    expect(() => generateHarnessRecipe(hero, registry, { packageManager: "npm" })).toThrow(LaunchBlocksError);
    try {
      generateHarnessRecipe(hero, registry, { packageManager: "npm" });
    } catch (error) {
      expect((error as LaunchBlocksError).code).toBe("RECIPE_ALREADY_IN_GALLERY");
      expect((error as LaunchBlocksError).hint).toMatch(/new name/);
    }
  });

  it("refuses an invalid flow", () => {
    const broken = renamed("hts-launch-basic", "broken", { steps: [{ id: "x", type: "hts.nope", params: {} }] });
    expect(() => generateHarnessRecipe(broken, registry, { packageManager: "npm" })).toThrow(FlowValidationError);
  });

  it("stops at Tier 3 for a flow that is not on testnet", () => {
    const mainnet = generateHarnessRecipe(
      renamed("hts-launch-basic", "mainnet-launch", { network: "mainnet" }),
      registry,
      { packageManager: "npm" },
    );
    expect(mainnet.fundingHbar).toBeUndefined();
    expect(parseYaml(file(mainnet, ".spec.yaml")).chainValidation).toBeUndefined();
    expect(file(mainnet, "README.md")).toContain("## No on-chain tier");
    expect(file(mainnet, "prd.md")).not.toContain("on testnet with its own funded account");
  });
});

describe("estimateFlowFees", () => {
  it("doubles token creation for a token with custom fees, as measured", () => {
    const flow = registry.validateFlow(renamed("hts-launch-basic", "basic"));
    expect(flow.steps[0]?.params.fractionalFee).toBeDefined();
    // Measured on testnet: 26.42 HBAR in fees, 26.02 of them for the token.
    expect(estimateFlowFees(flow).lines[0]?.feeHbar).toBe(26);
    expect(estimateFlowFees(flow).perRunHbar).toBe(26.7);
  });

  it("counts an unlisted step type at the default", () => {
    const flow = registry.validateFlow(renamed("hts-launch-basic", "basic"));
    const unlisted = estimateFlowFees({ ...flow, steps: [{ id: "burn", type: "hts.burn", params: {} }] });
    expect(unlisted.lines[0]?.feeHbar).toBe(2);
  });

  it("leaves out HBAR amounts set by references, and says so", () => {
    const flow = registry.validateFlow(renamed("hts-launch-saucerswap", "refs"));
    const pool = flow.steps.find(step => step.id === "seedPool");
    if (pool) pool.params.hbarAmount = "{{steps.createToken.initialSupply}}";
    const estimate = estimateFlowFees(flow);
    expect(estimate.unknownAmounts).toEqual(["seedPool"]);
    expect(estimate.perRunHbar).toBe(51.1);
  });
});

describe("package managers", () => {
  it("puts -- before script arguments for npm only", () => {
    expect(scriptCommands("npm").run("core:run", "a --dry-run")).toBe("npm run core:run -- a --dry-run");
    expect(scriptCommands("pnpm@9.1.0").run("core:run", "a --dry-run")).toBe("pnpm core:run a --dry-run");
    expect(scriptCommands("pnpm").install).toBe("pnpm install");
    expect(scriptCommands("pnpm").forbidden).toEqual(["npm install", "npm run"]);
  });

  it("rejects a name that is not a package manager", () => {
    expect(() => scriptCommands("rm -rf /")).toThrow(LaunchBlocksError);
  });

  it("reads the package manager a script was started with", () => {
    expect(packageManagerFromUserAgent("pnpm/9.1.0 npm/? node/v22.3.0 darwin arm64")).toBe("pnpm");
    expect(packageManagerFromUserAgent("npm/10.8.1 node/v22.3.0 darwin arm64 workspaces/false")).toBe("npm");
    expect(packageManagerFromUserAgent(undefined)).toBeUndefined();
  });
});
