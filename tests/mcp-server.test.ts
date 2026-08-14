import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalService } from "../src/approval/service.js";
import { AttachmentDownloader } from "../src/approval/attachments.js";
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

async function connectedClientWithDownloader(
  request: ReturnType<typeof vi.fn>,
  downloader: AttachmentDownloader,
  options: { attachmentBatchMaxBytes?: number } = {},
): Promise<Client> {
  const service = new ApprovalService({
    api: { request } as unknown as Pick<DingTalkApiClient, "request">,
    downloader,
    callerUserId: "user-1",
    ...options,
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

describe("approval MCP public contract", () => {
  it("publishes one role-cohesive approval_task tool instead of endpoint-shaped tools", async () => {
    const { client } = await connectedPublicClient();

    const tools = await client.listTools();

    expect(tools.tools.map((tool) => tool.name)).toEqual(["approval_task"]);
    expect(tools.tools[0]?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
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
          attachmentReads: [],
          actionableTasks: [expect.objectContaining({ taskId: "task-1", userId: "user-1" })],
        },
      },
    });
    expect(request).toHaveBeenCalledOnce();
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

  it("reads a selected comment attachment inside action=view with DingTalk's comment flag", async () => {
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
    const downloader = new AttachmentDownloader({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "application/pdf", "content-length": "3" },
        }),
      ),
      allowedHostSuffixes: [".dingtalk.com"],
    });
    const service = new ApprovalService({ api: { request }, downloader, callerUserId: "user-1" });
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
        attachmentAction: "read",
        attachmentIds: ["comment-file"],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        data: {
          attachmentReads: [
            expect.objectContaining({
              ok: true,
              source: "operation",
              fileName: "补充证明.pdf",
              content: expect.objectContaining({ mimeType: "application/pdf", size: 3 }),
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
  });

  it("keeps detail and attachment reading in one get_approval_instance tool", async () => {
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
    const bytes = new TextEncoder().encode("approval attachment");
    const downloader = new AttachmentDownloader({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "text/plain", "content-length": String(bytes.byteLength) },
        }),
      ),
      allowedHostSuffixes: [".dingtalk.com"],
    });
    const client = await connectedClientWithDownloader(request, downloader);

    const result = await client.callTool({
      name: "get_approval_instance",
      arguments: {
        processInstanceId: "pi-1",
        attachmentAction: "read",
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
        attachmentReads: [
          expect.objectContaining({
            ok: true,
            fileId: "file-comment",
            content: expect.objectContaining({
              fileName: "comment.txt",
              mimeType: "text/plain",
              size: bytes.byteLength,
              contentBase64: Buffer.from(bytes).toString("base64"),
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
    const downloader = new AttachmentDownloader({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "3" },
        }),
      ),
      allowedHostSuffixes: [".dingtalk.com"],
    });
    const client = await connectedClientWithDownloader(request, downloader);

    const result = await client.callTool({
      name: "get_approval_instance",
      arguments: {
        processInstanceId: "pi-image",
        attachmentAction: "read",
        attachmentIds: ["image-comment"],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        attachmentReads: [expect.objectContaining({ ok: true, source: "operation-image" })],
      },
    });
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/v1.0/workflow/processInstances/spaces/files/urls/download",
      body: { processInstanceId: "pi-image", fileId: "image-comment", withCommentAttatchment: true },
    });
  });

  it("keeps the combined attachment response within one aggregate byte budget", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          processInstanceId: "pi-budget",
          operationRecords: [
            {
              attachments: [
                { fileId: "file-1", fileName: "one.bin", fileSize: 3 },
                { fileId: "file-2", fileName: "two.bin", fileSize: 3 },
              ],
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        result: { fileId: "file-1", downloadUri: "https://files.dingtalk.com/one.bin" },
      });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/octet-stream", "content-length": "3" },
      }),
    );
    const client = await connectedClientWithDownloader(
      request,
      new AttachmentDownloader({ fetch: fetchMock, allowedHostSuffixes: [".dingtalk.com"] }),
      { attachmentBatchMaxBytes: 4 },
    );

    const result = await client.callTool({
      name: "get_approval_instance",
      arguments: {
        processInstanceId: "pi-budget",
        attachmentAction: "read",
        attachmentIds: ["file-1", "file-2"],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        attachmentReads: [
          expect.objectContaining({ ok: true, fileId: "file-1" }),
          expect.objectContaining({
            ok: false,
            fileId: "file-2",
            error: expect.objectContaining({ code: "ATTACHMENT_BATCH_TOO_LARGE" }),
          }),
        ],
      },
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    const downloader = new AttachmentDownloader({ fetch: vi.fn<typeof fetch>() });
    const client = await connectedClientWithDownloader(request, downloader);

    const result = await client.callTool({
      name: "get_approval_instance",
      arguments: {
        processInstanceId: "pi-1",
        attachmentAction: "read",
        attachmentIds: ["file-1", "missing-file"],
      },
    });

    expect(result.isError).not.toBe(true);
    const payload = result.structuredContent as {
      result: { attachmentReads: Array<{ ok: boolean; fileId: string; error?: { code: string } }> };
    };
    expect(payload.result.attachmentReads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ok: false, fileId: "file-1", error: expect.objectContaining({ code: "INVALID_RESPONSE" }) }),
        expect.objectContaining({ ok: false, fileId: "missing-file", error: expect.objectContaining({ code: "ATTACHMENT_NOT_FOUND" }) }),
      ]),
    );
  });

  it("rejects attachment read mode without explicit attachment IDs", async () => {
    const { client, request } = await connectedClient({ result: { processInstanceId: "pi-1" } });

    const result = await client.callTool({
      name: "get_approval_instance",
      arguments: { processInstanceId: "pi-1", attachmentAction: "read" },
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
        attachmentAction: "read",
        attachmentIds: ["one", "two"],
        maxAttachments: 1,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(request).toHaveBeenCalledTimes(1);
  });

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
      arguments: { processInstanceId: "pi-1", taskId: "task-1", remark: "ok" },
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
