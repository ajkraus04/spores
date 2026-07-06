#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createSporesMcpServer } from "./mcp.js";

const rootDir = process.env.SPORES_RUNS_ROOT;
const server = createSporesMcpServer({ rootDir });

await server.connect(new StdioServerTransport());
console.error("sporesd MCP server running on stdio");
