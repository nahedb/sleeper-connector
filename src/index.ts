#!/usr/bin/env node
/** stdio entry point - for local MCP clients (Claude Desktop, Claude Code, etc). */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { SleeperClient } from "./sleeper.js";
import { createServer } from "./tools.js";

const server = createServer(new SleeperClient(), loadConfig());
await server.connect(new StdioServerTransport());
// stdout is reserved for the MCP protocol; log to stderr only.
console.error("sleeper-mcp running on stdio");
