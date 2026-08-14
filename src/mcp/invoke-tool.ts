import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ApprovalService } from "../approval/service.js";
import { APPROVAL_MCP_VERSION } from "../version.js";
import { createApprovalMcpServer } from "./create-server.js";

export type ApprovalToolResult = Awaited<ReturnType<Client["callTool"]>>;

/**
 * Reuses the public MCP tool catalog for the HTTP backend. Endpoint-shaped
 * compatibility tools stay local to tests and migration work; production only
 * exposes the role-cohesive approval_task contract.
 */
export async function invokeApprovalTool(
  service: ApprovalService,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<ApprovalToolResult | undefined> {
  const server = createApprovalMcpServer(service);
  const client = new Client({ name: "mwe-dingtalk-mcp-platform-adapter", version: APPROVAL_MCP_VERSION });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === name)) return undefined;
    return await client.callTool({ name, arguments: arguments_ });
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}
