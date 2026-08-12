import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalService } from "../src/approval/service.js";
import type { DingTalkApiClient } from "../src/dingtalk/client.js";
import { startApprovalHttpServer } from "../src/transports/http-server.js";

const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(resources.splice(0).map((item) => item.close()));
});

async function fixture() {
  const request = vi.fn().mockResolvedValue({
    result: { processInstanceId: "pi-platform-1", title: "Platform result" },
  });
  const service = new ApprovalService({
    api: { request } as unknown as Pick<DingTalkApiClient, "request">,
  });
  const server = await startApprovalHttpServer(service, {
    host: "127.0.0.1",
    port: 0,
    apiKey: "0123456789abcdef0123456789abcdef",
    platformApiKey: "abcdef0123456789abcdef0123456789",
    allowedHosts: [],
  });
  resources.push(server);
  const address = server.httpServer.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

describe("stateless Streamable HTTP transport", () => {
  it("requires its bearer key and exposes a minimal health endpoint", async () => {
    const { baseUrl } = await fixture();

    await expect(fetch(`${baseUrl}/healthz`).then((response) => response.status)).resolves.toBe(200);
    await expect(
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }).then((response) => response.status),
    ).resolves.toBe(401);
  });

  it("serves MCP tools with a fresh stateless server for authenticated requests", async () => {
    const { baseUrl } = await fixture();
    const client = new Client({ name: "http-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: "Bearer 0123456789abcdef0123456789abcdef" } },
    });
    // SDK 1.30.0's optional session declaration conflicts with exactOptionalPropertyTypes.
    await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
    resources.push(client);

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toContain("get_approval_capabilities");
    expect(transport.sessionId).toBeUndefined();
  });

  it("exposes authenticated ordinary HTTP tool actions for DingTalk's hosted MCP platform", async () => {
    const { baseUrl } = await fixture();
    const endpoint = `${baseUrl}/platform/tools/get_processInstance_detail`;

    await expect(
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ processInstanceId: "pi-platform-1" }),
      }).then((response) => response.status),
    ).resolves.toBe(401);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: "Bearer abcdef0123456789abcdef0123456789",
        "content-type": "application/json",
      },
      body: JSON.stringify({ processInstanceId: "pi-platform-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        normalized: { processInstanceId: "pi-platform-1", title: "Platform result" },
        raw: { processInstanceId: "pi-platform-1", title: "Platform result" },
      },
    });
  });

  it("rejects unknown platform tool names without invoking DingTalk", async () => {
    const { baseUrl } = await fixture();
    const response = await fetch(`${baseUrl}/platform/tools/not_a_real_tool`, {
      method: "POST",
      headers: {
        authorization: "Bearer abcdef0123456789abcdef0123456789",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Unknown approval tool" });
  });

  it("maps MCP input validation failures to the platform error contract", async () => {
    const { baseUrl } = await fixture();
    const response = await fetch(`${baseUrl}/platform/tools/get_processInstance_detail`, {
      method: "POST",
      headers: {
        authorization: "Bearer abcdef0123456789abcdef0123456789",
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "TOOL_INPUT_OR_EXECUTION_ERROR" },
    });
  });

  it("requires independent keys for direct MCP and DingTalk platform access", async () => {
    const service = new ApprovalService({
      api: { request: vi.fn() } as unknown as Pick<DingTalkApiClient, "request">,
    });
    await expect(
      startApprovalHttpServer(service, {
        host: "127.0.0.1",
        port: 0,
        apiKey: "0123456789abcdef0123456789abcdef",
        platformApiKey: "0123456789abcdef0123456789abcdef",
        allowedHosts: [],
      }),
    ).rejects.toThrow("MCP_HTTP_API_KEY and MCP_PLATFORM_API_KEY must be different");
  });
});
