#!/usr/bin/env tsx
// sreflow-mcp — stdio MCP server for Claude Desktop (and any MCP client).
//
// Reads server state from env:
//   NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD   — Neo4j connection
//   OPA_URL                                  — OPA policy server
//   ANTHROPIC_API_KEY                        — for sreflow_propose_rename
//   SREFLOW_AUDIT_PATH, SREFLOW_PAUSE_STATE  — override default .state paths
//   SREFLOW_USER                             — attribution on curation events
//
// Claude Desktop launches one instance per session via the command configured
// in claude_desktop_config.json — see sre/docs/MCP_SERVER.md for the snippet.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createSreflowServer } from "../src/agent-runtime/mcp-server.js";

const server = createSreflowServer();
const transport = new StdioServerTransport();

// Send readiness signals to stderr — stdout is reserved for MCP framing.
process.stderr.write(
  `sreflow-mcp: starting (pid=${process.pid}, node=${process.version})\n`,
);

server
  .connect(transport)
  .then(() => {
    process.stderr.write("sreflow-mcp: connected over stdio\n");
  })
  .catch((err) => {
    process.stderr.write(`sreflow-mcp: failed to connect: ${err.message}\n`);
    process.exit(1);
  });
