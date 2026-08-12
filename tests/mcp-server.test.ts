import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalService } from "../src/approval/service.js";
import type { DingTalkApiClient } from "../src/dingtalk/client.js";
import { createApprovalMcpServer } from "../src/mcp/create-server.js";

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(closeables.splice(0).map((item) => item.close()));
});

async function connectedClient(apiResponse: unknown = {}): Promise<{
  client: Client;
  request: ReturnType<typeof vi.fn>;
}> {
  const request = vi.fn().mockResolvedValue(apiResponse);
  const service = new ApprovalService({
    api: { request } as unknown as Pick<DingTalkApiClient, "request">,
    writeUserIds: ["user-1"],
  });
  const server = createApprovalMcpServer(service);
  const client = new Client({ name: "approval-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeables.push(client, server);
  return { client, request };
}

describe("approval MCP public contract", () => {
  it("publishes DWS-compatible approval names plus dedicated attachment tools", async () => {
    const { client } = await connectedClient();

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "get_processInstance_detail",
        "get_processInstance_records",
        "list_pending_tasks",
        "list_user_visible_process",
        "get_process_schema",
        "forecast_process",
        "start_process_instance",
        "approve_processInstance",
        "reject_processInstance",
        "revoke_processInstance",
        "query_process_instance_ids",
        "list_approval_attachments",
        "download_approval_attachment",
        "get_approval_capabilities",
      ]),
    );
  });

  it("returns normalized and raw detail through an actual MCP tool call", async () => {
    const { client, request } = await connectedClient({
      result: { processInstanceId: "pi-1", ccUserIds: [{ nonStandard: true }] },
    });

    const result = await client.callTool({
      name: "get_processInstance_detail",
      arguments: { processInstanceId: "pi-1" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: { normalized: { processInstanceId: "pi-1" }, raw: { processInstanceId: "pi-1" } },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
