#!/usr/bin/env node
// Starts the LaunchBlocks MCP server (scripts/mcp.ts) with no package manager in between:
// its stdout is the protocol, and a package manager's own output there would break it.
// tsx runs the TypeScript source; it is resolved from this package, wherever it was installed.
require("tsx/cjs/api").register();
require("../scripts/mcp.ts");
