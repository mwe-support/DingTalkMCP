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
  const request = vi.fn().mockResolvedValue({});
  const service = new ApprovalService({
    api: { request } as unknown as Pick<DingTalkApiClient, "request">,
  });
  const server = await startApprovalHttpServer(service, {
    host: "127.0.0.1",
    port: 0,
    apiKey: "0123456789abcdef0123456789abcdef",
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
});
