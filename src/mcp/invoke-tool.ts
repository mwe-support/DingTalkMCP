import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ApprovalService } from "../approval/service.js";
import { createApprovalMcpServer } from "./create-server.js";

export type ApprovalToolResult = Awaited<ReturnType<Client["callTool"]>>;

/**
 * Reuses the MCP tool catalog for DingTalk MCP Platform's ordinary HTTP actions.
 * This keeps validation, write confirmations, and error payloads identical on
 * every platform-managed tool action without exposing a self-hosted MCP route.
 */
export async function invokeApprovalTool(
  service: ApprovalService,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<ApprovalToolResult | undefined> {
  const server = createApprovalMcpServer(service);
  const client = new Client({ name: "mwe-dingtalk-mcp-platform-adapter", version: "0.1.0" });
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
