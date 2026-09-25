import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { generateLaunchScript } from "../codegen/typescript";
import { loadHardhatArtifact } from "../contracts/artifacts";
import { studioLinkFor } from "../editor/share";
import { FlowValidationError, LaunchBlocksError } from "../errors";
import type { Network } from "../flow/schema";
import { GALLERY, galleryFlow } from "../gallery";
import { estimateFlowFees } from "../harness/recipe";
import type { HederaContext } from "../hedera/context";
import { readLaunch } from "../launches/read";
import { stepCatalog } from "../registry/catalog";
import type { StepRegistry } from "../registry/registry";
import { runFlow } from "../runner/runner";
import { createDefaultRegistry } from "../steps";
import { LAUNCHBLOCKS_VERSION } from "../version";

/**
 * LaunchBlocks as an MCP server, so a coding agent (Claude Code, Cursor, …)
 * can compose launches the way the studio does: read the step catalog,
 * write a flow, validate it and see its cost, then hand it to a person as a
 * studio link, export it as launch.ts, or run it. `run_flow` dry-runs unless
 * the agent passes `dryRun: false`, and a real run needs an operator in the
 * environment and stays off mainnet unless LAUNCHBLOCKS_ALLOW_MAINNET is set.
 */

export type LaunchBlocksMcpOptions = {
  registry?: StepRegistry;
  /** The studio's origin, for share links and launch pages. */
  studioUrl: string;
  /** The network and mirror node `read_launch` reads. */
  mirror: { network: Network; mirrorBaseUrl: string };
  /** Builds the operator context for a real run; without it, `run_flow` only dry-runs. */
  operator?: () => HederaContext;
  allowMainnet?: boolean;
  /** Where run progress goes. stdout belongs to the protocol, so the stdio server logs to stderr. */
  log?: (message: string) => void;
};

const INSTRUCTIONS = `LaunchBlocks composes Hedera token launches from steps (HTS, HCS, HSS, SaucerSwap, Pyth, contracts).
A flow is JSON: { "schemaVersion": 1, "id": "kebab-id", "name": "…", "network": "testnet", "steps": [{ "id": "camelCaseId", "type": "hts.createToken", "params": { … } }] }.
A param can use an earlier step's output with "{{steps.<stepId>.<outputKey>}}".
Work like this: list_steps (and get_step for a type's exact params), or start from get_example; then validate_flow until ok,
which also estimates the HBAR it costs; then share_link to open it in the studio, generate_script for launch.ts, or run_flow
(a dry run by default; pass dryRun: false only when the user asked to spend testnet HBAR). read_launch shows a finished
launch from its HCS log.`;

const FLOW = z
  .record(z.string(), z.unknown())
  .describe("A flow document: { schemaVersion: 1, id, name, network, steps: [{ id, type, params }] }.");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const reply = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

/** Errors go back to the agent as data it can act on: the code, the hint, and for a flow, every issue. */
function failure(error: unknown): ToolResult {
  if (error instanceof FlowValidationError) {
    return { ...reply({ code: error.code, message: "The flow is invalid", issues: error.issues }), isError: true };
  }
  if (error instanceof LaunchBlocksError) {
    return { ...reply({ code: error.code, message: error.message, hint: error.hint }), isError: true };
  }
  return {
    ...reply({ code: "INTERNAL", message: error instanceof Error ? error.message : String(error) }),
    isError: true,
  };
}

async function answer(work: () => unknown): Promise<ToolResult> {
  try {
    return reply(await work());
  } catch (error) {
    return failure(error);
  }
}

export function createLaunchBlocksMcpServer(options: LaunchBlocksMcpOptions): McpServer {
  const registry = options.registry ?? createDefaultRegistry();
  const catalog = stepCatalog(registry);
  const log = options.log ?? (() => undefined);
  const server = new McpServer({ name: "launchblocks", version: LAUNCHBLOCKS_VERSION }, { instructions: INSTRUCTIONS });

  const check = (flow: unknown) => {
    const result = registry.checkFlow(flow);
    return result.flow
      ? { ok: true as const, flow: result.flow, issues: [], estimate: estimateFlowFees(result.flow) }
      : { ok: false as const, flow: null, issues: result.issues };
  };

  server.registerTool(
    "list_steps",
    {
      title: "List step types",
      description:
        "Every step type a flow can use: what it does, its params (key and kind) and the outputs later steps can reference.",
      annotations: { readOnlyHint: true },
    },
    () =>
      answer(() =>
        catalog.map(entry => ({
          type: entry.type,
          label: entry.ui.label,
          summary: entry.docs.summary,
          services: entry.docs.hederaServices,
          params: entry.ui.fields.map(field => ({ key: field.key, kind: field.kind, label: field.label })),
          outputs: entry.ui.outputs.map(output => output.key),
        })),
      ),
  );

  server.registerTool(
    "get_step",
    {
      title: "Describe a step type",
      description: "One step type in full: the JSON Schema of its params, an example of its outputs, and its docs.",
      inputSchema: { type: z.string().describe('A step type, e.g. "saucerswap.createPool".') },
      annotations: { readOnlyHint: true },
    },
    ({ type }) =>
      answer(() => {
        const entry = catalog.find(candidate => candidate.type === type);
        if (!entry) {
          throw new LaunchBlocksError("STEP_UNKNOWN", `No step type "${type}"`, { hint: "list_steps names them all." });
        }
        return entry;
      }),
  );

  server.registerTool(
    "list_examples",
    {
      title: "List example launches",
      description: "The gallery's ready-made flows, a good starting point to adapt.",
      annotations: { readOnlyHint: true },
    },
    () =>
      answer(() =>
        GALLERY.map(entry => ({
          id: entry.id,
          title: entry.title,
          blurb: entry.blurb,
          steps: entry.flow.steps.map(step => step.type),
        })),
      ),
  );

  server.registerTool(
    "get_example",
    {
      title: "Get an example flow",
      description: "The flow JSON of one gallery example.",
      inputSchema: { id: z.string().describe('A gallery id from list_examples, e.g. "hts-launch-basic".') },
      annotations: { readOnlyHint: true },
    },
    ({ id }) =>
      answer(() => {
        const entry = galleryFlow(id);
        if (!entry)
          throw new LaunchBlocksError("EXAMPLE_UNKNOWN", `No example "${id}"`, {
            hint: "list_examples names them all.",
          });
        return entry.flow;
      }),
  );

  server.registerTool(
    "validate_flow",
    {
      title: "Validate a flow",
      description:
        "Check a flow against every step's schema and its references, as the studio and runner do. When it is valid, also estimate what one run costs in HBAR (network fees plus HBAR deposited or spent).",
      inputSchema: { flow: FLOW },
      annotations: { readOnlyHint: true },
    },
    ({ flow }) =>
      answer(() => {
        const result = check(flow);
        return result.ok ? { ok: true, issues: [], estimate: result.estimate } : { ok: false, issues: result.issues };
      }),
  );

  server.registerTool(
    "generate_script",
    {
      title: "Export launch.ts",
      description: "A TypeScript script that performs the flow by calling the same operations the runner uses.",
      inputSchema: { flow: FLOW },
      annotations: { readOnlyHint: true },
    },
    ({ flow }) =>
      answer(() =>
        generateLaunchScript(flow, registry, { headerLines: ["Generated through the LaunchBlocks MCP server."] }),
      ),
  );

  server.registerTool(
    "share_link",
    {
      title: "Open in the Launch Studio",
      description:
        "A studio link that opens the flow as blocks, for a person to review, edit and run. The flow travels in the link itself.",
      inputSchema: { flow: FLOW },
      annotations: { readOnlyHint: true },
    },
    ({ flow }) =>
      answer(() => {
        const result = check(flow);
        if (!result.ok) throw new FlowValidationError(result.issues);
        return { link: studioLinkFor(options.studioUrl, result.flow) };
      }),
  );

  server.registerTool(
    "run_flow",
    {
      title: "Run a flow",
      description:
        "Dry run by default: validate, estimate the cost and list the steps, sending nothing. With dryRun: false, run it with the operator account configured for this project, spending its HBAR, and return every step's outputs and HashScan links. Only do that when the user asked for it.",
      inputSchema: {
        flow: FLOW,
        dryRun: z.boolean().default(true).describe("true (the default) sends nothing."),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    ({ flow, dryRun }) =>
      answer(async () => {
        const result = check(flow);
        if (!result.ok) throw new FlowValidationError(result.issues);
        const plan = result.flow.steps.map(step => ({ id: step.id, type: step.type }));
        if (dryRun) {
          return {
            dryRun: true,
            network: result.flow.network,
            estimate: result.estimate,
            steps: plan,
            canRun: !!options.operator,
          };
        }
        if (!options.operator) {
          throw new LaunchBlocksError("OPERATOR_MISSING", "No operator is configured, so this server only dry-runs", {
            hint: "Set HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY in packages/nextjs/.env and restart the MCP server.",
          });
        }
        if (result.flow.network === "mainnet" && !options.allowMainnet) {
          throw new LaunchBlocksError("MAINNET_DISABLED", "Mainnet runs are disabled", {
            hint: "Set LAUNCHBLOCKS_ALLOW_MAINNET=true for the MCP server to allow them.",
          });
        }
        const hedera = options.operator();
        try {
          const run = await runFlow(result.flow, {
            registry,
            ctx: {
              network: hedera.network,
              hedera,
              log: (level, message) => log(`[${level}] ${message}`),
              artifacts: name => loadHardhatArtifact(name),
            },
            onEvent: event => {
              if (event.type === "step:success" || event.type === "step:error")
                log(`${event.step.status} ${event.step.id}`);
            },
          });
          return {
            status: run.status,
            network: run.network,
            steps: run.steps.map(step => ({
              id: step.id,
              status: step.status,
              outputs: step.outputs,
              links: step.links,
              ...(step.error ? { error: step.error } : {}),
            })),
            ...(run.error ? { error: run.error } : {}),
          };
        } finally {
          hedera.client.close();
        }
      }),
  );

  server.registerTool(
    "read_launch",
    {
      title: "Read a launch",
      description:
        "A launch from its HCS log (the topic its flow opened): every logged event, plus the token, pool price, locked liquidity and schedules as the network shows them now, and the launch page's URL.",
      inputSchema: { topicId: z.string().describe("The launch log's topic id, e.g. 0.0.10716076.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ topicId }) =>
      answer(async () => ({
        page: `${options.studioUrl.replace(/\/+$/, "")}/launches/${topicId}`,
        ...(await readLaunch(options.mirror, topicId)),
      })),
  );

  return server;
}
