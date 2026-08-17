import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalService } from "../src/approval/service.js";
import type { ApprovalAuditEvent } from "../src/core/audit.js";
import { ApprovalMcpError } from "../src/core/errors.js";
import { InMemoryIdempotencyLedger, type IdempotencyLedger } from "../src/core/idempotency.js";
import type { DingTalkApiClient } from "../src/dingtalk/client.js";
import { createApprovalMcpServer } from "../src/mcp/create-server.js";

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(closeables.splice(0).map((item) => item.close()));
});

describe("approval_request public MCP contract", () => {
  it("auto-selects the authenticated applicant's only department when deptId is omitted", async () => {
    const { client, getUserProfile, getDepartmentProfile } = await connectedApplicantClient();

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "prepare",
        template: "expense_reimbursement",
        fields: expenseFields(),
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        action: "prepare",
        data: { draft: { deptId: 42 } },
      },
    });
    expect(getUserProfile).toHaveBeenCalledWith("user-1");
    expect(getDepartmentProfile).toHaveBeenCalledWith(42);
  });

  it("canonicalizes WorkBuddy's stale root deptId for a single-department applicant", async () => {
    const { client, getDepartmentProfile } = await connectedApplicantClient();

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "prepare",
        template: "expense_reimbursement",
        deptId: 1,
        fields: expenseFields(),
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        action: "prepare",
        data: { draft: { deptId: 42 } },
      },
    });
    expect(getDepartmentProfile).toHaveBeenCalledWith(42);
    expect(getDepartmentProfile).not.toHaveBeenCalledWith(1);
  });

  it("returns real department choices when a multi-department applicant omits deptId", async () => {
    const { client, getDepartmentProfile } = await connectedApplicantClient({
      departmentIds: [42, 84],
      departmentNames: { 42: "研发部", 84: "项目部" },
    });

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "prepare",
        template: "expense_reimbursement",
        fields: expenseFields(),
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "DEPARTMENT_SELECTION_REQUIRED",
        details: {
          departments: [
            { deptId: 42, name: "研发部" },
            { deptId: 84, name: "项目部" },
          ],
        },
      },
    });
    expect(getDepartmentProfile).toHaveBeenCalledTimes(2);
  });

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
        safeNextActions: ["comment", "revoke"],
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

  it("dry-runs a comment on the authenticated applicant's allowlisted approval", async () => {
    const { client, request } = await connectedApplicantClient({
      allowedProcessCodes: ["PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0"],
    });
    request.mockResolvedValue({
      result: {
        processInstanceId: "pi-comment-dry-run",
        title: "张三提交的费用报销",
        originatorUserId: "user-1",
        status: "RUNNING",
        tasks: [],
        formComponentValues: expenseInstanceSignatureValues(),
      },
    });

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "comment",
        processInstanceId: "pi-comment-dry-run",
        text: "补充审批说明",
        requestId: "12121212-1212-4212-8212-121212121212",
        confirm: false,
        dryRun: true,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        processInstanceId: "pi-comment-dry-run",
        action: "comment",
        template: "expense_reimbursement",
        currentStatus: "RUNNING",
        safeNextActions: ["comment", "revoke"],
        data: {
          dryRun: true,
          textLength: 6,
          textPreview: "补充审批说明",
          attachmentCount: 0,
          boundCommentUserId: "user-1",
        },
      },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1.0/workflow/processInstances/comments",
    }));
  });

  it("recognizes an allowlisted payment instance when DingTalk omits processCode", async () => {
    const { client, request } = await connectedApplicantClient();
    request.mockResolvedValue({
      result: {
        processInstanceId: "pi-payment-comment-dry-run",
        title: "张三提交的付款申请",
        originatorUserId: "user-1",
        status: "RUNNING",
        tasks: [],
        formComponentValues: paymentInstanceSignatureValues(),
      },
    });

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "comment",
        processInstanceId: "pi-payment-comment-dry-run",
        text: "付款申请补充说明",
        requestId: "13131313-1313-4313-8313-131313131313",
        confirm: false,
        dryRun: true,
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: { template: "payment_request", currentStatus: "RUNNING" },
    });
  });

  it("fails closed when a code-less instance only shares an allowlisted title", async () => {
    const { client, request } = await connectedApplicantClient();
    request.mockResolvedValue({
      result: {
        processInstanceId: "pi-title-only",
        title: "张三提交的费用报销",
        originatorUserId: "user-1",
        status: "RUNNING",
        tasks: [],
        formComponentValues: [{ id: "TextareaField_GBCO39RRKFK0" }],
      },
    });

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "comment",
        processInstanceId: "pi-title-only",
        text: "不应通过",
        requestId: "14141414-1414-4414-8414-141414141414",
        confirm: false,
        dryRun: true,
      },
    });

    expect(result.structuredContent).toMatchObject({ error: { code: "PROCESS_CODE_NOT_ALLOWED" } });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1.0/workflow/processInstances/comments",
    }));
  });

  it("applies the deployment process-code allowlist to a code-less signature match", async () => {
    const { client, request } = await connectedApplicantClient({
      allowedProcessCodes: ["PROC-5E238117-7121-4CB3-8219-9F11A2E42BE4"],
    });
    request.mockResolvedValue({
      result: {
        processInstanceId: "pi-expense-disabled",
        title: "张三提交的费用报销",
        originatorUserId: "user-1",
        status: "RUNNING",
        tasks: [],
        formComponentValues: expenseInstanceSignatureValues(),
      },
    });

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "comment",
        processInstanceId: "pi-expense-disabled",
        text: "不应通过部署允许列表",
        requestId: "15151515-1515-4515-8515-151515151515",
        confirm: false,
        dryRun: true,
      },
    });

    expect(result.structuredContent).toMatchObject({ error: { code: "PROCESS_CODE_NOT_ALLOWED" } });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1.0/workflow/processInstances/comments",
    }));
  });

  it("adds an idempotent comment as the server-bound applicant", async () => {
    const { client, request } = await connectedApplicantClient();
    let commentAdded = false;
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/processInstances") {
        return {
          result: {
            processInstanceId: "pi-comment-1",
            processCode: "PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0",
            originatorUserId: "user-1",
            status: "RUNNING",
            tasks: [],
            operationRecords: commentAdded
              ? [{ type: "ADD_REMARK", userId: "user-1", remark: "补充审批说明" }]
              : [],
          },
        };
      }
      if (input.path === "/v1.0/workflow/processInstances/comments") {
        commentAdded = true;
        return { result: true, success: true };
      }
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });
    const arguments_ = {
      action: "comment",
      processInstanceId: "pi-comment-1",
      text: "补充审批说明",
      requestId: "34343434-3434-4434-8434-343434343434",
      confirm: true,
    } as const;

    const first = await client.callTool({ name: "approval_request", arguments: arguments_ });
    const repeated = await client.callTool({ name: "approval_request", arguments: arguments_ });

    expect(first.isError).not.toBe(true);
    expect(repeated.structuredContent).toEqual(first.structuredContent);
    expect(first.structuredContent).toMatchObject({
      result: {
        processInstanceId: "pi-comment-1",
        action: "comment",
        template: "expense_reimbursement",
        currentStatus: "RUNNING",
        safeNextActions: ["comment", "revoke"],
        data: {
          dryRun: false,
          upstreamResult: { result: true, success: true },
          postActionRefresh: { ok: true, commentObserved: true, status: "RUNNING" },
        },
      },
    });
    const commentCalls = request.mock.calls.filter(([input]) => input.path.endsWith("/comments"));
    expect(commentCalls).toHaveLength(1);
    expect(commentCalls[0]?.[0]).toEqual({
      method: "POST",
      path: "/v1.0/workflow/processInstances/comments",
      body: {
        processInstanceId: "pi-comment-1",
        text: "补充审批说明",
        commentUserId: "user-1",
      },
    });
  });

  it("audits and releases the idempotency key for an explicit false comment response", async () => {
    const { client, request, approvalAuditEvents } = await connectedApplicantClient();
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/processInstances") {
        return {
          result: {
            processInstanceId: "pi-comment-rejected",
            processCode: "PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0",
            originatorUserId: "user-1",
            status: "RUNNING",
            tasks: [],
          },
        };
      }
      if (input.path === "/v1.0/workflow/processInstances/comments") {
        return { result: false, success: false };
      }
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });

    const arguments_ = {
      action: "comment",
      processInstanceId: "pi-comment-rejected",
      text: "不会成功的评论",
      requestId: "45454545-4545-4545-8545-454545454545",
      confirm: true,
    } as const;

    const first = await client.callTool({ name: "approval_request", arguments: arguments_ });
    const repeated = await client.callTool({ name: "approval_request", arguments: arguments_ });

    expect(first.structuredContent).toMatchObject({ error: { code: "APPROVAL_COMMENT_REJECTED" } });
    expect(repeated.structuredContent).toMatchObject({ error: { code: "APPROVAL_COMMENT_REJECTED" } });
    expect(approvalAuditEvents).toContainEqual(expect.objectContaining({
      action: "comment",
      outcome: "rejected",
      errorCode: "APPROVAL_COMMENT_REJECTED",
    }));
    expect(approvalAuditEvents).not.toContainEqual(expect.objectContaining({
      action: "comment",
      outcome: "succeeded",
    }));
    expect(request.mock.calls.filter(([input]) => input.path.endsWith("/comments"))).toHaveLength(2);
  });

  it("releases the comment idempotency key after a definite DingTalk rejection", async () => {
    const { client, request } = await connectedApplicantClient();
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/processInstances") {
        return {
          result: {
            processInstanceId: "pi-comment-denied",
            processCode: "PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0",
            originatorUserId: "user-1",
            status: "RUNNING",
            tasks: [],
          },
        };
      }
      if (input.path === "/v1.0/workflow/processInstances/comments") {
        throw new ApprovalMcpError("DINGTALK_API_ERROR", "Comment rejected.", { retryable: false });
      }
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });
    const arguments_ = {
      action: "comment",
      processInstanceId: "pi-comment-denied",
      text: "确定性拒绝",
      requestId: "67676767-6767-4767-8767-676767676767",
      confirm: true,
    } as const;

    const first = await client.callTool({ name: "approval_request", arguments: arguments_ });
    const repeated = await client.callTool({ name: "approval_request", arguments: arguments_ });

    expect(first.structuredContent).toMatchObject({ error: { code: "DINGTALK_API_ERROR", retryable: false } });
    expect(repeated.structuredContent).toMatchObject({ error: { code: "DINGTALK_API_ERROR", retryable: false } });
    expect(request.mock.calls.filter(([input]) => input.path.endsWith("/comments"))).toHaveLength(2);
  });

  it("rejects reuse of a successful comment requestId with different text", async () => {
    const { client, request } = await connectedApplicantClient();
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/processInstances") {
        return {
          result: {
            processInstanceId: "pi-comment-conflict",
            processCode: "PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0",
            originatorUserId: "user-1",
            status: "RUNNING",
            tasks: [],
            operationRecords: [],
          },
        };
      }
      if (input.path === "/v1.0/workflow/processInstances/comments") return { result: true, success: true };
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });
    const base = {
      action: "comment",
      processInstanceId: "pi-comment-conflict",
      requestId: "89898989-8989-4989-8989-898989898989",
      confirm: true,
    } as const;

    const first = await client.callTool({
      name: "approval_request",
      arguments: { ...base, text: "第一次评论" },
    });
    const conflict = await client.callTool({
      name: "approval_request",
      arguments: { ...base, text: "不同的第二次评论" },
    });

    expect(first.isError).not.toBe(true);
    expect(conflict.structuredContent).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
    expect(request.mock.calls.filter(([input]) => input.path.endsWith("/comments"))).toHaveLength(1);
  });

  it("blocks automatic replay after a retryable comment outcome becomes unknown", async () => {
    const { client, request } = await connectedApplicantClient();
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/processInstances") {
        return {
          result: {
            processInstanceId: "pi-comment-unknown",
            processCode: "PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0",
            originatorUserId: "user-1",
            status: "RUNNING",
            tasks: [],
          },
        };
      }
      if (input.path === "/v1.0/workflow/processInstances/comments") {
        throw new ApprovalMcpError("DINGTALK_API_ERROR", "Comment timed out.", { retryable: true });
      }
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });
    const arguments_ = {
      action: "comment",
      processInstanceId: "pi-comment-unknown",
      text: "结果未知",
      requestId: "90909090-9090-4090-8090-909090909090",
      confirm: true,
    } as const;

    const first = await client.callTool({ name: "approval_request", arguments: arguments_ });
    const repeated = await client.callTool({ name: "approval_request", arguments: arguments_ });

    expect(first.structuredContent).toMatchObject({ error: { code: "IDEMPOTENCY_OUTCOME_UNKNOWN" } });
    expect(repeated.structuredContent).toMatchObject({ error: { code: "IDEMPOTENCY_OUTCOME_UNKNOWN" } });
    expect(request.mock.calls.filter(([input]) => input.path.endsWith("/comments"))).toHaveLength(1);
  });

  it("refuses to comment on an approval initiated by another user", async () => {
    const { client, request } = await connectedApplicantClient();
    request.mockResolvedValue({
      result: {
        processInstanceId: "pi-comment-other-user",
        processCode: "PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0",
        originatorUserId: "user-2",
        status: "RUNNING",
        tasks: [],
      },
    });

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "comment",
        processInstanceId: "pi-comment-other-user",
        text: "不应写入",
        requestId: "56565656-5656-4656-8656-565656565656",
        confirm: true,
      },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "APPROVAL_COMMENT_FORBIDDEN" } });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1.0/workflow/processInstances/comments",
    }));
  });

  it("requires explicit confirmation and rejects caller-controlled comment identity", async () => {
    const { client, request } = await connectedApplicantClient();
    request.mockResolvedValue({
      result: {
        processInstanceId: "pi-comment-confirm",
        processCode: "PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0",
        originatorUserId: "user-1",
        status: "RUNNING",
        tasks: [],
      },
    });
    const base = {
      action: "comment",
      processInstanceId: "pi-comment-confirm",
      text: "补充说明",
      requestId: "78787878-7878-4878-8878-787878787878",
      confirm: false,
    } as const;

    const unconfirmed = await client.callTool({ name: "approval_request", arguments: base });
    const spoofed = await client.callTool({
      name: "approval_request",
      arguments: { ...base, confirm: true, commentUserId: "user-2" },
    });

    expect(unconfirmed.structuredContent).toMatchObject({ error: { code: "CONFIRMATION_REQUIRED" } });
    expect(spoofed.structuredContent).toMatchObject({ error: { code: "INVALID_INPUT" } });
    expect(request).not.toHaveBeenCalledWith(expect.objectContaining({
      path: "/v1.0/workflow/processInstances/comments",
    }));
  });

  it("revokes only an allowlisted request template and replays the persisted result idempotently", async () => {
    const { client, request } = await connectedApplicantClient({
      allowedProcessCodes: ["PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0"],
    });
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/processInstances") {
        return {
          result: {
            processInstanceId: "pi-revoke-1",
            title: "张三提交的费用报销",
            originatorUserId: "user-1",
            status: "RUNNING",
            tasks: [],
            formComponentValues: expenseInstanceSignatureValues(),
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

  it("releases submission idempotency after a definite DingTalk rejection", async () => {
    const { client, request } = await connectedApplicantClient();
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/forms/schemas/processCodes") return expenseSchemaResponse();
      if (input.path === "/v1.0/workflow/processInstances") {
        throw new ApprovalMcpError("DINGTALK_API_ERROR", "DingTalk OpenAPI rejected the request.", {
          details: { status: 400, upstreamCode: "InvalidParameter" },
          retryable: false,
        });
      }
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });
    const arguments_ = {
      action: "submit",
      template: "expense_reimbursement",
      deptId: 42,
      fields: expenseFields(),
      confirm: true,
      requestId: "abababab-abab-4bab-8bab-abababababab",
    } as const;

    const first = await client.callTool({ name: "approval_request", arguments: arguments_ });
    const repeated = await client.callTool({ name: "approval_request", arguments: arguments_ });

    expect(first.structuredContent).toMatchObject({
      error: { code: "DINGTALK_API_ERROR", retryable: false, details: { status: 400, upstreamCode: "InvalidParameter" } },
    });
    expect(repeated.structuredContent).toMatchObject({
      error: { code: "DINGTALK_API_ERROR", retryable: false, details: { status: 400, upstreamCode: "InvalidParameter" } },
    });
    expect(request.mock.calls.filter(([input]) => input.path === "/v1.0/workflow/processInstances")).toHaveLength(2);
  });

  it("keeps submission idempotency blocked after a retryable DingTalk failure", async () => {
    const { client, request } = await connectedApplicantClient();
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/forms/schemas/processCodes") return expenseSchemaResponse();
      if (input.path === "/v1.0/workflow/processInstances") {
        throw new ApprovalMcpError("DINGTALK_API_ERROR", "DingTalk request timed out.", { retryable: true });
      }
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });
    const arguments_ = {
      action: "submit",
      template: "expense_reimbursement",
      deptId: 42,
      fields: expenseFields(),
      confirm: true,
      requestId: "acacacac-acac-4cac-8cac-acacacacacac",
    } as const;

    const first = await client.callTool({ name: "approval_request", arguments: arguments_ });
    const repeated = await client.callTool({ name: "approval_request", arguments: arguments_ });

    expect(first.structuredContent).toMatchObject({ error: { code: "IDEMPOTENCY_OUTCOME_UNKNOWN" } });
    expect(repeated.structuredContent).toMatchObject({ error: { code: "IDEMPOTENCY_OUTCOME_UNKNOWN" } });
    expect(request.mock.calls.filter(([input]) => input.path === "/v1.0/workflow/processInstances")).toHaveLength(1);
  });

  it("keeps submission idempotency blocked for an HTTP 408 even if an adapter labels it nonretryable", async () => {
    const { client, request } = await connectedApplicantClient();
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/forms/schemas/processCodes") return expenseSchemaResponse();
      if (input.path === "/v1.0/workflow/processInstances") {
        throw new ApprovalMcpError("DINGTALK_API_ERROR", "DingTalk request timeout.", {
          details: { status: 408, upstreamCode: "RequestTimeout" },
          retryable: false,
        });
      }
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });
    const arguments_ = {
      action: "submit",
      template: "expense_reimbursement",
      deptId: 42,
      fields: expenseFields(),
      confirm: true,
      requestId: "aeaeaeae-aeae-4eae-8eae-aeaeaeaeaeae",
    } as const;

    const first = await client.callTool({ name: "approval_request", arguments: arguments_ });
    const repeated = await client.callTool({ name: "approval_request", arguments: arguments_ });

    expect(first.structuredContent).toMatchObject({ error: { code: "IDEMPOTENCY_OUTCOME_UNKNOWN" } });
    expect(repeated.structuredContent).toMatchObject({ error: { code: "IDEMPOTENCY_OUTCOME_UNKNOWN" } });
    expect(request.mock.calls.filter(([input]) => input.path === "/v1.0/workflow/processInstances")).toHaveLength(1);
  });

  it("keeps submission idempotency blocked when an attachment committed before a definite start rejection", async () => {
    const { client, request, approvalAuditEvents } = await connectedApplicantClient({
      agentId: 123456,
      callerUnionId: "union-1",
    });
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/forms/schemas/processCodes") return expenseSchemaResponse();
      if (input.path === "/v1.0/workflow/processInstances/spaces/infos/query") return { result: { spaceId: 9988 } };
      if (input.path === "/v1.0/storage/spaces/9988/files/commit") {
        return { dentry: { id: "file-side-effect", name: "invoice.pdf", extension: "pdf", size: 4096, spaceId: 9988 } };
      }
      if (input.path === "/v1.0/workflow/processInstances") {
        throw new ApprovalMcpError("DINGTALK_API_ERROR", "DingTalk rejected the approval.", {
          details: {
            status: 400,
            upstreamCode: "InvalidParameter",
            requestId: "upstream-create-rejected-1",
          },
          retryable: false,
        });
      }
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });
    const arguments_ = {
      action: "submit",
      template: "expense_reimbursement",
      deptId: 42,
      fields: expenseFields(),
      uploads: [{
        field: "invoice",
        fileName: "invoice.pdf",
        fileSize: 4096,
        uploadKey: "upload-side-effect",
        spaceId: "9988",
      }],
      confirm: true,
      requestId: "adadadad-adad-4dad-8dad-adadadadadad",
    } as const;

    const first = await client.callTool({ name: "approval_request", arguments: arguments_ });
    const repeated = await client.callTool({ name: "approval_request", arguments: arguments_ });

    const expectedDiagnostic = {
      failureStage: "approval_create",
      committedAttachmentCount: 1,
      totalAttachmentCount: 1,
      causeCode: "DINGTALK_API_ERROR",
      causeRetryable: false,
      httpStatus: 400,
      upstreamCode: "InvalidParameter",
      requestId: "upstream-create-rejected-1",
    };
    expect(first.structuredContent).toMatchObject({
      error: { code: "IDEMPOTENCY_OUTCOME_UNKNOWN", details: expectedDiagnostic },
    });
    expect(repeated.structuredContent).toMatchObject({
      error: { code: "IDEMPOTENCY_OUTCOME_UNKNOWN", details: expectedDiagnostic },
    });
    const serialized = JSON.stringify(first.structuredContent);
    expect(serialized).not.toContain("invoice.pdf");
    expect(serialized).not.toContain("upload-side-effect");
    expect(request.mock.calls.filter(([input]) => input.path.endsWith("/files/commit"))).toHaveLength(1);
    expect(request.mock.calls.filter(([input]) => input.path === "/v1.0/workflow/processInstances")).toHaveLength(1);
    expect(approvalAuditEvents).toContainEqual(expect.objectContaining({
      action: "start",
      outcome: "uncertain",
      errorCode: "IDEMPOTENCY_OUTCOME_UNKNOWN",
      upstreamRequestId: "upstream-create-rejected-1",
    }));
  });

  it("reports the failed attachment commit index without exposing attachment credentials", async () => {
    const { client, request } = await connectedApplicantClient({
      agentId: 123456,
      callerUnionId: "union-1",
    });
    let commitCall = 0;
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/forms/schemas/processCodes") return expenseSchemaResponse();
      if (input.path === "/v1.0/workflow/processInstances/spaces/infos/query") return { result: { spaceId: 9988 } };
      if (input.path === "/v1.0/storage/spaces/9988/files/commit") {
        commitCall++;
        if (commitCall === 1) {
          return { dentry: { id: "file-first", name: "first.pdf", extension: "pdf", size: 1024, spaceId: 9988 } };
        }
        throw new ApprovalMcpError("DINGTALK_API_ERROR", "DingTalk storage unavailable.", {
          details: { status: 503, upstreamCode: "ServiceUnavailable", requestId: "upstream-commit-2" },
          retryable: true,
        });
      }
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });
    const arguments_ = {
      action: "submit",
      template: "expense_reimbursement",
      deptId: 42,
      fields: expenseFields(),
      uploads: [
        { field: "invoice", fileName: "first.pdf", fileSize: 1024, uploadKey: "secret-first", spaceId: "9988" },
        { field: "other", fileName: "second.pdf", fileSize: 2048, uploadKey: "secret-second", spaceId: "9988" },
      ],
      confirm: true,
      requestId: "afafafaf-afaf-4faf-8faf-afafafafafaf",
    } as const;

    const first = await client.callTool({ name: "approval_request", arguments: arguments_ });
    const repeated = await client.callTool({ name: "approval_request", arguments: arguments_ });
    const expectedDiagnostic = {
      failureStage: "attachment_commit",
      attachmentIndex: 2,
      committedAttachmentCount: 1,
      totalAttachmentCount: 2,
      causeCode: "DINGTALK_API_ERROR",
      causeRetryable: true,
      httpStatus: 503,
      upstreamCode: "ServiceUnavailable",
      requestId: "upstream-commit-2",
    };

    expect(first.structuredContent).toMatchObject({
      error: { code: "IDEMPOTENCY_OUTCOME_UNKNOWN", details: expectedDiagnostic },
    });
    expect(repeated.structuredContent).toMatchObject({
      error: { code: "IDEMPOTENCY_OUTCOME_UNKNOWN", details: expectedDiagnostic },
    });
    const serialized = JSON.stringify(first.structuredContent);
    expect(serialized).not.toContain("first.pdf");
    expect(serialized).not.toContain("second.pdf");
    expect(serialized).not.toContain("secret-first");
    expect(serialized).not.toContain("secret-second");
    expect(commitCall).toBe(2);
  });

  it("preserves a created instance ID when only succeeded-ledger persistence fails", async () => {
    const backing = new InMemoryIdempotencyLedger();
    const ledger: IdempotencyLedger = {
      reserve: (key, fingerprint) => backing.reserve(key, fingerprint),
      get: (key) => backing.get(key),
      put: async (key, entry) => {
        if (entry.status === "succeeded") {
          throw new ApprovalMcpError("IDEMPOTENCY_LEDGER_ERROR", "Ledger unavailable.");
        }
        await backing.put(key, entry);
      },
      delete: (key) => backing.delete(key),
    };
    const { client, request } = await connectedApplicantClient({ idempotencyLedger: ledger });
    request.mockImplementation(async (input: { path: string }) => {
      if (input.path === "/v1.0/workflow/forms/schemas/processCodes") return expenseSchemaResponse();
      if (input.path === "/v1.0/workflow/processInstances") return { instanceId: "pi-ledger-partial-1" };
      throw new Error(`Unexpected DingTalk request: ${input.path}`);
    });

    const result = await client.callTool({
      name: "approval_request",
      arguments: {
        action: "submit",
        template: "expense_reimbursement",
        deptId: 42,
        fields: expenseFields(),
        confirm: true,
        requestId: "b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0",
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        processInstanceId: "pi-ledger-partial-1",
        currentStatus: "SUBMITTED",
        data: {
          idempotencyPersistence: "failed",
          retryWithSameRequestId: false,
        },
      },
    });
    expect(request.mock.calls.filter(([input]) => input.path === "/v1.0/workflow/processInstances")).toHaveLength(1);
  });

  it("prepares bounded direct-to-DingTalk attachment uploads without receiving file bytes", async () => {
    const { client, request } = await connectedApplicantClient({
      agentId: 123456,
      callerUnionId: "union-1",
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
            resourceUrls: ["https://sh-dualstack.trans.dingtalk.com/upload-1"],
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
            uploadUrl: "https://sh-dualstack.trans.dingtalk.com/upload-1",
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
  departmentIds?: number[];
  departmentNames?: Record<number, string>;
  allowedProcessCodes?: string[];
  idempotencyLedger?: IdempotencyLedger;
} = {}): Promise<{
  client: Client;
  request: ReturnType<typeof vi.fn>;
  getUserProfile: ReturnType<typeof vi.fn>;
  getDepartmentProfile: ReturnType<typeof vi.fn>;
  approvalAuditEvents: ApprovalAuditEvent[];
}> {
  const request = vi.fn().mockImplementation(async (input: { path: string }) => {
    if (input.path === "/v1.0/workflow/forms/schemas/processCodes") return expenseSchemaResponse();
    throw new Error(`Unexpected DingTalk request: ${input.path}`);
  });
  const callerUserId = options.callerUserId ?? "user-1";
  const getUserProfile = vi.fn().mockResolvedValue({
    name: options.applicantName ?? "张三",
    departmentIds: options.departmentIds ?? [42],
  });
  const getDepartmentProfile = vi.fn().mockImplementation(async (deptId: number) => ({
    name: options.departmentNames?.[deptId] ?? "研发部",
  }));
  const api = { request, getUserProfile, getDepartmentProfile } as unknown as Pick<
    DingTalkApiClient,
    "request" | "getUserProfile" | "getDepartmentProfile"
  >;
  const approvalAuditEvents: ApprovalAuditEvent[] = [];
  const service = new ApprovalService({
    api,
    audit: { record: (event) => { approvalAuditEvents.push(event); } },
    callerUserId,
    writeUserIds: [callerUserId],
    ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
    ...(options.callerUnionId === undefined ? {} : { callerUnionId: options.callerUnionId }),
    ...(options.uploadHostSuffixes === undefined ? {} : { uploadHostSuffixes: options.uploadHostSuffixes }),
    ...(options.callerScopes === undefined ? {} : { callerScopes: options.callerScopes }),
    ...(options.allowedProcessCodes === undefined ? {} : { allowedProcessCodes: options.allowedProcessCodes }),
    ...(options.idempotencyLedger === undefined ? {} : { idempotencyLedger: options.idempotencyLedger }),
  });
  const server = createApprovalMcpServer(service);
  const client = new Client({ name: "approval-request-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closeables.push(client, server);
  return { client, request, getUserProfile, getDepartmentProfile, approvalAuditEvents };
}

function expenseFields(): Record<string, unknown> {
  return {
    date: "2026-08-17",
    reason: "客户项目交付",
    counterparty: "测试供应商",
    items: [{ amount: 123.45, category: "AI费用", expenseDepartment: "研发部", remark: "模型调用费用" }],
  };
}

function expenseInstanceSignatureValues(): Array<Record<string, unknown>> {
  return [
    "DDSelectField_N9CRRWAYASW0",
    "DDDateField_B36N2UVUDK80",
    "DDSelectField_1K2BNOEQRS800",
    "TextareaField_GBCO39RRKFK0",
    "TableField_2LQYVLLD4ZC0",
    "DDSelectField_84QMA8HYTJC0",
  ].map((id) => ({ id }));
}

function paymentInstanceSignatureValues(): Array<Record<string, unknown>> {
  return [
    "TextField_RI2SYQ7VHQO0",
    "TextField_1V3MQHOZF3A80",
    "TextField_1MCTJ1KMMFWG0",
    "MoneyField_HLOCQW4U3UO0",
    "DDDateField_1JQDDBINCMW00",
    "TableField_GO15CA9H0480",
  ].map((id) => ({ id }));
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
          component("RelateField", "RelateField_QX0TTZEV3340", "关联审批单"),
          component("InvoiceField", "InvoiceField_1WLDY3UBS5R40", "发票"),
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
