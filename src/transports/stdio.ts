import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "../config.js";
import { createApprovalMcpServer } from "../mcp/create-server.js";
import { createApprovalService } from "../runtime.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = createApprovalMcpServer(createApprovalService(config));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  process.stderr.write(`MWE approval MCP failed to start: ${message}\n`);
  process.exitCode = 1;
});
