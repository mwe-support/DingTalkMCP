import { describe, expect, it, vi } from "vitest";

import { ApprovalService } from "../src/approval/service.js";
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
    vi.mocked(api.request).mockResolvedValue({ instanceId: "pi-created" });
    const service = new ApprovalService({ api, writeUserIds: ["user-1"] });

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
    const service = new ApprovalService({ api, writeUserIds: ["user-1"] });
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
    const service = new ApprovalService({ api, writeUserIds: [] });

    await expect(
      service.executeTask({
        confirm: true,
        processInstanceId: "pi-1",
        taskId: 456,
        actionerUserId: "user-1",
        result: "agree",
      }),
    ).rejects.toMatchObject({ code: "WRITE_ACTOR_NOT_ALLOWED" });
    expect(api.request).not.toHaveBeenCalled();
  });

  it("rechecks the current task and actor before approving", async () => {
    const api = apiMock();
    vi.mocked(api.request)
      .mockResolvedValueOnce({
        result: { processInstanceId: "pi-1", status: "RUNNING", tasks: [{ taskId: 456, userId: "user-1", status: "RUNNING" }] },
      })
      .mockResolvedValueOnce({ success: true });
    const service = new ApprovalService({ api, writeUserIds: ["user-1"] });

    await expect(
      service.executeTask({
        confirm: true,
        processInstanceId: "pi-1",
        taskId: 456,
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
    const service = new ApprovalService({ api, writeUserIds: ["user-1"] });

    await expect(
      service.executeTask({
        confirm: true,
        processInstanceId: "pi-1",
        taskId: 456,
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
    const service = new ApprovalService({ api, writeUserIds: ["user-1"] });

    await expect(
      service.revokeProcessInstance({
        confirm: true,
        processInstanceId: "pi-1",
        operatingUserId: "user-1",
        isSystem: false,
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
});
