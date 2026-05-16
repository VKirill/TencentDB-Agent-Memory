/**
 * `claude-mem mcp serve` — start the MCP server on stdio.
 *
 * Claude Code spawns this process and communicates over stdin/stdout using
 * the MCP JSON-RPC protocol. The server runs until the transport closes.
 */

import { runMcpServer } from "../../mcp/server.js";

export async function runMcpServeCommand(): Promise<void> {
  await runMcpServer();
  // Server runs forever via stdio; only returns on disconnect.
}
