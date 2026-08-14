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
    platformApiKey: "abcdef0123456789abcdef0123456789",
    allowedHosts: [],
  });
  resources.push(server);
  const address = server.httpServer.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

describe("DingTalk MCP Platform HTTP tool backend", () => {
  it("exposes health but never exposes a self-hosted MCP endpoint", async () => {
    const { baseUrl } = await fixture();

    await expect(fetch(`${baseUrl}/healthz`).then((response) => response.status)).resolves.toBe(200);
    await expect(
      fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer abcdef0123456789abcdef0123456789",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      }).then((response) => response.status),
    ).resolves.toBe(404);
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

  it("exposes the combined get_approval_instance action for the hosted platform", async () => {
    const { baseUrl } = await fixture();
    const response = await fetch(`${baseUrl}/platform/tools/get_approval_instance`, {
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
        processInstanceId: "pi-platform-1",
        attachments: [],
        attachmentReads: [],
      },
    });
  });

  it("exposes the role-cohesive approval_task action for the hosted platform", async () => {
    const { baseUrl } = await fixture();
    const response = await fetch(`${baseUrl}/platform/tools/approval_task`, {
      method: "POST",
      headers: {
        authorization: "Bearer abcdef0123456789abcdef0123456789",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "view", processInstanceId: "pi-platform-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        processInstanceId: "pi-platform-1",
        action: "view",
        currentStatus: "UNKNOWN",
        safeNextActions: ["view"],
        data: {
          normalized: { processInstanceId: "pi-platform-1", title: "Platform result" },
          attachments: [],
          attachmentReads: [],
          actionableTasks: [],
        },
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

  it("requires the platform backend key for a non-loopback listener", async () => {
    const service = new ApprovalService({
      api: { request: vi.fn() } as unknown as Pick<DingTalkApiClient, "request">,
    });
    await expect(
      startApprovalHttpServer(service, {
        host: "127.0.0.1",
        port: 0,
        platformApiKey: "too-short",
        allowedHosts: [],
      }),
    ).rejects.toThrow("MCP_PLATFORM_API_KEY must contain at least 32 UTF-8 bytes");
    await expect(
      startApprovalHttpServer(service, {
        host: "0.0.0.0",
        port: 0,
        platformApiKey: undefined,
        allowedHosts: ["approval-tools.example.com"],
      }),
    ).rejects.toThrow("MCP_PLATFORM_API_KEY is required when HTTP binds outside loopback");
  });
});
