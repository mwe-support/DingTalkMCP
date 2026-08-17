import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalService } from "../src/approval/service.js";
import { InMemoryIdempotencyLedger, type IdempotencyLedger } from "../src/core/idempotency.js";
import type { DingTalkApiClient } from "../src/dingtalk/client.js";
import { createApprovalMcpServer } from "../src/mcp/create-server.js";

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(closeables.splice(0).map((item) => item.close()));
});

describe("approval_request public MCP contract", () => {
  it("dry-runs an expense reimbursement with the server-derived applicant and department", async () => {
    const { client, request, getUserProfile, getDepartmentProfile } = await connectedApplicantClient();

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "submit",
        template: "expense_reimbursement",
        deptId: 42,
        fields: {
          company: "深圳市玛威尔显控科技有限公司",
          date: "2026-08-17",
          reason: "客户项目交付",
          counterparty: "测试供应商",
          items: [
            {
              amount: 123.45,
              category: "AI费用",
              expenseDepartment: "研发部",
              remark: "模型调用费用",
            },
          ],
        },
        confirm: false,
        dryRun: true,
        requestId: "33333333-3333-4333-8333-333333333333",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        action: "submit",
        template: "expense_reimbursement",
        currentStatus: "VALIDATED",
        safeNextActions: ["submit"],
        data: {
          dryRun: true,
          draft: {
            processCode: "PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0",
            deptId: 42,
            formComponentValues: expect.arrayContaining([
              expect.objectContaining({
                id: "DDSelectField_N9CRRWAYASW0",
                name: "申请员工",
                value: "张三",
              }),
              expect.objectContaining({
                id: "DDSelectField_1K2BNOEQRS800",
                name: "申请部门",
                value: "研发部",
              }),
            ]),
          },
        },
      },
    });
    expect(getUserProfile).toHaveBeenCalledWith("user-1");
    expect(getDepartmentProfile).toHaveBeenCalledWith(42);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1.0/workflow/forms/schemas/processCodes",
      query: { processCode: "PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0" },
    });
  });

  it("submits an allowlisted expense reimbursement without caller-controlled routing fields", async () => {
    const { client, request } = await connectedApplicantClient();
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/forms/schemas/processCodes") return expenseSchemaResponse();
      if (input.path === "/v1.0/workflow/processInstances") return { instanceId: "pi-expense-1" };
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "submit",
        template: "expense_reimbursement",
        deptId: 42,
        fields: {
          date: "2026-08-17",
          reason: "客户项目交付",
          counterparty: "测试供应商",
          items: [{ amount: 123.45, category: "AI费用", expenseDepartment: "研发部", remark: "模型调用费用" }],
        },
        confirm: true,
        requestId: "44444444-4444-4444-8444-444444444444",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        processInstanceId: "pi-expense-1",
        action: "submit",
        template: "expense_reimbursement",
        currentStatus: "SUBMITTED",
        safeNextActions: ["revoke"],
      },
    });
    const startCall = request.mock.calls.find(([input]) => input.path === "/v1.0/workflow/processInstances")?.[0];
    expect(startCall).toMatchObject({
      method: "POST",
      path: "/v1.0/workflow/processInstances",
      body: {
        processCode: "PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0",
        originatorUserId: "user-1",
        deptId: 42,
      },
    });
    expect(startCall.body).not.toHaveProperty("approvers");
    expect(startCall.body).not.toHaveProperty("ccList");
    expect(startCall.body).not.toHaveProperty("ccPosition");
    expect(startCall.body).not.toHaveProperty("targetSelectActioners");
  });

  it("dry-runs the exact allowlisted payment request contract", async () => {
    const { client, request } = await connectedApplicantClient();
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/forms/schemas/processCodes") return paymentSchemaResponse();
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "submit",
        template: "payment_request",
        deptId: 42,
        fields: {
          documentNumber: "FK-20260817-001",
          payee: "测试收款单位",
          currency: "CNY",
          applicationDate: "2026-08-17",
          lines: [
            {
              purpose: "项目采购A",
              amount: 0.1,
              reason: "合同付款",
              expenseDepartment: "研发部",
              beneficiaryBankAccount: "6222000000000000",
            },
            {
              purpose: "项目采购B",
              amount: 0.2,
              reason: "合同付款",
              expenseDepartment: "研发部",
            },
          ],
        },
        confirm: false,
        dryRun: true,
        requestId: "77777777-7777-4777-8777-777777777777",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        action: "submit",
        template: "payment_request",
        currentStatus: "VALIDATED",
        data: {
          draft: {
            processCode: "PROC-5E238117-7121-4CB3-8219-9F11A2E42BE4",
            formComponentValues: expect.arrayContaining([
              expect.objectContaining({ id: "TextField_RI2SYQ7VHQO0", value: "FK-20260817-001" }),
              expect.objectContaining({ id: "MoneyField_HLOCQW4U3UO0", value: "0.3" }),
            ]),
          },
        },
      },
    });
  });

  it("fails closed for the abandoned overtime template before any DingTalk API call", async () => {
    const { client, request } = await connectedApplicantClient();

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "submit",
        template: "overtime",
        deptId: 42,
        fields: {},
        confirm: true,
        requestId: "55555555-5555-4555-8555-555555555555",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("fails closed when the live template gains an unreviewed form component", async () => {
    const { client, request } = await connectedApplicantClient();
    const changed = expenseSchemaResponse();
    const result = changed.result as { schemaContent: { items: Record<string, unknown>[] } };
    result.schemaContent.items.push(component("TextField", "TextField_UNREVIEWED", "新增必填字段"));
    request.mockResolvedValue(changed);

    const response = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "submit",
        template: "expense_reimbursement",
        deptId: 42,
        fields: expenseFields(),
        confirm: false,
        dryRun: true,
        requestId: "88888888-8888-4888-8888-888888888888",
      },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({ error: { code: "TEMPLATE_SCHEMA_MISMATCH" } });
  });

  it("requires the dedicated approval:create OAuth scope", async () => {
    const { client, request } = await connectedApplicantClient({ callerScopes: ["approval:read"] });

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "submit",
        template: "expense_reimbursement",
        deptId: 42,
        fields: expenseFields(),
        confirm: false,
        dryRun: true,
        requestId: "99999999-9999-4999-8999-999999999999",
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "INSUFFICIENT_SCOPE" } });
    expect(request).not.toHaveBeenCalled();
  });

  it("revokes only an allowlisted request template and replays the persisted result idempotently", async () => {
    const { client, request } = await connectedApplicantClient();
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/processInstances") {
        return {
          result: {
            processInstanceId: "pi-revoke-1",
            processCode: "PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0",
            originatorUserId: "user-1",
            status: "RUNNING",
            tasks: [],
          },
        };
      }
      if (input.path === "/v1.0/workflow/processInstances/terminate") return { success: true };
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });
    const arguments_ = {
      action: "revoke",
      processInstanceId: "pi-revoke-1",
      requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      confirm: true,
    } as const;

    const first = await client.callTool({ name: "approval_request", arguments: arguments_ });
    const repeated = await client.callTool({ name: "approval_request", arguments: arguments_ });

    expect(first.isError).not.toBe(true);
    expect(repeated.structuredContent).toEqual(first.structuredContent);
    expect(first.structuredContent).toMatchObject({
      result: {
        processInstanceId: "pi-revoke-1",
        action: "revoke",
        template: "expense_reimbursement",
        currentStatus: "REVOKED",
      },
    });
    expect(request.mock.calls.filter(([input]) => input.path.endsWith("/terminate"))).toHaveLength(1);
  });

  it("refuses to revoke a process outside the exact request-template allowlist", async () => {
    const { client, request } = await connectedApplicantClient();
    request.mockResolvedValue({
      result: {
        processInstanceId: "pi-other-1",
        processCode: "PROC-UNREVIEWED",
        originatorUserId: "user-1",
        status: "RUNNING",
      },
    });

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "revoke",
        processInstanceId: "pi-other-1",
        requestId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        confirm: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "PROCESS_CODE_NOT_ALLOWED" } });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1.0/workflow/processInstances/terminate",
    }));
  });

  it("returns a stable pre-write rejection instead of poisoning the revoke idempotency key", async () => {
    const { client, request } = await connectedApplicantClient();
    request.mockResolvedValue({
      result: {
        processInstanceId: "pi-completed-1",
        processCode: "PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0",
        originatorUserId: "user-1",
        status: "COMPLETED",
        tasks: [],
      },
    });
    const arguments_ = {
      action: "revoke",
      processInstanceId: "pi-completed-1",
      requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      confirm: true,
    } as const;

    const first = await client.callTool({ name: "approval_request", arguments: arguments_ });
    const repeated = await client.callTool({ name: "approval_request", arguments: arguments_ });

    expect(first.structuredContent).toMatchObject({ error: { code: "INSTANCE_NOT_REVOCABLE" } });
    expect(repeated.structuredContent).toMatchObject({ error: { code: "INSTANCE_NOT_REVOCABLE" } });
    expect(JSON.stringify(repeated.structuredContent)).not.toContain("IDEMPOTENCY_OUTCOME_UNKNOWN");
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1.0/workflow/processInstances/terminate",
    }));
  });

  it("namespaces submission idempotency by the OAuth-bound applicant", async () => {
    const ledger = new InMemoryIdempotencyLedger();
    const first = await connectedApplicantClient({
      callerUserId: "user-1",
      applicantName: "张三",
      idempotencyLedger: ledger,
    });
    const second = await connectedApplicantClient({
      callerUserId: "user-2",
      applicantName: "李四",
      idempotencyLedger: ledger,
    });
    for (const [fixture, instanceId] of [[first, "pi-user-1"], [second, "pi-user-2"]] as const) {
      fixture.request.mockImplementation(async (input: { path: string }) => {
        if (input.path === "/v1.0/workflow/forms/schemas/processCodes") return expenseSchemaResponse();
        if (input.path === "/v1.0/workflow/processInstances") return { instanceId };
        throw new Error(`Unexpected DingTalk request: ${input.path}`);
      });
    }
    const arguments_ = {
      action: "submit",
      template: "expense_reimbursement",
      deptId: 42,
      fields: expenseFields(),
      confirm: true,
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    } as const;

    const firstResult = await first.client.callTool({ name: "approval_request", arguments: arguments_ });
    const secondResult = await second.client.callTool({ name: "approval_request", arguments: arguments_ });

    expect(firstResult.structuredContent).toMatchObject({ result: { processInstanceId: "pi-user-1" } });
    expect(secondResult.structuredContent).toMatchObject({ result: { processInstanceId: "pi-user-2" } });
  });

  it("prepares bounded direct-to-DingTalk attachment uploads without receiving file bytes", async () => {
    const { client, request } = await connectedApplicantClient({
      agentId: 123456,
      callerUnionId: "union-1",
      uploadHostSuffixes: [".aliyuncs.com"],
    });
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/forms/schemas/processCodes") return expenseSchemaResponse();
      if (input.path === "/v1.0/workflow/processInstances/spaces/infos/query") {
        return { result: { spaceId: 9988 } };
      }
      if (input.path === "/v1.0/storage/spaces/9988/files/uploadInfos/query") {
        return {
          uploadKey: "upload-key-1",
          headerSignatureInfo: {
            resourceUrls: ["https://mwe-approval.oss-cn-shenzhen.aliyuncs.com/upload-1"],
            headers: { Authorization: "signed-upload-header" },
            expirationSeconds: 900,
          },
        };
      }
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "prepare",
        template: "expense_reimbursement",
        deptId: 42,
        fields: expenseFields(),
        attachments: [{ field: "invoice", fileName: "发票.pdf", fileSize: 4096 }],
        confirm: true,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        action: "prepare",
        template: "expense_reimbursement",
        currentStatus: "READY_FOR_UPLOAD",
        safeNextActions: ["submit"],
        data: {
          uploadInstructions: [{
            field: "invoice",
            fileName: "发票.pdf",
            fileSize: 4096,
            uploadKey: "upload-key-1",
            spaceId: "9988",
            method: "PUT",
            uploadUrl: "https://mwe-approval.oss-cn-shenzhen.aliyuncs.com/upload-1",
            headers: { Authorization: "signed-upload-header" },
            expiresInSeconds: 900,
          }],
          clientInstruction: expect.stringContaining("Agent client"),
        },
      },
    });
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1.0/workflow/processInstances/spaces/infos/query",
      body: { userId: "user-1", agentId: 123456 },
    });
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1.0/storage/spaces/9988/files/uploadInfos/query",
      query: { unionId: "union-1" },
      body: {
        protocol: "HEADER_SIGNATURE",
        multipart: false,
        option: {
          storageDriver: "DINGTALK",
          preCheckParam: { size: 4096, parentId: "0", name: "发票.pdf" },
          preferIntranet: false,
        },
      },
    });
  });

  it("refuses to return a signed upload URL outside the configured HTTPS allowlist", async () => {
    const { client, request } = await connectedApplicantClient({
      agentId: 123456,
      callerUnionId: "union-1",
      uploadHostSuffixes: [".aliyuncs.com"],
    });
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/forms/schemas/processCodes") return expenseSchemaResponse();
      if (input.path === "/v1.0/workflow/processInstances/spaces/infos/query") return { result: { spaceId: 9988 } };
      if (input.path === "/v1.0/storage/spaces/9988/files/uploadInfos/query") {
        return {
          uploadKey: "upload-key-evil",
          headerSignatureInfo: {
            resourceUrls: ["https://attacker.example/upload"],
            headers: { Authorization: "must-not-be-returned" },
            expirationSeconds: 900,
          },
        };
      }
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "prepare",
        template: "expense_reimbursement",
        deptId: 42,
        fields: expenseFields(),
        attachments: [{ field: "invoice", fileName: "发票.pdf", fileSize: 4096 }],
        confirm: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "ATTACHMENT_URL_REJECTED" } });
    expect(JSON.stringify(result)).not.toContain("must-not-be-returned");
  });

  it("rejects an attachment batch above the 50 MiB aggregate limit before allocating upload slots", async () => {
    const { client, request } = await connectedApplicantClient({
      agentId: 123456,
      callerUnionId: "union-1",
    });

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "prepare",
        template: "expense_reimbursement",
        deptId: 42,
        fields: expenseFields(),
        attachments: [
          { field: "invoice", fileName: "a.pdf", fileSize: 20 * 1024 * 1024 },
          { field: "invoice", fileName: "b.pdf", fileSize: 20 * 1024 * 1024 },
          { field: "other", fileName: "c.pdf", fileSize: 20 * 1024 * 1024 },
        ],
        confirm: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({
      path: expect.stringContaining("uploadInfos"),
    }));
  });

  it("commits Agent-uploaded files and submits their DingTalk metadata in the expense form", async () => {
    const { client, request } = await connectedApplicantClient({
      agentId: 123456,
      callerUnionId: "union-1",
      uploadHostSuffixes: [".aliyuncs.com"],
    });
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/forms/schemas/processCodes") return expenseSchemaResponse();
      if (input.path === "/v1.0/workflow/processInstances/spaces/infos/query") return { result: { spaceId: 9988 } };
      if (input.path === "/v1.0/storage/spaces/9988/files/commit") {
        return { dentry: { id: "file-1", name: "发票.pdf", extension: "pdf", size: 4096, spaceId: 9988 } };
      }
      if (input.path === "/v1.0/workflow/processInstances") return { instanceId: "pi-expense-attachment-1" };
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });

    const arguments_ = {
      action: "submit",
      template: "expense_reimbursement",
      deptId: 42,
      fields: expenseFields(),
      uploads: [{
        field: "invoice",
        fileName: "发票.pdf",
        fileSize: 4096,
        uploadKey: "upload-key-1",
        spaceId: "9988",
      }],
      confirm: true,
      requestId: "66666666-6666-4666-8666-666666666666",
    } as const;
    const result = await client.callTool({ name: "approval_request", arguments: arguments_ });
    const repeated = await client.callTool({ name: "approval_request", arguments: arguments_ });

    expect(result.isError).not.toBe(true);
    expect(repeated.structuredContent).toEqual(result.structuredContent);
    expect(result.structuredContent).toMatchObject({
      result: {
        processInstanceId: "pi-expense-attachment-1",
        currentStatus: "SUBMITTED",
        data: { committedAttachments: [{ field: "invoice", fileId: "file-1", fileName: "发票.pdf" }] },
      },
    });
    expect(request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1.0/storage/spaces/9988/files/commit",
      query: { unionId: "union-1" },
      body: {
        uploadKey: "upload-key-1",
        name: "发票.pdf",
        parentId: "0",
        option: { size: 4096, conflictStrategy: "AUTO_RENAME" },
      },
    });
    expect(request.mock.calls.filter(([input]) => input.path.endsWith("/files/commit"))).toHaveLength(1);
    const startCalls = request.mock.calls.filter(([input]) => input.path === "/v1.0/workflow/processInstances");
    expect(startCalls).toHaveLength(1);
    const startCall = startCalls[0]?.[0];
    const attachmentValue = startCall.body.formComponentValues.find(
      (value: { id?: string }) => value.id === "DDAttachment_1JK87WWW283K0",
    );
    expect(JSON.parse(attachmentValue.value)).toEqual([{
      fileId: "file-1",
      fileName: "发票.pdf",
      fileSize: 4096,
      fileType: "pdf",
      spaceId: "9988",
    }]);
  });
});

async function connectedApplicantClient(options: {
  agentId?: number;
  callerUnionId?: string;
  uploadHostSuffixes?: string[];
  callerScopes?: Array<"approval:read" | "approval:decide" | "approval:create">;
  callerUserId?: string;
  applicantName?: string;
  idempotencyLedger?: IdempotencyLedger;
} = {}): Promise<{
  client: Client;
  request: ReturnType<typeof vi.fn>;
  getUserProfile: ReturnType<typeof vi.fn>;
  getDepartmentProfile: ReturnType<typeof vi.fn>;
}> {
  const request = vi.fn().mockImplementation(async (input: { path: string }) => {
    if (input.path === "/v1.0/workflow/forms/schemas/processCodes") return expenseSchemaResponse();
    throw new Error(`Unexpected DingTalk request: ${input.path}`);
  });
  const callerUserId = options.callerUserId ?? "user-1";
  const getUserProfile = vi.fn().mockResolvedValue({
    name: options.applicantName ?? "张三",
    departmentIds: [42],
  });
  const getDepartmentProfile = vi.fn().mockResolvedValue({ name: "研发部" });
  const api = { request, getUserProfile, getDepartmentProfile } as unknown as Pick<
    DingTalkApiClient,
    "request" | "getUserProfile" | "getDepartmentProfile"
  >;
  const service = new ApprovalService({
    api,
    callerUserId,
    writeUserIds: [callerUserId],
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
    ...(options.callerUnionId === undefined ? {} : { callerUnionId: options.callerUnionId }),
    ...(options.uploadHostSuffixes === undefined ? {} : { uploadHostSuffixes: options.uploadHostSuffixes }),
    ...(options.callerScopes === undefined ? {} : { callerScopes: options.callerScopes }),
    ...(options.idempotencyLedger === undefined ? {} : { idempotencyLedger: options.idempotencyLedger }),
  });
  const server = createApprovalMcpServer(service);
  const client = new Client({ name: "approval-request-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeables.push(client, server);
  return { client, request, getUserProfile, getDepartmentProfile };
}

function expenseFields(): Record<string, unknown> {
  return {
    date: "2026-08-17",
    reason: "客户项目交付",
    counterparty: "测试供应商",
    items: [{ amount: 123.45, category: "AI费用", expenseDepartment: "研发部", remark: "模型调用费用" }],
  };
}

function expenseSchemaResponse(): Record<string, unknown> {
  return {
    result: {
      name: "费用报销",
      procType: "inner",
      schemaContent: {
        title: "费用报销",
        items: [
          component("DDSelectField", "DDSelectField_N9CRRWAYASW0", "申请员工"),
          component("DDSelectField", "DDSelectField_1IST0QT47LS00", "公司", companyOptionStrings("option_Y4CECUDF00W0")),
          component("DDDateField", "DDDateField_B36N2UVUDK80", "日期"),
          component("DDSelectField", "DDSelectField_1K2BNOEQRS800", "申请部门"),
          component("TextareaField", "TextareaField_GBCO39RRKFK0", "事由"),
          {
            componentName: "TableField",
            props: { id: "TableField_2LQYVLLD4ZC0", label: "表格" },
            children: [
              component("MoneyField", "MoneyField_1C6K3U65P03K", "费用金额"),
              component("DDSelectField", "DDSelectField_1AH1NRQTNPLS0", "费用项目", [
                JSON.stringify({ value: "AI费用", key: "option_1S2J09XXDCV40" }),
                JSON.stringify({ value: "其它", key: "other" }),
              ]),
              component("DDSelectField", "DDSelectField_6JCCO1D991S0", "费用承担部门"),
              component("TextField", "TextField_1QEPI0PS61Q80", "备注"),
            ],
          },
          component("DDSelectField", "DDSelectField_84QMA8HYTJC0", "往来单位"),
          component("DDAttachment", "DDAttachment_1JK87WWW283K0", "发票附件"),
          component("DDAttachment", "DDAttachment_1W8BOLL7YX5S0", "其他附件"),
        ],
      },
    },
  };
}

function paymentSchemaResponse(): Record<string, unknown> {
  return {
    result: {
      name: "付款申请",
      procType: "inner",
      schemaContent: {
        title: "付款申请",
        items: [
          component("TextField", "TextField_RI2SYQ7VHQO0", "单据编号"),
          component("DDSelectField", "DDSelectField_1L4KRXZU5OAO0", "公司", companyOptionStrings("option_1K5YT9ACSXA80")),
          component("TextField", "TextField_35CD4YZ76JA0", "往来单位"),
          component("TextField", "TextField_1V3MQHOZF3A80", "收款单位"),
          component("TextField", "TextField_1MCTJ1KMMFWG0", "币别"),
          component("MoneyField", "MoneyField_HLOCQW4U3UO0", "申请付款总金额"),
          component("DDDateField", "DDDateField_1JQDDBINCMW00", "申请日期"),
          {
            componentName: "TableField",
            props: { id: "TableField_GO15CA9H0480", label: "申请付款金额" },
            children: [
              component("TextField", "TextField_A3QJPP1NBZ40", "付款用途"),
              component("TextField", "TextField_1MPQDLBMHWWW0", "申请付款金额"),
              component("TextField", "TextField_NRXU1FWNI6O0", "付款原因"),
              component("TextField", "TextField_K81R7TZF70W0", "费用承担部门"),
              component("TextField", "TextField_1RUOBECSTA2O0", "对方银行账号"),
              component("TextField", "TextField_1RZ6OM67ZT5S0", "对方账户名称"),
              component("TextField", "TextField_IQ99ISRXOUO0", "对方开户行"),
              component("TextField", "TextField_G6CDQKHU1PC0", "付款方式"),
              component("TextField", "TextField_9ACNEWARTV00", "我方银行账号"),
              component("TextField", "TextField_NWCD0HXJ20G0", "我方银行账号名称"),
              component("TextField", "TextField_1XQSEAMG895S0", "我方开户行"),
            ],
          },
          component("DDAttachment", "DDAttachment_GZOSVB0L8MO0", "附件"),
        ],
      },
    },
  };
}

function component(
  componentName: string,
  id: string,
  label: string,
  options: string[] = [],
): Record<string, unknown> {
  return { componentName, props: { id, label, options } };
}

function companyOptionStrings(firstKey: string): string[] {
  return [
    { value: "深圳市玛威尔显控科技有限公司", key: firstKey },
    { value: "深圳市玛威尔运营管理有限公司", key: "option_0" },
    { value: "深圳市利华博科技有限公司", key: "option_1" },
    { value: "深圳市玛威尔科创集团有限公司", key: "option_2" },
  ].map((value) => JSON.stringify(value));
}
