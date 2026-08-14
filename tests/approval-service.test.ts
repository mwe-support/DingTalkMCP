import { describe, expect, it, vi } from "vitest";

import { ApprovalService } from "../src/approval/service.js";
import { ApprovalMcpError } from "../src/core/errors.js";
import { InMemoryIdempotencyLedger } from "../src/core/idempotency.js";
import type { DingTalkApiClient } from "../src/dingtalk/client.js";

function apiMock(): Pick<DingTalkApiClient, "request"> {
  return { request: vi.fn() };
}

describe("ApprovalService OpenAPI contract", () => {
  it("reads a process instance through the documented detail endpoint", async () => {
    const api = apiMock();
    vi.mocked(api.request).mockResolvedValue({ result: { processInstanceId: "pi-1" } });
    const service = new ApprovalService({ api });

    const result = await service.getProcessInstanceDetail("pi-1");

    expect(api.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1.0/workflow/processInstances",
      query: { processInstanceId: "pi-1" },
    });
    expect(result.normalized.processInstanceId).toBe("pi-1");
    expect(result.raw).toEqual({ processInstanceId: "pi-1" });
  });

  it("uses RequestId and a caller-confirmation gate when starting an instance", async () => {
    const api = apiMock();
    const auditEvents: Array<Record<string, unknown>> = [];
    vi.mocked(api.request).mockResolvedValue({ instanceId: "pi-created" });
    const service = new ApprovalService({
      api,
      writeUserIds: ["user-1"],
      callerUserId: "user-1",
      audit: {
        record: (event) => {
          auditEvents.push(event as unknown as Record<string, unknown>);
        },
      },
    });

    await expect(
      service.startProcessInstance({
        confirm: false,
        requestId: "2c1b28fb-4913-4d53-93b6-5b580eecfbce",
        processCode: "PROC-1",
        originatorUserId: "user-1",
        deptId: 123,
        formComponentValues: [],
      }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(api.request).not.toHaveBeenCalled();
    expect(auditEvents).toEqual([
      expect.objectContaining({ action: "start", actorUserId: "user-1", outcome: "rejected" }),
    ]);

    await expect(
      service.startProcessInstance({
        confirm: true,
        requestId: "2c1b28fb-4913-4d53-93b6-5b580eecfbce",
        processCode: "PROC-1",
        originatorUserId: "user-1",
        deptId: 123,
        formComponentValues: [],
      }),
    ).resolves.toEqual({ instanceId: "pi-created" });
    expect(auditEvents).toEqual([
      expect.objectContaining({ action: "start", outcome: "rejected" }),
      expect.objectContaining({ action: "start", actorUserId: "user-1", outcome: "succeeded" }),
    ]);

    expect(api.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1.0/workflow/processInstances",
      body: {
        processCode: "PROC-1",
        originatorUserId: "user-1",
        deptId: 123,
        formComponentValues: [],
      },
    });
  });

  it("deduplicates the same local requestId and rejects reuse with a different payload", async () => {
    const api = apiMock();
    vi.mocked(api.request).mockResolvedValue({ instanceId: "pi-created" });
    const service = new ApprovalService({ api, writeUserIds: ["user-1"], callerUserId: "user-1" });
    const first = {
      confirm: true as const,
      requestId: "2c1b28fb-4913-4d53-93b6-5b580eecfbce",
      processCode: "PROC-1",
      originatorUserId: "user-1",
      deptId: 123,
      formComponentValues: [],
    };

    await expect(service.startProcessInstance(first)).resolves.toEqual({ instanceId: "pi-created" });
    await expect(service.startProcessInstance(first)).resolves.toEqual({ instanceId: "pi-created" });
    expect(api.request).toHaveBeenCalledTimes(1);

    await expect(
      service.startProcessInstance({ ...first, processCode: "PROC-2" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("fails closed when a write actor is not in the configured allowlist", async () => {
    const api = apiMock();
    const service = new ApprovalService({ api, writeUserIds: [], callerUserId: "user-1" });

    await expect(
      service.executeTask({
        confirm: true,
        processInstanceId: "pi-1",
        taskId: 456,
        requestId: "11111111-1111-4111-8111-111111111111",
        actionerUserId: "user-1",
        result: "agree",
      }),
    ).rejects.toMatchObject({ code: "WRITE_ACTOR_NOT_ALLOWED" });
    expect(api.request).not.toHaveBeenCalled();
  });

  it("supports a non-mutating dry run without requiring confirmation", async () => {
    const api = apiMock();
    const service = new ApprovalService({ api, writeUserIds: ["user-1"], callerUserId: "user-1" });

    await expect(
      service.startProcessInstance({
        confirm: false,
        dryRun: true,
        requestId: "",
        processCode: "PROC-1",
        deptId: 123,
        formComponentValues: [{ name: "amount", value: "1" }],
      }),
    ).resolves.toEqual({
      dryRun: true,
      action: "start",
      processCode: "PROC-1",
      formComponentCount: 1,
      requestIdPresent: false,
    });
    expect(api.request).not.toHaveBeenCalled();
  });

  it("rechecks the current task and actor before approving", async () => {
    const api = apiMock();
    vi.mocked(api.request)
      .mockResolvedValueOnce({
        result: { processInstanceId: "pi-1", status: "RUNNING", tasks: [{ taskId: 456, userId: "user-1", status: "RUNNING" }] },
      })
      .mockResolvedValueOnce({ success: true });
    const service = new ApprovalService({ api, writeUserIds: ["user-1"], callerUserId: "user-1" });

    await expect(
      service.executeTask({
        confirm: true,
        processInstanceId: "pi-1",
        taskId: 456,
        requestId: "22222222-2222-4222-8222-222222222222",
        actionerUserId: "user-1",
        result: "agree",
      }),
    ).resolves.toEqual({ success: true });

    expect(api.request).toHaveBeenNthCalledWith(1, {
      method: "GET",
      path: "/v1.0/workflow/processInstances",
      query: { processInstanceId: "pi-1" },
    });
    expect(api.request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/v1.0/workflow/processInstances/execute",
      body: {
        processInstanceId: "pi-1",
        taskId: 456,
        actionerUserId: "user-1",
        result: "agree",
      },
    });
  });

  it("does not mutate when the current task belongs to another user", async () => {
    const api = apiMock();
    vi.mocked(api.request).mockResolvedValue({
      result: { processInstanceId: "pi-1", status: "RUNNING", tasks: [{ taskId: 456, userId: "user-2", status: "RUNNING" }] },
    });
    const service = new ApprovalService({ api, writeUserIds: ["user-1"], callerUserId: "user-1" });

    await expect(
      service.executeTask({
        confirm: true,
        processInstanceId: "pi-1",
        taskId: 456,
        requestId: "44444444-4444-4444-8444-444444444444",
        actionerUserId: "user-1",
        result: "agree",
      }),
    ).rejects.toMatchObject({ code: "TASK_ACTOR_MISMATCH" });
    expect(api.request).toHaveBeenCalledTimes(1);
  });

  it("rechecks revocation state and originator before terminating an instance", async () => {
    const api = apiMock();
    vi.mocked(api.request)
      .mockResolvedValueOnce({ result: { processInstanceId: "pi-1", status: "RUNNING", originatorUserId: "user-1" } })
      .mockResolvedValueOnce({ success: true });
    const service = new ApprovalService({ api, writeUserIds: ["user-1"], callerUserId: "user-1" });

    await expect(
      service.revokeProcessInstance({
        confirm: true,
        processInstanceId: "pi-1",
        operatingUserId: "user-1",
        remark: "submitted by mistake",
      }),
    ).resolves.toEqual({ success: true });
    expect(api.request).toHaveBeenCalledTimes(2);

    vi.mocked(api.request).mockClear();
    vi.mocked(api.request).mockResolvedValue({
      result: { processInstanceId: "pi-2", status: "COMPLETED", originatorUserId: "user-1" },
    });
    await expect(
      service.revokeProcessInstance({
        confirm: true,
        processInstanceId: "pi-2",
        operatingUserId: "user-1",
      }),
    ).rejects.toMatchObject({ code: "INSTANCE_NOT_REVOCABLE" });
    expect(api.request).toHaveBeenCalledTimes(1);
  });

  it("binds all mutation actors to the server-authenticated caller", async () => {
    const api = apiMock();
    const service = new ApprovalService({
      api,
      writeUserIds: ["user-1", "user-2"],
      callerUserId: "user-1",
    });

    await expect(
      service.startProcessInstance({
        confirm: true,
        requestId: "2c1b28fb-4913-4d53-93b6-5b580eecfbce",
        processCode: "PROC-1",
        originatorUserId: "user-2",
        deptId: 123,
        formComponentValues: [],
      }),
    ).rejects.toMatchObject({ code: "CALLER_IDENTITY_MISMATCH" });
    expect(api.request).not.toHaveBeenCalled();
  });

  it("applies the processCode allowlist to decisions after refreshing detail", async () => {
    const api = apiMock();
    vi.mocked(api.request).mockResolvedValue({
      result: {
        processInstanceId: "pi-1",
        processCode: "PROC-DENIED",
        status: "RUNNING",
        tasks: [{ taskId: 456, userId: "user-1", status: "RUNNING" }],
      },
    });
    const service = new ApprovalService({
      api,
      writeUserIds: ["user-1"],
      callerUserId: "user-1",
      allowedProcessCodes: ["PROC-ALLOWED"],
    });

    await expect(
      service.executeTask({
        confirm: true,
        processInstanceId: "pi-1",
        taskId: 456,
        requestId: "44444444-4444-4444-8444-444444444444",
        actionerUserId: "user-1",
        result: "agree",
      }),
    ).rejects.toMatchObject({ code: "PROCESS_CODE_NOT_ALLOWED" });
    expect(api.request).toHaveBeenCalledTimes(1);
  });

  it("reuses a persisted successful creation result across service restarts", async () => {
    const ledger = new InMemoryIdempotencyLedger();
    const firstApi = apiMock();
    vi.mocked(firstApi.request).mockResolvedValue({ instanceId: "pi-created" });
    const options = {
      writeUserIds: ["user-1"],
      callerUserId: "user-1",
      idempotencyLedger: ledger,
    } as const;
    const input = {
      confirm: true,
      requestId: "2c1b28fb-4913-4d53-93b6-5b580eecfbce",
      processCode: "PROC-1",
      deptId: 123,
      formComponentValues: [],
    };

    await expect(new ApprovalService({ api: firstApi, ...options }).startProcessInstance(input)).resolves.toEqual({
      instanceId: "pi-created",
    });
    await expect(ledger.get(input.requestId)).resolves.toMatchObject({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      status: "succeeded",
    });

    const restartedApi = apiMock();
    await expect(new ApprovalService({ api: restartedApi, ...options }).startProcessInstance(input)).resolves.toEqual({
      instanceId: "pi-created",
    });
    expect(restartedApi.request).not.toHaveBeenCalled();
  });

  it("fails closed after an uncertain creation result instead of submitting twice", async () => {
    const ledger = new InMemoryIdempotencyLedger();
    const api = apiMock();
    vi.mocked(api.request).mockRejectedValue(
      new ApprovalMcpError("DINGTALK_API_ERROR", "timeout", { retryable: true }),
    );
    const service = new ApprovalService({
      api,
      writeUserIds: ["user-1"],
      callerUserId: "user-1",
      idempotencyLedger: ledger,
    });
    const input = {
      confirm: true,
      requestId: "2c1b28fb-4913-4d53-93b6-5b580eecfbce",
      processCode: "PROC-1",
      deptId: 123,
      formComponentValues: [],
    };

    await expect(service.startProcessInstance(input)).rejects.toMatchObject({ code: "IDEMPOTENCY_OUTCOME_UNKNOWN" });
    await expect(service.startProcessInstance(input)).rejects.toMatchObject({ code: "IDEMPOTENCY_OUTCOME_UNKNOWN" });
    expect(api.request).toHaveBeenCalledTimes(1);
  });

  it("reuses a persisted successful approval decision across service restarts", async () => {
    const ledger = new InMemoryIdempotencyLedger();
    const firstApi = apiMock();
    vi.mocked(firstApi.request)
      .mockResolvedValueOnce({
        result: {
          processInstanceId: "pi-decision",
          status: "RUNNING",
          tasks: [{ taskId: "task-decision", userId: "user-1", status: "RUNNING" }],
        },
      })
      .mockResolvedValueOnce({ success: true });
    const options = {
      writeUserIds: ["user-1"],
      callerUserId: "user-1",
      idempotencyLedger: ledger,
    } as const;
    const input = {
      confirm: true,
      requestId: "88888888-8888-4888-8888-888888888888",
      processInstanceId: "pi-decision",
      taskId: "task-decision",
      result: "agree" as const,
    };

    await expect(new ApprovalService({ api: firstApi, ...options }).executeTask(input)).resolves.toEqual({
      success: true,
    });
    await expect(ledger.get(`approval-task:${input.requestId}`)).resolves.toMatchObject({ status: "succeeded" });

    const restartedApi = apiMock();
    await expect(new ApprovalService({ api: restartedApi, ...options }).executeTask(input)).resolves.toEqual({
      success: true,
    });
    expect(restartedApi.request).not.toHaveBeenCalled();
  });

  it("fails closed after an uncertain approval decision instead of submitting twice", async () => {
    const ledger = new InMemoryIdempotencyLedger();
    const api = apiMock();
    vi.mocked(api.request)
      .mockResolvedValueOnce({
        result: {
          processInstanceId: "pi-uncertain",
          status: "RUNNING",
          tasks: [{ taskId: "task-uncertain", userId: "user-1", status: "RUNNING" }],
        },
      })
      .mockRejectedValueOnce(new ApprovalMcpError("DINGTALK_API_ERROR", "timeout", { retryable: true }));
    const service = new ApprovalService({
      api,
      writeUserIds: ["user-1"],
      callerUserId: "user-1",
      idempotencyLedger: ledger,
    });
    const input = {
      confirm: true,
      requestId: "99999999-9999-4999-8999-999999999999",
      processInstanceId: "pi-uncertain",
      taskId: "task-uncertain",
      result: "agree" as const,
    };

    await expect(service.executeTask(input)).rejects.toMatchObject({ code: "IDEMPOTENCY_OUTCOME_UNKNOWN" });
    await expect(service.executeTask(input)).rejects.toMatchObject({ code: "IDEMPOTENCY_OUTCOME_UNKNOWN" });
    expect(api.request).toHaveBeenCalledTimes(2);
  });

  it("authorizes a form attachment with fileInfos before requesting its URL", async () => {
    const api = apiMock();
    vi.mocked(api.request)
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ result: { fileId: "file-1", downloadUri: "https://files.dingtalk.com/file-1" } });
    const service = new ApprovalService({ api, callerUserId: "user-1" });

    await expect(
      service.getAttachmentDownloadUrl("pi-1", "file-1", "space-1"),
    ).resolves.toEqual({ fileId: "file-1", downloadUri: "https://files.dingtalk.com/file-1" });
    expect(api.request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/v1.0/workflow/processInstances/spaces/files/authDownload",
      body: { userId: "user-1", fileInfos: [{ fileId: "file-1", spaceId: "space-1" }] },
    });
    expect(api.request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/v1.0/workflow/processInstances/spaces/files/urls/download",
      body: {
        processInstanceId: "pi-1",
        fileId: "file-1",
      },
    });
  });

  it("uses the official comment-attachment flag without the form-component authorization call", async () => {
    const api = apiMock();
    vi.mocked(api.request).mockResolvedValue({
      result: { fileId: "comment-1", downloadUri: "https://files.dingtalk.com/comment-1" },
    });
    const service = new ApprovalService({ api, callerUserId: "user-1" });

    await service.getAttachmentDownloadUrl("pi-1", "comment-1", undefined, { withCommentAttachment: true });

    expect(api.request).toHaveBeenCalledTimes(1);
    expect(api.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1.0/workflow/processInstances/spaces/files/urls/download",
      body: { processInstanceId: "pi-1", fileId: "comment-1", withCommentAttatchment: true },
    });
  });

  it("records an uncertain creation outcome distinctly with the upstream request id", async () => {
    const api = apiMock();
    const events: Array<Record<string, unknown>> = [];
    vi.mocked(api.request).mockRejectedValue(
      new ApprovalMcpError("DINGTALK_API_ERROR", "timeout", {
        retryable: true,
        details: { requestId: "upstream-request-1" },
      }),
    );
    const service = new ApprovalService({
      api,
      writeUserIds: ["user-1"],
      callerUserId: "user-1",
      audit: { record: (event) => void events.push(event as unknown as Record<string, unknown>) },
    });

    await expect(
      service.startProcessInstance({
        confirm: true,
        requestId: "d97b340a-09ee-4f4e-b2da-320d492ec446",
        processCode: "PROC-1",
        formComponentValues: [],
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_OUTCOME_UNKNOWN" });
    expect(events).toEqual([
      expect.objectContaining({
        action: "start",
        outcome: "uncertain",
        errorCode: "IDEMPOTENCY_OUTCOME_UNKNOWN",
      }),
    ]);
  });
});
