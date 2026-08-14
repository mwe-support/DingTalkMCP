import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalService } from "../src/approval/service.js";
import type {
  ToolInvocationAuditEvent,
  ToolInvocationAuditSink,
} from "../src/core/audit-log.js";
import { AuditInvocationContext } from "../src/core/audit-log.js";
import { ApprovalMcpError } from "../src/core/errors.js";
import type { DingTalkApiClient } from "../src/dingtalk/client.js";
import { startApprovalHttpServer } from "../src/transports/http-server.js";

const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.allSettled(resources.splice(0).map((item) => item.close()));
});

async function fixture(
  options: {
    auditContext?: AuditInvocationContext;
    auditWriteTimeoutMs?: number;
    request?: ReturnType<typeof vi.fn>;
    toolAudit?: ToolInvocationAuditSink;
  } = {},
) {
  const auditEvents: ToolInvocationAuditEvent[] = [];
  const request =
    options.request ??
    vi.fn().mockResolvedValue({
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
    ...(options.auditContext === undefined ? {} : { auditContext: options.auditContext }),
    ...(options.auditWriteTimeoutMs === undefined ? {} : { auditWriteTimeoutMs: options.auditWriteTimeoutMs }),
    toolAudit: options.toolAudit ?? { record: (event) => void auditEvents.push(event) },
  });
  resources.push(server);
  const address = server.httpServer.address() as AddressInfo;
  return { auditEvents, baseUrl: `http://127.0.0.1:${address.port}`, request, server };
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
    const endpoint = `${baseUrl}/platform/tools/approval_task`;

    await expect(
      fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "view", processInstanceId: "pi-platform-1" }),
      }).then((response) => response.status),
    ).resolves.toBe(401);

    const response = await fetch(endpoint, {
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
        action: "view",
        processInstanceId: "pi-platform-1",
      },
    });
  });

  it("does not expose endpoint-shaped compatibility tools through the hosted platform backend", async () => {
    const { baseUrl } = await fixture();
    const response = await fetch(`${baseUrl}/platform/tools/get_approval_instance`, {
      method: "POST",
      headers: {
        authorization: "Bearer abcdef0123456789abcdef0123456789",
        "content-type": "application/json",
      },
      body: JSON.stringify({ processInstanceId: "pi-platform-1" }),
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Unknown approval tool" });
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
          attachmentHandling: expect.objectContaining({
            mode: "agent_client",
            serverDownloadsFiles: false,
            serverParsesFiles: false,
            serverPerformsOcr: false,
          }),
          attachmentDownloads: [],
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
    const { auditEvents, baseUrl } = await fixture();
    const response = await fetch(`${baseUrl}/platform/tools/approval_task`, {
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
    expect(auditEvents).toEqual([
      expect.objectContaining({
        transport: "dingtalk_platform_http",
        toolName: "approval_task",
        phase: "started",
      }),
      expect.objectContaining({
        transport: "dingtalk_platform_http",
        toolName: "approval_task",
        phase: "completed",
        outcome: "rejected",
        httpStatus: 422,
        errorCode: "TOOL_INPUT_OR_EXECUTION_ERROR",
      }),
    ]);
  });

  it("records one secret-safe structured event for each authenticated tool invocation", async () => {
    const { auditEvents, baseUrl } = await fixture();
    const processInstanceId = "pi-sensitive-target-123";
    const response = await fetch(`${baseUrl}/platform/tools/approval_task`, {
      method: "POST",
      headers: {
        authorization: "Bearer abcdef0123456789abcdef0123456789",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "view", processInstanceId }),
    });

    expect(response.status).toBe(200);
    const invocationId = response.headers.get("x-mwe-audit-id");
    expect(invocationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(response.headers.get("x-mwe-audit-status")).toBe("recorded");
    expect(auditEvents).toEqual([
      {
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        invocationId,
        transport: "dingtalk_platform_http",
        toolName: "approval_task",
        phase: "started",
      },
      {
        timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        invocationId,
        transport: "dingtalk_platform_http",
        toolName: "approval_task",
        action: "view",
        phase: "completed",
        outcome: "succeeded",
        httpStatus: 200,
        durationMs: expect.any(Number),
      },
    ]);
    const serialized = JSON.stringify(auditEvents);
    expect(serialized).not.toContain(processInstanceId);
    expect(serialized).not.toContain("abcdef0123456789abcdef0123456789");
    expect(serialized).not.toContain("authorization");
  });

  it("audits authenticated method and content-type rejections", async () => {
    const { auditEvents, baseUrl } = await fixture();
    const endpoint = `${baseUrl}/platform/tools/approval_task`;
    const authorization = { authorization: "Bearer abcdef0123456789abcdef0123456789" };

    await expect(fetch(endpoint, { method: "GET", headers: authorization }).then((response) => response.status)).resolves.toBe(
      405,
    );
    await expect(
      fetch(endpoint, { method: "POST", headers: authorization, body: "{}" }).then((response) => response.status),
    ).resolves.toBe(415);

    expect(auditEvents.filter((event) => event.phase === "started")).toHaveLength(2);
    expect(auditEvents.filter((event) => event.phase === "completed")).toEqual([
      expect.objectContaining({ outcome: "rejected", httpStatus: 405, errorCode: "METHOD_NOT_ALLOWED" }),
      expect.objectContaining({ outcome: "rejected", httpStatus: 415, errorCode: "UNSUPPORTED_MEDIA_TYPE" }),
    ]);
  });

  it("does not execute a tool when its start audit record cannot be persisted", async () => {
    const toolAudit: ToolInvocationAuditSink = { record: vi.fn().mockRejectedValue(new Error("disk full")) };
    const { baseUrl, request } = await fixture({ toolAudit });
    const response = await fetch(`${baseUrl}/platform/tools/approval_task`, {
      method: "POST",
      headers: {
        authorization: "Bearer abcdef0123456789abcdef0123456789",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "view", processInstanceId: "pi-platform-1" }),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("x-mwe-audit-status")).toBe("failed");
    expect(request).not.toHaveBeenCalled();
  });

  it("marks a completed call as partially audited when only the completion record fails", async () => {
    const writeError = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const record = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk full"));
    const { baseUrl, request } = await fixture({ toolAudit: { record } });
    const response = await fetch(`${baseUrl}/platform/tools/approval_task`, {
      method: "POST",
      headers: {
        authorization: "Bearer abcdef0123456789abcdef0123456789",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "view", processInstanceId: "pi-platform-1" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-mwe-audit-status")).toBe("partial");
    expect(record).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledWith("Structured tool audit completion write failed.\n");
  });

  it("scopes a nested approval audit failure to its own concurrent invocation", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const auditContext = new AuditInvocationContext();
    const request = vi.fn().mockImplementation(async (input: { query?: { processInstanceId?: string } }) => {
      const processInstanceId = input.query?.processInstanceId ?? "unknown";
      if (processInstanceId === "pi-failing-audit") auditContext.markApprovalAuditFailure();
      await Promise.resolve();
      return { result: { processInstanceId, title: "Platform result" } };
    });
    const { baseUrl } = await fixture({ auditContext, request });
    const invoke = (processInstanceId: string) =>
      fetch(`${baseUrl}/platform/tools/approval_task`, {
        method: "POST",
        headers: {
          authorization: "Bearer abcdef0123456789abcdef0123456789",
          "content-type": "application/json",
        },
        body: JSON.stringify({ action: "view", processInstanceId }),
      });
    const [failing, healthy] = await Promise.all([invoke("pi-failing-audit"), invoke("pi-healthy-audit")]);

    expect(failing.status).toBe(200);
    expect(failing.headers.get("x-mwe-audit-status")).toBe("partial");
    expect(healthy.status).toBe(200);
    expect(healthy.headers.get("x-mwe-audit-status")).toBe("recorded");
  });

  it("bounds a hanging completion audit without converting the completed tool result into an error", async () => {
    const writeError = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const record = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(new Promise<void>(() => undefined));
    const { baseUrl, request } = await fixture({
      auditWriteTimeoutMs: 10,
      toolAudit: { record },
    });
    const response = await fetch(`${baseUrl}/platform/tools/approval_task`, {
      method: "POST",
      headers: {
        authorization: "Bearer abcdef0123456789abcdef0123456789",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "view", processInstanceId: "pi-platform-1" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-mwe-audit-status")).toBe("partial");
    expect(request).toHaveBeenCalled();
    expect(writeError).toHaveBeenCalledWith("Structured tool audit completion write failed.\n");
  });

  it("distinguishes upstream tool failures from business rejections", async () => {
    const request = vi.fn().mockRejectedValue(new ApprovalMcpError("DINGTALK_API_ERROR", "upstream failed"));
    const { auditEvents, baseUrl } = await fixture({ request });
    const response = await fetch(`${baseUrl}/platform/tools/approval_task`, {
      method: "POST",
      headers: {
        authorization: "Bearer abcdef0123456789abcdef0123456789",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "view", processInstanceId: "pi-platform-1" }),
    });

    expect(response.status).toBe(422);
    expect(auditEvents.at(-1)).toMatchObject({
      phase: "completed",
      outcome: "failed",
      errorCode: "DINGTALK_API_ERROR",
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
