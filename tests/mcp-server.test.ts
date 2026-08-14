import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalService } from "../src/approval/service.js";
import { InMemoryIdempotencyLedger } from "../src/core/idempotency.js";
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
    callerUserId: "user-1",
  });
  const server = createApprovalMcpServer(service, { includeCompatibilityTools: true });
  const client = new Client({ name: "approval-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeables.push(client, server);
  return { client, request };
}

async function connectedClientWithRequest(request: ReturnType<typeof vi.fn>): Promise<Client> {
  const service = new ApprovalService({
    api: { request } as unknown as Pick<DingTalkApiClient, "request">,
    callerUserId: "user-1",
  });
  const server = createApprovalMcpServer(service, { includeCompatibilityTools: true });
  const client = new Client({ name: "approval-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeables.push(client, server);
  return client;
}

async function connectedPublicClient(apiResponse: unknown = {}): Promise<{
  client: Client;
  request: ReturnType<typeof vi.fn>;
}> {
  const request = vi.fn().mockResolvedValue(apiResponse);
  const service = new ApprovalService({
    api: { request } as unknown as Pick<DingTalkApiClient, "request">,
    writeUserIds: ["user-1"],
    callerUserId: "user-1",
  });
  const server = createApprovalMcpServer(service);
  const client = new Client({ name: "approval-mcp-public-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeables.push(client, server);
  return { client, request };
}

const APPROVE_REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const REJECT_REQUEST_ID = "22222222-2222-4222-8222-222222222222";

describe("approval MCP public contract", () => {
  it("publishes one role-cohesive approval_task tool instead of endpoint-shaped tools", async () => {
    const { client } = await connectedPublicClient();

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual(["approval_task"]);
    expect(tools.tools[0]?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it("records bounded structured audit events around Streamable HTTP tool semantics", async () => {
    const events: Array<Record<string, unknown>> = [];
    const request = vi.fn().mockResolvedValue({
      result: {
        processInstanceId: "pi-audit",
        status: "RUNNING",
        tasks: [{ taskId: "task-audit", userId: "user-1", status: "RUNNING" }],
      },
    });
    const service = new ApprovalService({
      api: { request } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
      writeUserIds: ["user-1"],
    });
    const server = createApprovalMcpServer(service, {
      toolAudit: { record: (event) => void events.push(event as unknown as Record<string, unknown>) },
    });
    const client = new Client({ name: "approval-audit-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    await client.callTool({
      name: "approval_task",
      arguments: { action: "view", processInstanceId: "pi-audit" },
    });

    expect(events).toEqual([
      expect.objectContaining({
        transport: "streamable_http",
        toolName: "approval_task",
        action: "view",
        phase: "started",
      }),
      expect.objectContaining({
        transport: "streamable_http",
        toolName: "approval_task",
        action: "view",
        phase: "completed",
        outcome: "succeeded",
        auditStatus: "complete",
      }),
    ]);
  });

  it("does not execute approval_task when the required start audit cannot be persisted", async () => {
    const request = vi.fn();
    const service = new ApprovalService({
      api: { request } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
      writeUserIds: ["user-1"],
    });
    const server = createApprovalMcpServer(service, {
      toolAudit: { record: () => Promise.reject(new Error("disk unavailable")) },
    });
    const client = new Client({ name: "approval-audit-failure-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({
      name: "approval_task",
      arguments: { action: "view", processInstanceId: "pi-audit" },
    });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "AUDIT_LOG_UNAVAILABLE" } },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("audits unknown tools and invalid arguments before public dispatch", async () => {
    const events: Array<Record<string, unknown>> = [];
    const service = new ApprovalService({ api: { request: vi.fn() } as unknown as Pick<DingTalkApiClient, "request"> });
    const server = createApprovalMcpServer(service, {
      toolAudit: { record: (event) => void events.push(event as unknown as Record<string, unknown>) },
    });
    const client = new Client({ name: "approval-invalid-audit-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    await client.callTool({ name: "not_a_public_tool", arguments: {} });
    await client.callTool({ name: "approval_task", arguments: { action: "view" } });

    expect(events).toEqual([
      expect.objectContaining({ phase: "started", toolName: "unknown" }),
      expect.objectContaining({ phase: "completed", outcome: "unknown_tool", errorCode: "UNKNOWN_TOOL" }),
      expect.objectContaining({ phase: "started", toolName: "approval_task", action: "view" }),
      expect.objectContaining({ phase: "completed", outcome: "rejected", errorCode: "INVALID_INPUT" }),
    ]);
  });

  it("preserves a successful business result and marks it partial when completion audit persistence fails", async () => {
    let writes = 0;
    const service = new ApprovalService({
      api: {
        request: vi.fn().mockResolvedValue({
          result: {
            processInstanceId: "pi-partial",
            status: "RUNNING",
            tasks: [{ taskId: "task-1", userId: "user-1", status: "RUNNING" }],
          },
        }),
      } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
    });
    const server = createApprovalMcpServer(service, {
      toolAudit: {
        record: () => {
          writes += 1;
          return writes === 1 ? undefined : Promise.reject(new Error("completion unavailable"));
        },
      },
    });
    const client = new Client({ name: "approval-partial-audit-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({
      name: "approval_task",
      arguments: { action: "view", processInstanceId: "pi-partial" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      auditStatus: "partial",
      result: { processInstanceId: "pi-partial" },
    });
  });

  it("returns approval content, actionable state, comments, and attachment metadata through action=view", async () => {
    const { client, request } = await connectedPublicClient({
      result: {
        processInstanceId: "pi-view",
        status: "RUNNING",
        title: "加班审批",
        tasks: [{ taskId: "task-1", userId: "user-1", status: "RUNNING" }],
        operationRecords: [
          {
            remark: "补充材料",
            attachments: [{ fileId: "comment-file", fileName: "proof.pdf", fileType: "pdf" }],
          },
        ],
        formComponentValues: [{ name: "加班原因", value: "项目交付" }],
      },
    });

    const result = await client.callTool({
      name: "approval_task",
      arguments: { action: "view", processInstanceId: "pi-view" },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        processInstanceId: "pi-view",
        action: "view",
        currentStatus: "RUNNING",
        auditCorrelationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        safeNextActions: ["view", "approve", "reject"],
        data: {
          normalized: {
            title: "加班审批",
            operationRecords: [expect.objectContaining({ remark: "补充材料" })],
            formComponentValues: [expect.objectContaining({ name: "加班原因" })],
          },
          attachments: [
            expect.objectContaining({ source: "operation", fileId: "comment-file", fileName: "proof.pdf" }),
          ],
          attachmentHandling: expect.objectContaining({
            mode: "agent_client",
            serverDownloadsFiles: false,
            serverParsesFiles: false,
            serverPerformsOcr: false,
            agentMustValidateRedirects: true,
          }),
          attachmentDownloads: [],
          actionableTasks: [expect.objectContaining({ taskId: "task-1", userId: "user-1" })],
        },
      },
    });
    expect(request).toHaveBeenCalledOnce();
    expect((result.structuredContent as { result: { data: Record<string, unknown> } }).result.data).not.toHaveProperty(
      "raw",
    );
  });

  it("does not advertise decision actions when DingTalk omits the task status", async () => {
    const { client } = await connectedPublicClient({
      result: {
        processInstanceId: "pi-unknown-task",
        status: "RUNNING",
        tasks: [{ taskId: "task-unknown", userId: "user-1" }],
      },
    });

    const result = await client.callTool({
      name: "approval_task",
      arguments: { action: "view", processInstanceId: "pi-unknown-task" },
    });

    expect(result.structuredContent).toMatchObject({
      result: {
        safeNextActions: ["view"],
        data: { actionableTasks: [] },
      },
    });
  });

  it("approves through the same approval_task tool after refreshing task ownership and state", async () => {
    const { client, request } = await connectedClient();
    request
      .mockResolvedValueOnce({
        result: {
          processInstanceId: "pi-approve",
          status: "RUNNING",
          tasks: [{ taskId: "task-approve", userId: "user-1", status: "RUNNING" }],
        },
      })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        result: {
          processInstanceId: "pi-approve",
          status: "COMPLETED",
          result: "agree",
          tasks: [{ taskId: "task-approve", userId: "user-1", status: "COMPLETED" }],
        },
      });

    const result = await client.callTool({
      name: "approval_task",
      arguments: {
        action: "approve",
        processInstanceId: "pi-approve",
        taskId: "task-approve",
        requestId: APPROVE_REQUEST_ID,
        confirm: true,
        remark: "符合要求",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        processInstanceId: "pi-approve",
        action: "approve",
        currentStatus: "COMPLETED",
        auditCorrelationId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        safeNextActions: ["view"],
        data: {
          taskId: "task-approve",
          dryRun: false,
          upstreamResult: { success: true },
          normalized: { status: "COMPLETED", result: "agree" },
        },
      },
    });
    expect(request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/v1.0/workflow/processInstances",
      query: { processInstanceId: "pi-approve" },
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/v1.0/workflow/processInstances/execute",
      body: {
        processInstanceId: "pi-approve",
        taskId: "task-approve",
        result: "agree",
        remark: "符合要求",
        actionerUserId: "user-1",
      },
    });
    expect(request).toHaveBeenNthCalledWith(3, {
      method: "GET",
      path: "/v1.0/workflow/processInstances",
      query: { processInstanceId: "pi-approve" },
    });
  });

  it("requires a non-empty business reason for action=reject", async () => {
    const { client, request } = await connectedPublicClient();

    const result = await client.callTool({
      name: "approval_task",
      arguments: {
        action: "reject",
        processInstanceId: "pi-reject",
        taskId: "task-reject",
        requestId: REJECT_REQUEST_ID,
        confirm: true,
        remark: "   ",
      },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects through approval_task with the bound caller and required reason", async () => {
    const { client, request } = await connectedClient();
    request
      .mockResolvedValueOnce({
        result: {
          processInstanceId: "pi-reject",
          status: "RUNNING",
          tasks: [{ taskId: "task-reject", userId: "user-1", status: "RUNNING" }],
        },
      })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        result: { processInstanceId: "pi-reject", status: "COMPLETED", result: "refuse" },
      });

    const result = await client.callTool({
      name: "approval_task",
      arguments: {
        action: "reject",
        processInstanceId: "pi-reject",
        taskId: "task-reject",
        requestId: REJECT_REQUEST_ID,
        confirm: true,
        remark: "附件内容不符合报销标准",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        action: "reject",
        currentStatus: "COMPLETED",
        safeNextActions: ["view"],
      },
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/v1.0/workflow/processInstances/execute",
      body: {
        processInstanceId: "pi-reject",
        taskId: "task-reject",
        result: "refuse",
        remark: "附件内容不符合报销标准",
        actionerUserId: "user-1",
      },
    });
  });

  it("forbids decision-only fields on action=view", async () => {
    const { client, request } = await connectedPublicClient();

    const result = await client.callTool({
      name: "approval_task",
      arguments: {
        action: "view",
        processInstanceId: "pi-view",
        taskId: "task-should-not-be-accepted",
        confirm: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("forbids attachment download fields unless action=view explicitly selects download mode", async () => {
    const { client, request } = await connectedPublicClient();

    const implicit = await client.callTool({
      name: "approval_task",
      arguments: {
        action: "view",
        processInstanceId: "pi-view",
        attachmentIds: ["file-ignored"],
      },
    });
    const listMode = await client.callTool({
      name: "approval_task",
      arguments: {
        action: "view",
        processInstanceId: "pi-view",
        attachmentAction: "list",
        maxAttachments: 2,
      },
    });

    expect(implicit.isError).toBe(true);
    expect(listMode.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed when the active task belongs to another DingTalk user", async () => {
    const { client, request } = await connectedPublicClient({
      result: {
        processInstanceId: "pi-other-user",
        status: "RUNNING",
        tasks: [{ taskId: "task-other", userId: "user-2", status: "RUNNING" }],
      },
    });

    const result = await client.callTool({
      name: "approval_task",
      arguments: {
        action: "approve",
        processInstanceId: "pi-other-user",
        taskId: "task-other",
        requestId: "33333333-3333-4333-8333-333333333333",
        confirm: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "TASK_ACTOR_MISMATCH" } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the selected task is no longer actionable", async () => {
    const { client, request } = await connectedPublicClient({
      result: {
        processInstanceId: "pi-stale",
        status: "COMPLETED",
        tasks: [{ taskId: "task-stale", userId: "user-1", status: "COMPLETED" }],
      },
    });

    const result = await client.callTool({
      name: "approval_task",
      arguments: {
        action: "approve",
        processInstanceId: "pi-stale",
        taskId: "task-stale",
        requestId: "44444444-4444-4444-8444-444444444444",
        confirm: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "TASK_NOT_ACTIONABLE" } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("deduplicates approval decisions by requestId and rejects conflicting reuse", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          processInstanceId: "pi-idempotent",
          status: "RUNNING",
          tasks: [{ taskId: "task-idempotent", userId: "user-1", status: "RUNNING" }],
        },
      })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ result: { processInstanceId: "pi-idempotent", status: "COMPLETED" } })
      .mockResolvedValueOnce({ result: { processInstanceId: "pi-idempotent", status: "COMPLETED" } });
    const service = new ApprovalService({
      api: { request } as unknown as Pick<DingTalkApiClient, "request">,
      writeUserIds: ["user-1"],
      callerUserId: "user-1",
      idempotencyLedger: new InMemoryIdempotencyLedger(),
    });
    const server = createApprovalMcpServer(service);
    const client = new Client({ name: "approval-idempotency-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);
    const arguments_ = {
      action: "approve" as const,
      processInstanceId: "pi-idempotent",
      taskId: "task-idempotent",
      requestId: "55555555-5555-4555-8555-555555555555",
      confirm: true,
      remark: "approved once",
    };

    const first = await client.callTool({ name: "approval_task", arguments: arguments_ });
    const repeated = await client.callTool({ name: "approval_task", arguments: arguments_ });
    const conflict = await client.callTool({
      name: "approval_task",
      arguments: { ...arguments_, remark: "different decision payload" },
    });

    expect(first.isError).not.toBe(true);
    expect(repeated.structuredContent).toMatchObject({
      result: {
        action: "approve",
        currentStatus: "COMPLETED",
        data: { upstreamResult: { success: true } },
      },
    });
    expect(request).toHaveBeenCalledTimes(4);
    expect(conflict.isError).toBe(true);
    expect(conflict.structuredContent).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
  });

  it("does not report a successful decision as failed when the post-write refresh is unavailable", async () => {
    const { client, request } = await connectedPublicClient();
    request
      .mockResolvedValueOnce({
        result: {
          processInstanceId: "pi-refresh",
          status: "RUNNING",
          tasks: [{ taskId: "task-refresh", userId: "user-1", status: "RUNNING" }],
        },
      })
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error("detail endpoint unavailable"));

    const result = await client.callTool({
      name: "approval_task",
      arguments: {
        action: "approve",
        processInstanceId: "pi-refresh",
        taskId: "task-refresh",
        requestId: "66666666-6666-4666-8666-666666666666",
        confirm: true,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        action: "approve",
        currentStatus: "UNKNOWN",
        safeNextActions: ["view"],
        data: {
          upstreamResult: { success: true },
          postActionRefresh: { ok: false },
        },
      },
    });
  });

  it("enforces attachment selection limits through approval_task itself", async () => {
    const { client, request } = await connectedPublicClient({
      result: {
        processInstanceId: "pi-public-limit",
        operationRecords: [{ attachments: [{ fileId: "one" }, { fileId: "two" }] }],
      },
    });

    const result = await client.callTool({
      name: "approval_task",
      arguments: {
        action: "view",
        processInstanceId: "pi-public-limit",
        attachmentAction: "download",
        attachmentIds: ["one", "two"],
        maxAttachments: 1,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns a selected comment attachment link and delegates download and identification to the Agent client", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          processInstanceId: "pi-comment",
          status: "RUNNING",
          operationRecords: [
            {
              attachments: [
                { fileId: "comment-file", fileName: "补充证明.pdf", fileType: "pdf", fileSize: 3 },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: { fileId: "comment-file", downloadUri: "https://files.dingtalk.com/comment.pdf" },
      });
    const service = new ApprovalService({ api: { request }, callerUserId: "user-1" });
    const server = createApprovalMcpServer(service);
    const client = new Client({ name: "approval-comment-read-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({
      name: "approval_task",
      arguments: {
        action: "view",
        processInstanceId: "pi-comment",
        attachmentAction: "download",
        attachmentIds: ["comment-file"],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        data: {
          attachmentHandling: {
            mode: "agent_client",
            agentMustDownload: true,
            agentMustIdentify: true,
            agentMustValidateRedirects: true,
            serverDownloadsFiles: false,
            serverParsesFiles: false,
            serverPerformsOcr: false,
          },
          attachmentDownloads: [
            expect.objectContaining({
              ok: true,
              source: "operation",
              fileName: "补充证明.pdf",
              download: {
                downloadUrl: "https://files.dingtalk.com/comment.pdf",
                fileName: "补充证明.pdf",
                mimeType: "application/pdf",
                fileSize: 3,
                temporary: true,
                agentActionRequired: "download_and_identify",
              },
            }),
          ],
        },
      },
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/v1.0/workflow/processInstances/spaces/files/urls/download",
      body: {
        processInstanceId: "pi-comment",
        fileId: "comment-file",
        withCommentAttatchment: true,
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("contentBase64");
  });

  it("returns a client-uploaded form attachment link even when detail reports a spaceId", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          processInstanceId: "pi-local-form-file",
          status: "RUNNING",
          formComponentValues: [
            {
              name: "其他附件",
              componentType: "DDAttachment",
              value: JSON.stringify([
                {
                  fileId: "local-file",
                  spaceId: "space-reported-for-local-file",
                  fileName: "报销凭证.jpg",
                  fileType: "jpg",
                  fileSize: 3,
                },
              ]),
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          fileId: "local-file",
          downloadUri: "http://lippi-space-zjk.oss-cn-zhangjiakou.aliyuncs.com/local-file.jpg",
        },
      });
    const service = new ApprovalService({ api: { request }, callerUserId: "user-1" });
    const server = createApprovalMcpServer(service);
    const client = new Client({ name: "approval-local-form-file-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({
      name: "approval_task",
      arguments: {
        action: "view",
        processInstanceId: "pi-local-form-file",
        attachmentAction: "download",
        attachmentIds: ["local-file"],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        data: {
          attachmentDownloads: [
            expect.objectContaining({
              ok: true,
              source: "form",
              fileName: "报销凭证.jpg",
              download: expect.objectContaining({
                downloadUrl: "https://lippi-space-zjk.oss-cn-zhangjiakou.aliyuncs.com/local-file.jpg",
                mimeType: "image/jpeg",
                fileSize: 3,
                agentActionRequired: "download_and_identify",
              }),
            }),
          ],
        },
      },
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/v1.0/workflow/processInstances/spaces/files/urls/download",
      body: {
        processInstanceId: "pi-local-form-file",
        fileId: "local-file",
        fileName: "报销凭证.jpg",
        fileType: "jpg",
      },
    });
  });

  it("keeps detail and attachment-link preparation in one compatibility tool", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          processInstanceId: "pi-1",
          operationRecords: [
            {
              attachments: [
                {
                  fileId: "file-comment",
                  spaceId: "space-comment",
                  fileName: "comment.txt",
                  fileType: "txt",
                  fileSize: 19,
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          fileId: "file-comment",
          downloadUri: "https://files.dingtalk.com/comment.txt",
        },
      });
    const client = await connectedClientWithRequest(request);

    const result = await client.callTool({
      name: "get_approval_instance",
      arguments: {
        processInstanceId: "pi-1",
        attachmentAction: "download",
        attachmentIds: ["file-comment"],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        processInstanceId: "pi-1",
        attachments: [
          expect.objectContaining({ source: "operation", fileId: "file-comment", fileName: "comment.txt" }),
        ],
        attachmentDownloads: [
          expect.objectContaining({
            ok: true,
            fileId: "file-comment",
            download: expect.objectContaining({
              downloadUrl: "https://files.dingtalk.com/comment.txt",
              fileName: "comment.txt",
              mimeType: "text/plain",
              fileSize: 19,
              agentActionRequired: "download_and_identify",
            }),
          }),
        ],
      },
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/v1.0/workflow/processInstances/spaces/files/urls/download",
      body: { processInstanceId: "pi-1", fileId: "file-comment", withCommentAttatchment: true },
    });
  });

  it("uses the approval-record download path for operation images with fileIds", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          processInstanceId: "pi-image",
          operationRecords: [
            {
              images: [
                {
                  fileId: "image-comment",
                  fileName: "comment.png",
                  fileType: "png",
                },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: {
          fileId: "image-comment",
          downloadUri: "https://files.dingtalk.com/comment.png",
        },
      });
    const client = await connectedClientWithRequest(request);

    const result = await client.callTool({
      name: "get_approval_instance",
      arguments: {
        processInstanceId: "pi-image",
        attachmentAction: "download",
        attachmentIds: ["image-comment"],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        attachmentDownloads: [
          expect.objectContaining({
            ok: true,
            source: "operation-image",
            download: expect.objectContaining({
              downloadUrl: "https://files.dingtalk.com/comment.png",
              agentActionRequired: "download_and_identify",
            }),
          }),
        ],
      },
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/v1.0/workflow/processInstances/spaces/files/urls/download",
      body: { processInstanceId: "pi-image", fileId: "image-comment", withCommentAttatchment: true },
    });
  });

  it("prepares multiple links without downloading attachment bytes on the server", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          processInstanceId: "pi-budget",
          operationRecords: [
            {
              attachments: [
                { fileId: "file-1", fileName: "one.pdf", fileSize: 3 },
                { fileId: "file-2", fileName: "two.pdf", fileSize: 3 },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: { fileId: "file-1", downloadUri: "https://files.dingtalk.com/one.pdf" },
      })
      .mockResolvedValueOnce({
        result: { fileId: "file-2", downloadUri: "https://files.dingtalk.com/two.pdf" },
      });
    const client = await connectedClientWithRequest(request);

    const result = await client.callTool({
      name: "get_approval_instance",
      arguments: {
        processInstanceId: "pi-budget",
        attachmentAction: "download",
        attachmentIds: ["file-1", "file-2"],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        attachmentDownloads: [
          expect.objectContaining({ ok: true, fileId: "file-1" }),
          expect.objectContaining({ ok: true, fileId: "file-2" }),
        ],
      },
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result.structuredContent)).not.toContain("contentBase64");
  });

  it("returns one ledger entry per requested attachment instead of failing the whole tool", async () => {
    const request = vi.fn().mockResolvedValue({
      result: {
        processInstanceId: "pi-1",
        operationRecords: [
          {
            attachments: [
              { fileId: "file-1", fileName: "one.txt" },
              { fileId: "file-2", fileName: "two.txt" },
            ],
          },
        ],
      },
    });
    const client = await connectedClientWithRequest(request);

    const result = await client.callTool({
      name: "get_approval_instance",
      arguments: {
        processInstanceId: "pi-1",
        attachmentAction: "download",
        attachmentIds: ["file-1", "missing-file"],
      },
    });

    expect(result.isError).not.toBe(true);
    const payload = result.structuredContent as {
      result: { attachmentDownloads: Array<{ ok: boolean; fileId: string; error?: { code: string } }> };
    };
    expect(payload.result.attachmentDownloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ok: false, fileId: "file-1", error: expect.objectContaining({ code: "INVALID_RESPONSE" }) }),
        expect.objectContaining({ ok: false, fileId: "missing-file", error: expect.objectContaining({ code: "ATTACHMENT_NOT_FOUND" }) }),
      ]),
    );
  });

  it("rejects attachment download mode without explicit attachment IDs", async () => {
    const { client, request } = await connectedClient({ result: { processInstanceId: "pi-1" } });

    const result = await client.callTool({
      name: "get_approval_instance",
      arguments: { processInstanceId: "pi-1", attachmentAction: "download" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed instead of silently truncating an oversized attachment selection", async () => {
    const { client, request } = await connectedClient({ result: { processInstanceId: "pi-1" } });

    const result = await client.callTool({
      name: "get_approval_instance",
      arguments: {
        processInstanceId: "pi-1",
        attachmentAction: "download",
        attachmentIds: ["one", "two"],
        maxAttachments: 1,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not publish a server-side attachment download tool", async () => {
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
        "get_approval_capabilities",
      ]),
    );
    expect(names).not.toContain("download_approval_attachment");
  });

  it("publishes a guarded start schema without caller-controlled identity or routing overrides", async () => {
    const { client } = await connectedClient();

    const tools = await client.listTools();
    const start = tools.tools.find((tool) => tool.name === "start_process_instance");
    const schema = start?.inputSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };

    expect(start).toBeDefined();
    expect(schema.required).toEqual(expect.arrayContaining(["confirm", "processCode", "deptId", "formComponentValues"]));
    expect(schema.properties).not.toHaveProperty("originatorUserId");
    expect(schema.properties).not.toHaveProperty("approvers");
    expect(schema.properties).not.toHaveProperty("ProcessInstanceCreationPopRequest");
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

  it("accepts the DWS forecast body wrapper", async () => {
    const { client, request } = await connectedClient({ result: { nodes: [] } });

    const result = await client.callTool({
      name: "forecast_process",
      arguments: { ProcessForecastPopRequest: { processCode: "PROC-1", originatorUserId: "user-1" } },
    });

    expect(result.isError).not.toBe(true);
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1.0/workflow/processes/forecast",
      body: { processCode: "PROC-1", originatorUserId: "user-1" },
    });
  });

  it("parses DWS write fields but still requires the MCP confirmation extension", async () => {
    const { client, request } = await connectedClient();

    const result = await client.callTool({
      name: "approve_processInstance",
      arguments: {
        processInstanceId: "pi-1",
        taskId: "task-1",
        requestId: "77777777-7777-4777-8777-777777777777",
        remark: "ok",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "CONFIRMATION_REQUIRED" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves supported optional official fields in the guarded creation input", async () => {
    const { client, request } = await connectedClient({ instanceId: "pi-created" });

    const result = await client.callTool({
      name: "start_process_instance",
      arguments: {
        confirm: true,
        requestId: "23c99962-c4c2-41c2-a61b-48ed3bc4a99a",
        processCode: "PROC-1",
        deptId: 1,
        formComponentValues: [],
        bizDetailPageUrl: "https://example.invalid/detail",
        microappAgentId: 12345,
        originatorUserId: "attacker-controlled-user",
        approvers: [{ userIds: ["attacker-selected-approver"] }],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1.0/workflow/processInstances",
      body: {
        processCode: "PROC-1",
        deptId: 1,
        formComponentValues: [],
        bizDetailPageUrl: "https://example.invalid/detail",
        microappAgentId: 12345,
        originatorUserId: "user-1",
      },
    });
  });
});
