/**
 * The LaunchBlocks MCP server over stdio, for coding agents (see src/mcp/server.ts).
 *
 *   node packages/launchblocks/bin/mcp.cjs      what .mcp.json starts
 *   yarn core:mcp                               the same, through the package manager
 *
 * Like core:run, it reads packages/nextjs/.env: with an operator there, run_flow can spend its
 * HBAR, but only when the agent passes dryRun: false. LAUNCHBLOCKS_STUDIO_URL sets where share
 * links and launch pages point (http://localhost:3000 by default).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config as loadEnv } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";

import { hederaContextFromEnv, mirrorFromEnv } from "../src/hedera/client";
import { createLaunchBlocksMcpServer } from "../src/mcp/server";

// stdout carries the protocol; anything else printed there would corrupt it.
for (const method of ["log", "info", "warn", "debug"] as const) console[method] = console.error;

const envFile = path.resolve(__dirname, "..", "..", "nextjs", ".env");
if (existsSync(envFile)) loadEnv({ path: envFile });

const server = createLaunchBlocksMcpServer({
  studioUrl: process.env.LAUNCHBLOCKS_STUDIO_URL?.trim() || "http://localhost:3000",
  mirror: mirrorFromEnv(process.env),
  ...(process.env.HEDERA_OPERATOR_ID?.trim() ? { operator: () => hederaContextFromEnv(process.env) } : {}),
  allowMainnet: process.env.LAUNCHBLOCKS_ALLOW_MAINNET === "true",
  log: message => console.error(message),
});

server.connect(new StdioServerTransport()).catch(error => {
  console.error(error);
  process.exit(1);
});
