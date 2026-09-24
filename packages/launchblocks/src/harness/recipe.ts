import { LaunchBlocksError } from "../errors";
import type { Flow } from "../flow/schema";
import { GALLERY } from "../gallery";
import type { StepRegistry } from "../registry/registry";

/**
 * Export a flow as a Hedera Harness recipe. The recipe asks a coding agent to
 * add the flow to the gallery unchanged, then grades the result: files and
 * wiring (Tier 0), the quality gates and a dry run (Tier 1), the app booting
 * (Tier 2), the studio offering the new example (Tier 3), and, for testnet
 * flows, the flow itself running on testnet as the harness's funded
 * throwaway account (Tier 3.5).
 *
 * The files sit beside the template's own recipe: `.harness/<flow-id>.spec.yaml`
 * and `.harness/<flow-id>/`. The harness takes the spec's parent directory as
 * the project root, so the spec must live directly in `.harness/`.
 */

export type HarnessRecipeOptions = {
  /**
   * The package manager that runs the project's scripts: a name, or package.json's
   * `packageManager` value (`name@version`). Generated commands use it.
   */
  packageManager: string;
  /** Agent preset the harness drives. */
  agent?: string;
  maxAttempts?: number;
  /**
   * What to do with a flow that is already a gallery example: refuse it (the
   * default), or export a copy under a new id and name, as the studio does.
   */
  galleryConflict?: "refuse" | "copy";
};

export type HarnessRecipeFile = { path: string; content: string };

export type FeeLine = { stepId: string; type: string; feeHbar: number; spentHbar: number };

export type FeeEstimate = {
  /** Network fees plus HBAR the flow hands over (pool deposits, swaps), for one run. */
  perRunHbar: number;
  lines: FeeLine[];
  /** Step ids whose `hbarAmount` is a reference, so the estimate leaves it out. */
  unknownAmounts: string[];
};

export type HarnessRecipe = {
  flowId: string;
  specPath: string;
  files: HarnessRecipeFile[];
  estimate: FeeEstimate;
  /** HBAR the harness moves to its throwaway account; absent when the flow is not on testnet. */
  fundingHbar?: number;
  commands: { doctor: string; validate: string; run: string };
  /** The gallery example this recipe copies, when it was exported under a new id and name. */
  copiedFrom?: { id: string; name: string };
};

/**
 * Network fees per step in HBAR, from testnet runs at about 7.7¢ per HBAR
 * (fees are priced in USD), rounded up. Unlisted step types count as
 * UNKNOWN_STEP_FEE_HBAR.
 */
export const STEP_FEE_HBAR: Readonly<Record<string, number>> = {
  "hts.createToken": 13,
  "hts.mint": 0.1,
  // 0.66 measured when the transfer uses up a recipient's automatic association slot.
  "hts.transfer": 0.7,
  "hts.associate": 0.7,
  "hts.airdrop": 1.5,
  "hcs.createTopic": 0.4,
  "hcs.submitMessage": 0.1,
  // ScheduleCreate measured at 0.128; the scheduled transaction's own fee is paid when it runs.
  "hss.scheduleTransfer": 0.3,
  "hss.scheduleMint": 0.3,
  "saucerswap.createPool": 36,
  "saucerswap.swap": 0.5,
  // FileCreate, FileAppend, ContractCreate and FileDelete: 15.97 measured for TokenLock.
  "contract.deploy": 16,
  // Reads are free; a TokenLock release() cost 0.05.
  "contract.call": 0.1,
};
export const UNKNOWN_STEP_FEE_HBAR = 2;
/** Custom fees double the token creation fee: 26.02 HBAR measured for the basic gallery flow's token, 12.82 without. */
const CUSTOM_FEE_SURCHARGE_HBAR = 13;
/** Room for exchange-rate moves between export and run. */
const FUNDING_HEADROOM = 1.25;

const DEFAULT_AGENT = "claude";
const DEFAULT_MAX_ATTEMPTS = 3;

/** Env files the harness must not find in the workspace (it checks the disk, not git). */
const ENV_FILES = [".env", "packages/nextjs/.env", "packages/launchblocks/.env", "packages/hardhat/.env"];

export function estimateFlowFees(flow: Flow): FeeEstimate {
  const unknownAmounts: string[] = [];
  const lines = flow.steps.map(step => {
    let feeHbar = STEP_FEE_HBAR[step.type] ?? UNKNOWN_STEP_FEE_HBAR;
    if (step.type === "hts.createToken" && (step.params.fractionalFee || step.params.fixedHbarFee)) {
      feeHbar += CUSTOM_FEE_SURCHARGE_HBAR;
    }
    let spentHbar = 0;
    const amount = step.params.hbarAmount;
    if (amount !== undefined) {
      const value = Number(amount);
      if (Number.isFinite(value) && value >= 0) spentHbar = value;
      else unknownAmounts.push(step.id);
    }
    return { stepId: step.id, type: step.type, feeHbar, spentHbar };
  });
  const perRunHbar = round2(lines.reduce((sum, line) => sum + line.feeHbar + line.spentHbar, 0));
  return { perRunHbar, lines, unknownAmounts };
}

/** How to invoke the project's package manager, without assuming which one it is. */
export function scriptCommands(packageManager: string) {
  const name = packageManager.split("@")[0]?.trim() ?? "";
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new LaunchBlocksError("PACKAGE_MANAGER_INVALID", `Unrecognised package manager "${packageManager}"`);
  }
  const npm = name === "npm";
  return {
    name,
    install: `${name} install`,
    /** With npm, `--` must separate the arguments meant for the script. */
    run: (script: string, args = "") =>
      npm ? `npm run ${script}${args ? ` -- ${args}` : ""}` : `${name} ${script}${args ? ` ${args}` : ""}`,
    /** Other managers' commands, which would write a second lockfile. */
    forbidden: ["npm", "pnpm"].filter(other => other !== name).flatMap(other => [`${other} install`, `${other} run`]),
  };
}

/**
 * Read the package manager from `npm_config_user_agent`, which every package
 * manager sets for the scripts it runs (e.g. `pnpm/9.1.0 npm/? node/v22.3.0`).
 */
export function packageManagerFromUserAgent(userAgent: string | undefined): string | undefined {
  const name = userAgent?.split("/")[0]?.trim();
  return name && /^[a-z][a-z0-9-]*$/.test(name) ? name : undefined;
}

export function generateHarnessRecipe(
  document: unknown,
  registry: StepRegistry,
  options: HarnessRecipeOptions,
): HarnessRecipe {
  let flow = registry.validateFlow(document);
  let copiedFrom: HarnessRecipe["copiedFrom"];
  if (isGalleryId(flow.id)) {
    if (options.galleryConflict !== "copy") {
      throw new LaunchBlocksError("RECIPE_ALREADY_IN_GALLERY", `"${flow.id}" is already a gallery example`, {
        hint: "Give the launch a new name (its id follows the name) so the recipe adds a new example.",
      });
    }
    copiedFrom = { id: flow.id, name: flow.name };
    flow = { ...flow, id: copyId(flow.id), name: `${flow.name} (copy)`.slice(0, 120) };
  }

  const pm = scriptCommands(options.packageManager);
  const agent = options.agent ?? DEFAULT_AGENT;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const estimate = estimateFlowFees(flow);
  const onChain = flow.network === "testnet";
  const fundingHbar = onChain ? Math.ceil(estimate.perRunHbar * FUNDING_HEADROOM * maxAttempts) : undefined;
  const labels = flow.steps.map(step => registry.get(step.type).ui.label);

  const dir = `.harness/${flow.id}`;
  const paths = {
    spec: `.harness/${flow.id}.spec.yaml`,
    readme: `${dir}/README.md`,
    prd: `${dir}/prd.md`,
    source: `${dir}/flow.json`,
    staticValidator: `${dir}/validators/static.json`,
    commandsValidator: `${dir}/validators/commands.json`,
    playwright: `${dir}/validators/playwright-smoke.yaml`,
    contract: `${dir}/acceptance-contract.json`,
    target: `packages/launchblocks/flows/${flow.id}.json`,
  };
  const commands = {
    doctor: `npx hedera-harness doctor ${paths.spec}`,
    validate: `npx hedera-harness validate ${paths.spec}`,
    run: `npx hedera-harness run ${paths.spec}`,
  };
  const ctx: RecipeContext = { flow, pm, agent, maxAttempts, estimate, fundingHbar, labels, paths, commands };

  return {
    flowId: flow.id,
    specPath: paths.spec,
    files: [
      { path: paths.spec, content: specYaml(ctx) },
      { path: paths.readme, content: readme(ctx) },
      { path: paths.prd, content: prd(ctx) },
      { path: paths.source, content: `${JSON.stringify(flow, null, 2)}\n` },
      { path: paths.staticValidator, content: json(staticValidator(ctx)) },
      { path: paths.commandsValidator, content: json(commandsValidator(ctx)) },
      { path: paths.playwright, content: playwrightSmoke(ctx) },
      { path: paths.contract, content: json(acceptanceContract(ctx)) },
    ],
    estimate,
    ...(fundingHbar !== undefined ? { fundingHbar } : {}),
    commands,
    ...(copiedFrom ? { copiedFrom } : {}),
  };
}

function isGalleryId(id: string): boolean {
  return GALLERY.some(entry => entry.id === id);
}

/** `<id>-copy`, or `<id>-copy-2` and so on, kept within the 64-character id limit. */
function copyId(id: string): string {
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? "-copy" : `-copy-${n}`;
    const candidate = `${id.slice(0, 64 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!isGalleryId(candidate)) return candidate;
  }
}

// ── Files ───────────────────────────────────────────────────────────────────

type RecipeContext = {
  flow: Flow;
  pm: ReturnType<typeof scriptCommands>;
  agent: string;
  maxAttempts: number;
  estimate: FeeEstimate;
  fundingHbar: number | undefined;
  labels: string[];
  paths: Record<
    | "spec"
    | "readme"
    | "prd"
    | "source"
    | "staticValidator"
    | "commandsValidator"
    | "playwright"
    | "contract"
    | "target",
    string
  >;
  commands: HarnessRecipe["commands"];
};

function specYaml({ flow, pm, agent, maxAttempts, estimate, fundingHbar, paths }: RecipeContext): string {
  const lines = [
    "# Generated by LaunchBlocks from the flow in the directory beside this file.",
    "schemaVersion: 2",
    "",
    `name: ${q(`launchblocks-flow-${flow.id}`)}`,
    `description: ${q(
      `Add the "${flow.name}" launch to the LaunchBlocks gallery, unchanged, by following the PRD and AGENTS.md. ` +
        "The Launch Studio must offer it with no frontend changes" +
        (fundingHbar !== undefined ? ", and it must run on testnet as the harness's funded throwaway account." : "."),
    )}`,
    "",
    `agent: ${q(agent)}`,
    `maxAttempts: ${maxAttempts}`,
    `prd: ${q(paths.prd)}`,
    "",
    "# Is the project healthy before the agent touches it?",
    "baseline:",
    "  commands:",
    ...command("install", pm.install, 600_000),
    ...command("core-test", pm.run("core:test"), 300_000),
    ...command("build", pm.run("next:build"), 600_000),
    "",
    "validators:",
    `  static: ${q(paths.staticValidator)}`,
    `  commands: ${q(paths.commandsValidator)}`,
    `  playwright: ${q(paths.playwright)}`,
    "",
    "# Tier 3: the adversarial validator grades the running studio against this.",
    `contract: ${q(paths.contract)}`,
    "validator:",
    "  enabled: true",
  ];

  if (fundingHbar !== undefined) {
    const breakdown = estimate.lines.map(
      line => `${line.stepId} ${line.feeHbar}${line.spentHbar ? ` + ${line.spentHbar} handed over` : ""}`,
    );
    lines.push(
      "",
      "# Tier 3.5. LaunchBlocks signs flows with a server-side operator, so the",
      "# funded throwaway account becomes the flow runner's operator, through",
      "# environment variables only. The runner exits non-zero if any step fails.",
      "chainValidation:",
      "  enabled: true",
      "  network: testnet",
      "  operator:",
      "    accountIdEnv: HEDERA_OPERATOR_ID",
      "    privateKeyEnv: HEDERA_OPERATOR_KEY",
      `  # One run costs about ${estimate.perRunHbar} HBAR: ${breakdown.join(", ")}.`,
      ...(estimate.unknownAmounts.length
        ? [`  # Not counted, set by references: the hbarAmount of ${estimate.unknownAmounts.join(", ")}.`]
        : []),
      `  # This covers ${maxAttempts} attempts with 25% headroom; sweepBack returns the rest.`,
      `  fundingHbar: ${fundingHbar}`,
      "  sweepBack: true",
      "  deploy:",
      "    commands:",
      // Deploy contract reads Hardhat's artifacts, which a fresh checkout does not have.
      ...(flow.steps.some(step => step.type === "contract.deploy")
        ? [
            "      - name: compile-contracts",
            `        command: ${q(pm.run("hardhat:compile"))}`,
            "        timeoutMs: 300000",
          ]
        : []),
      "      - name: flow-on-testnet",
      "        command: >-",
      "          HEDERA_NETWORK=testnet",
      '          HEDERA_OPERATOR_ID="$HARNESS_SIGNER_ACCOUNT_ID"',
      '          HEDERA_OPERATOR_KEY="$HARNESS_SIGNER_PRIVATE_KEY"',
      "          HEDERA_OPERATOR_KEY_TYPE=ecdsa",
      `          ${pm.run("core:run", flow.id)}`,
      "        timeoutMs: 600000",
    );
  } else {
    lines.push("", `# No on-chain tier: the flow targets ${flow.network}, and the harness funds accounts on testnet.`);
  }
  return `${lines.join("\n")}\n`;
}

function command(name: string, run: string, timeoutMs: number): string[] {
  return [`    - name: ${name}`, `      command: ${q(run)}`, `      timeoutMs: ${timeoutMs}`];
}

function prd({ flow, pm, labels, paths, fundingHbar }: RecipeContext): string {
  const table = flow.steps.map(
    (step, index) => `| ${index + 1} | \`${step.id}\` | ${labels[index]} | \`${step.type}\` |`,
  );
  const blurb = flow.description
    ? `Use the flow's description as the blurb: "${flow.description}"`
    : "Write a one-sentence blurb saying what the launch does, in the style of the existing entries.";
  return [
    `# Add the "${flow.name}" launch to the gallery`,
    "",
    `\`${paths.source}\` is a launch composed in the LaunchBlocks studio. Ship it with the app as a gallery example, **unchanged**, so anyone can open it in the Launch Studio, run it from the terminal, and export it.`,
    "",
    `Network: **${flow.network}**. Steps, in order:`,
    "",
    "| # | Step id | Block | Type |",
    "| --- | --- | --- | --- |",
    ...table,
    "",
    "## What to build",
    "",
    `1. Copy \`${paths.source}\` to \`${paths.target}\`. Do not change ids, params, labels or their order: a validator compares the two files.`,
    `2. Register it in \`packages/launchblocks/src/gallery.ts\`: import the JSON like the existing flows, and add a \`GALLERY\` entry after the existing ones with \`id: "${flow.id}"\` and \`title: "${flow.name}"\`. ${blurb}`,
    "3. Change nothing in `packages/nextjs`. The studio's example menu, `/launch?example=<id>` and the home page read the gallery.",
    "",
    "The core tests already check every gallery entry: it must validate, generate a script, and survive the editor round trip. If one fails, the flow uses something the registry no longer accepts; report it rather than editing the flow.",
    "",
    "## Done when",
    "",
    `- \`${pm.run("core:run", `${flow.id} --dry-run`)}\` validates the flow without touching the network.`,
    `- \`${pm.run("core:test")}\`, \`${pm.run("core:lint")}\`, \`${pm.run("core:check-types")}\`, \`${pm.run("next:lint")}\` and \`${pm.run("next:build")}\` pass.`,
    `- The Launch Studio lists "${flow.name}" under **Load an example…**, and it loads as a valid flow.`,
    ...(fundingHbar !== undefined
      ? ["- The harness runs the flow on testnet with its own funded account, and every step succeeds."]
      : []),
    "",
    "## Constraints",
    "",
    "- Follow AGENTS.md. Add no dependencies.",
    "- Never write an operator key or a `.env` file; the harness forbids env files in the workspace.",
    "",
  ].join("\n");
}

function readme({ flow, estimate, fundingHbar, maxAttempts, paths, commands }: RecipeContext): string {
  const tiers = [
    `| \`${paths.staticValidator}\` | 0 | The flow is copied to \`${paths.target}\` with the same ids and steps, and registered in \`gallery.ts\`. No env files. |`,
    `| \`${paths.commandsValidator}\` | 1 | Core tests, lint and types; the copy is identical to \`flow.json\`; a dry run of the flow by its gallery id; app lint and the production build. |`,
    `| \`${paths.playwright}\` | 2 | The app boots; \`/\`, \`/launch\`, \`/launch?example=${flow.id}\` and the gallery API render. |`,
    `| \`${paths.contract}\` | 3 | The studio offers the example, loads it as valid, and exports it; the gallery API lists it. |`,
    ...(fundingHbar !== undefined
      ? [
          `| \`${paths.spec}\` → \`chainValidation\` | 3.5 | The flow runs **on testnet** as the harness's funded throwaway account, by its gallery id. |`,
        ]
      : []),
  ];
  const funding =
    fundingHbar !== undefined
      ? [
          "## Funding",
          "",
          `One run costs about **${estimate.perRunHbar} ℏ** (network fees plus HBAR the flow hands over). The spec funds the throwaway account with **${fundingHbar} ℏ** from your operator, enough for ${maxAttempts} attempts with 25% headroom, and sweeps back what is left. Fees are priced in USD, so the HBAR figures move with the exchange rate; edit \`fundingHbar\` if needed.`,
          "",
          "| Step | Type | Fee ℏ | Handed over ℏ |",
          "| --- | --- | --- | --- |",
          ...estimate.lines.map(
            line => `| \`${line.stepId}\` | \`${line.type}\` | ${line.feeHbar} | ${line.spentHbar} |`,
          ),
          "",
          ...(estimate.unknownAmounts.length
            ? [
                `Not counted: the \`hbarAmount\` of ${estimate.unknownAmounts.map(id => `\`${id}\``).join(", ")}, which is set by a reference.`,
                "",
              ]
            : []),
        ]
      : [
          "## No on-chain tier",
          "",
          `The flow targets ${flow.network}; the harness funds its throwaway account on testnet, so this recipe stops at Tier 3.`,
          "",
        ];
  return [
    `# Hedera Harness recipe: ship "${flow.name}"`,
    "",
    "Exported from the LaunchBlocks Launch Studio. It asks a coding agent to add the launch in `flow.json` to the app's gallery, unchanged, then grades the result itself.",
    "",
    "| File | Tier | What it checks |",
    "| --- | --- | --- |",
    ...tiers,
    "",
    "## Running it",
    "",
    "1. Unzip the export at the project root (its paths start with `.harness/`) and commit it: `run` needs a clean working tree.",
    "2. The harness forbids env files in the workspace, and it checks the disk, not git. Move `packages/nextjs/.env` aside (or use a fresh scaffold), and export the operator that funds the run in your shell. It must be an ECDSA key.",
    "",
    "```bash",
    "export HEDERA_OPERATOR_ID=0.0.xxxxx",
    "export HEDERA_OPERATOR_KEY=<ECDSA private key>",
    `${commands.doctor}     # prerequisites and every path the recipe uses`,
    `${commands.validate}   # Tiers 0–2, no agent; fails until the flow is in the gallery`,
    `${commands.run}        # the agent, repairs, and every tier`,
    "```",
    "",
    "Tiers 2 and 3 need Playwright with Chromium, and the agent must be on your `PATH`.",
    "",
    ...funding,
  ].join("\n");
}

function staticValidator({ flow, paths }: RecipeContext) {
  return {
    name: `launchblocks-flow-${flow.id}-static`,
    description: `The "${flow.name}" flow is copied into the core package with the same ids and steps, and registered in the gallery. No env files in the workspace.`,
    // The harness reads JSON paths through objects only, not arrays, so the
    // steps are pinned by text here and compared whole by flow-unchanged.
    jsonAssertions: [
      { file: paths.target, path: "id", equals: flow.id },
      { file: paths.target, path: "network", equals: flow.network },
    ],
    fileAssertions: {
      required: ["README.md", "AGENTS.md", paths.spec, paths.prd, paths.source, paths.target],
      forbidden: ENV_FILES,
    },
    textAssertions: [
      { file: "packages/launchblocks/src/gallery.ts", contains: [`flows/${flow.id}.json`, `"${flow.id}"`] },
      {
        file: paths.target,
        contains: flow.steps.flatMap(step => [`"id": "${step.id}"`, `"type": "${step.type}"`]),
      },
    ],
  };
}

function commandsValidator({ flow, pm, paths }: RecipeContext) {
  const unchanged =
    `node -e "require('node:assert').deepStrictEqual(` + `require('./${paths.target}'), require('./${paths.source}'))"`;
  return {
    name: `launchblocks-flow-${flow.id}-commands`,
    description:
      "The quality gates CI runs for the core and the app, a check that the gallery copy is the exported flow, and a credential-free dry run of it by gallery id.",
    requiresNoSecrets: true,
    forbiddenCommands: pm.forbidden,
    commands: [
      { name: "install", command: pm.install, timeoutMs: 600_000, purpose: "Install workspace dependencies." },
      {
        name: "core-test",
        command: pm.run("core:test"),
        timeoutMs: 300_000,
        purpose:
          "Core unit tests, which validate every gallery flow, generate its script, and round-trip it through the editor model.",
      },
      {
        name: "core-lint",
        command: pm.run("core:lint", "--max-warnings=0"),
        timeoutMs: 180_000,
        purpose: "Lint the core package.",
      },
      {
        name: "core-types",
        command: pm.run("core:check-types"),
        timeoutMs: 180_000,
        purpose: "Strict type check of the core package.",
      },
      {
        name: "flow-unchanged",
        command: unchanged,
        timeoutMs: 60_000,
        purpose: "The gallery copy is exactly the exported flow.",
      },
      {
        name: "flow-dry-run",
        command: pm.run("core:run", `${flow.id} --dry-run`),
        timeoutMs: 120_000,
        purpose:
          "The flow resolves by its gallery id and validates end to end, references and all, without touching the network.",
      },
      {
        name: "next-lint",
        command: pm.run("next:lint", "--max-warnings=0"),
        timeoutMs: 180_000,
        purpose: "Lint the app.",
      },
      {
        name: "build",
        command: pm.run("next:build"),
        timeoutMs: 600_000,
        purpose: "Production build of the app, including its type check.",
      },
    ],
  };
}

function playwrightSmoke({ flow, pm }: RecipeContext): string {
  return [
    `name: ${q(`launchblocks-flow-${flow.id}-smoke`)}`,
    "server:",
    `  command: ${q(pm.run("next:dev"))}`,
    "  url: http://localhost:3000",
    "  timeoutMs: 180000",
    "defaults:",
    "  timeoutMs: 60000",
    "  # Blockly and the step catalog load after hydration.",
    "  hydrationTimeoutMs: 90000",
    "  # Wallet libraries in the scaffold shell log unrelated console errors; the",
    "  # acceptance contract checks behaviour instead.",
    "  failOnConsoleError: false",
    "routes:",
    "  - name: home",
    "    path: /",
    "  - name: launch-studio",
    "    path: /launch",
    "  - name: example",
    `    path: ${q(`/launch?example=${flow.id}`)}`,
    "  - name: gallery",
    "    path: /api/launchblocks/gallery",
    "forbidden:",
    "  visibleText:",
    "    - Application error",
    "    - Unhandled Runtime Error",
    "    - Build Error",
    "    - Could not load the step catalog",
    "",
  ].join("\n");
}

function acceptanceContract({ flow, labels }: RecipeContext) {
  const order = labels.map(label => `'${label}'`).join(", ");
  return {
    name: `launchblocks-flow-${flow.id}`,
    description: `Graded against the running app with no wallet and no operator credentials.${
      flow.network === "testnet"
        ? " The flow itself is proven on testnet by the chainValidation deploy hook before grading."
        : ""
    }`,
    baseUrl: "http://localhost:3000",
    assertions: [
      {
        id: "C1",
        statement: `The Launch Studio offers the new example: 'Load an example…' lists '${flow.name}', and choosing it loads a valid flow with the exported steps in order.`,
        howToVerify: [
          "Open http://localhost:3000/launch and wait up to 30 seconds for the block workspace to render.",
          `Open the 'Load an example…' dropdown and choose '${flow.name}' (accept the replace prompt if shown).`,
          `Confirm the Launch block contains, in order: ${order}.`,
          "Confirm the toolbar badge reads 'valid' and the Problems tab lists no problems.",
        ],
        severity: "critical",
        walletRequired: false,
        verifiableWithoutCredentials: true,
      },
      {
        id: "C2",
        statement: `The example opens straight from a link: /launch?example=${flow.id} loads it.`,
        howToVerify: [
          `In a fresh browser context, open http://localhost:3000/launch?example=${flow.id}.`,
          `Confirm the Launch block's name reads '${flow.name}' and it contains ${labels.length} step blocks.`,
          "Confirm the toolbar badge reads 'valid'.",
        ],
        severity: "critical",
        walletRequired: false,
        verifiableWithoutCredentials: true,
      },
      {
        id: "C3",
        statement: `The gallery API lists the flow under the id '${flow.id}' with its ${flow.steps.length} steps.`,
        howToVerify: [
          "Open http://localhost:3000/api/launchblocks/gallery.",
          `Confirm the JSON contains an entry whose id is '${flow.id}' and whose title is '${flow.name}'.`,
          `Confirm that entry's flow.steps has ${flow.steps.length} items with types, in order: ${flow.steps.map(step => `'${step.type}'`).join(", ")}.`,
        ],
        severity: "major",
        walletRequired: false,
        verifiableWithoutCredentials: true,
      },
      {
        id: "C4",
        statement: "Exporting the example produces a launch.ts with one section per step.",
        howToVerify: [
          `With '${flow.name}' loaded on /launch, click 'Export' and select the 'launch.ts' tab.`,
          `Confirm the code contains a comment line for each step, in order: ${flow.steps
            .map((step, index) => `'// ${index + 1}. ${step.id}:'`)
            .join(", ")}.`,
        ],
        severity: "major",
        walletRequired: false,
        verifiableWithoutCredentials: true,
      },
    ],
  };
}

/** JSON strings are valid YAML double-quoted scalars. */
function q(value: string): string {
  return JSON.stringify(value);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
