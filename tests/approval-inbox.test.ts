import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DirectoryApprovalInboxIndex } from "../src/approval/pending-index.js";
import { ApprovalService } from "../src/approval/service.js";
import type { DingTalkApiClient } from "../src/dingtalk/client.js";
import { createApprovalMcpServer } from "../src/mcp/create-server.js";
import {
  parseTaskChangeEvent,
  startDingTalkApprovalEventStream,
  type DingTalkEventClient,
} from "../src/dingtalk/event-stream.js";

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(closeables.splice(0).map((item) => item.close()));
});

describe("pending approval event index", () => {
  it("adds a started task and removes the same task after completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-"));
    const index = new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 });

    await index.apply({
      eventId: "event-start-1",
      corpId: "corp-1",
      processInstanceId: "pi-1",
      processCode: "PROC-1",
      taskId: "101",
      staffId: "user-1",
      title: "Expense approval",
      type: "start",
      eventTime: 1_799_999_999_000,
      createTime: 1_799_999_998_000,
    });

    await expect(index.list({ userId: "user-1", page: 1, limit: 20 })).resolves.toMatchObject({
      coverage: "partial",
      resyncRequired: true,
      items: [
        {
          processInstanceId: "pi-1",
          processCode: "PROC-1",
          taskId: "101",
          title: "Expense approval",
        },
      ],
    });

    await index.apply({
      eventId: "event-finish-1",
      corpId: "corp-1",
      processInstanceId: "pi-1",
      processCode: "PROC-1",
      taskId: "101",
      staffId: "user-1",
      type: "finish",
      result: "agree",
      eventTime: 1_800_000_000_000,
    });

    await expect(index.list({ userId: "user-1", page: 1, limit: 20 })).resolves.toMatchObject({
      items: [],
      hasMore: false,
    });
  });

  it("persists tasks across restarts and applies a repeated event only once", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-restart-"));
    const event = {
      eventId: "event-start-restart",
      corpId: "corp-1",
      processInstanceId: "pi-restart",
      processCode: "PROC-RESTART",
      taskId: "202",
      staffId: "user-1",
      type: "start" as const,
      eventTime: 1_800_000_000_000,
    };
    const first = new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 });
    await first.apply(event);
    await first.apply(event);

    const restarted = new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_001_000 });
    const page = await restarted.list({ userId: "user-1", page: 1, limit: 20 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ processInstanceId: "pi-restart", taskId: "202" });
  });

  it("reconciles an instance-only start with a task-specific terminal event", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-mixed-task-id-"));
    const index = new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 });
    await index.apply({
      eventId: "event-instance-only-start",
      corpId: "corp-1",
      processInstanceId: "pi-mixed-1",
      processCode: "PROC-MIXED",
      staffId: "user-1",
      type: "start",
      eventTime: 1_799_999_999_000,
    });
    await index.apply({
      eventId: "event-task-specific-finish",
      corpId: "corp-1",
      processInstanceId: "pi-mixed-1",
      processCode: "PROC-MIXED",
      taskId: "909",
      staffId: "user-1",
      type: "finish",
      result: "agree",
      eventTime: 1_800_000_000_000,
    });

    await expect(index.list({ userId: "user-1", page: 1, limit: 20 })).resolves.toMatchObject({ items: [] });
  });

  it("reconciles an instance-only completion with a later task-specific completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-completed-mixed-task-id-"));
    const index = new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 });
    await index.apply({
      eventId: "event-instance-only-finish",
      corpId: "corp-1",
      processInstanceId: "pi-completed-mixed",
      processCode: "PROC-MIXED",
      staffId: "user-1",
      type: "finish",
      result: "agree",
      eventTime: 1_799_999_999_000,
    });
    await index.apply({
      eventId: "event-task-specific-refresh-finish",
      corpId: "corp-1",
      processInstanceId: "pi-completed-mixed",
      processCode: "PROC-MIXED",
      taskId: "910",
      staffId: "user-1",
      type: "finish",
      result: "agree",
      eventTime: 1_800_000_000_000,
    });

    await expect(index.list({
      userId: "user-1",
      page: 1,
      limit: 20,
      recordStatus: "completed",
    })).resolves.toMatchObject({
      items: [{ processInstanceId: "pi-completed-mixed", taskId: "910" }],
      hasMore: false,
    });
  });

  it("migrates the existing v1 pending index without losing pending tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-v1-migration-"));
    await writeFile(join(root, "pending-approval-index.json"), JSON.stringify({
      schemaVersion: 1,
      activatedAt: 1_799_999_000_000,
      lastEventAt: 1_799_999_999_000,
      items: {
        legacy: {
          processInstanceId: "pi-legacy",
          processCode: "PROC-LEGACY",
          taskId: "legacy-task",
          userId: "user-1",
          createdAt: 1_799_999_998_000,
          updatedAt: 1_799_999_999_000,
        },
      },
      seenEvents: { "legacy-event": 1_799_999_999_000 },
    }), "utf8");

    const index = new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 });

    await expect(index.list({ userId: "user-1", page: 1, limit: 20 })).resolves.toMatchObject({
      recordStatus: "pending",
      items: [{
        processInstanceId: "pi-legacy",
        taskId: "legacy-task",
        recordStatus: "pending",
      }],
    });
    await expect(index.list({
      userId: "user-1",
      page: 1,
      limit: 20,
      recordStatus: "completed",
    })).resolves.toMatchObject({
      coverageSince: 1_800_000_000_000,
      recordStatus: "completed",
      items: [],
    });
  });

  it("does not classify a cancelled task as a completed approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-cancelled-"));
    const index = new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 });
    await index.apply({
      eventId: "event-cancel-start",
      corpId: "corp-1",
      processInstanceId: "pi-cancelled",
      processCode: "PROC-CANCELLED",
      taskId: "cancel-task",
      staffId: "user-1",
      type: "start",
      eventTime: 1_799_999_999_000,
    });
    await index.apply({
      eventId: "event-cancel-end",
      corpId: "corp-1",
      processInstanceId: "pi-cancelled",
      processCode: "PROC-CANCELLED",
      taskId: "cancel-task",
      staffId: "user-1",
      type: "cancel",
      eventTime: 1_800_000_000_000,
    });

    await expect(index.list({ userId: "user-1", page: 1, limit: 20 })).resolves.toMatchObject({ items: [] });
    await expect(index.list({
      userId: "user-1",
      page: 1,
      limit: 20,
      recordStatus: "completed",
    })).resolves.toMatchObject({ items: [] });
  });

  it("removes a completed record when a later event cancels the same task", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-finish-cancel-"));
    const index = new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 });
    const shared = {
      corpId: "corp-1",
      processInstanceId: "pi-finish-cancel",
      processCode: "PROC-FINISH-CANCEL",
      taskId: "finish-cancel-task",
      staffId: "user-1",
    };
    await index.apply({
      ...shared,
      eventId: "event-finish-cancel-start",
      type: "start",
      eventTime: 1_799_999_998_000,
    });
    await index.apply({
      ...shared,
      eventId: "event-finish-cancel-finish",
      type: "finish",
      result: "agree",
      eventTime: 1_799_999_999_000,
    });
    await index.apply({
      ...shared,
      eventId: "event-finish-cancel-cancel",
      type: "cancel",
      eventTime: 1_800_000_000_000,
    });

    await expect(index.list({
      userId: "user-1",
      page: 1,
      limit: 20,
      recordStatus: "completed",
    })).resolves.toMatchObject({ items: [] });
  });

  it("retains completed approval records for at most 30 days", async () => {
    const now = 1_800_000_000_000;
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-completed-retention-"));
    const index = new DirectoryApprovalInboxIndex(root, { now: () => now });
    await index.apply({
      eventId: "event-completed-expired",
      corpId: "corp-1",
      processInstanceId: "pi-completed-expired",
      processCode: "PROC-EXPIRED",
      taskId: "expired-task",
      staffId: "user-1",
      type: "finish",
      result: "agree",
      eventTime: now - 31 * 24 * 60 * 60 * 1000,
    });

    await expect(index.list({
      userId: "user-1",
      page: 1,
      limit: 20,
      recordStatus: "completed",
    })).resolves.toMatchObject({
      coverageSince: now,
      items: [],
    });
  });

  it("declares capacity truncation and advances completed coverage", async () => {
    const now = 1_800_000_000_000;
    const firstItemAt = now - 10_000;
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-completed-capacity-"));
    const completedItems = Object.fromEntries(Array.from({ length: 5_001 }, (_, index) => [
      `completed-${index}`,
      {
        processInstanceId: `pi-capacity-${index}`,
        processCode: "PROC-CAPACITY",
        taskId: `task-capacity-${index}`,
        userId: "user-1",
        createdAt: firstItemAt + index,
        updatedAt: firstItemAt + index,
        recordStatus: "completed",
        decisionResult: "agree",
        completedAt: firstItemAt + index,
      },
    ]));
    await writeFile(join(root, "pending-approval-index.json"), JSON.stringify({
      schemaVersion: 2,
      activatedAt: now - 100_000,
      completedActivatedAt: now - 100_000,
      pendingItems: {},
      completedItems,
      seenEvents: {},
    }), "utf8");
    const index = new DirectoryApprovalInboxIndex(root, { now: () => now });

    await expect(index.list({
      userId: "user-1",
      page: 1,
      limit: 1,
      recordStatus: "completed",
    })).resolves.toMatchObject({
      coverageSince: firstItemAt + 1,
      capacityTruncated: true,
      recordStatus: "completed",
    });
  });
});

describe("DingTalk task-change event adapter", () => {
  it("parses the official Stream event envelope without accepting a caller identity input", () => {
    expect(parseTaskChangeEvent({
      specVersion: "1.0",
      type: "EVENT",
      headers: {
        appId: "app-1",
        connectionId: "connection-1",
        contentType: "application/json",
        messageId: "message-1",
        time: "1800000000000",
        topic: "/v1.0/event/bpms_task_change/processCode/PROC-1/type/start",
        eventType: "bpms_task_change",
        eventId: "event-stream-1",
        eventCorpId: "corp-1",
      },
      data: JSON.stringify({
        EventType: "bpms_task_change",
        EventTime: 1_800_000_000_000,
        CorpId: "corp-1",
        processInstanceId: "pi-stream-1",
        processCode: "PROC-1",
        taskId: 404,
        staffId: "user-1",
        title: "Approval title",
        type: "start",
        createTime: 1_799_999_999_000,
      }),
    }, "corp-1")).toEqual({
      eventId: "event-stream-1",
      corpId: "corp-1",
      processInstanceId: "pi-stream-1",
      processCode: "PROC-1",
      taskId: "404",
      staffId: "user-1",
      title: "Approval title",
      type: "start",
      eventTime: 1_800_000_000_000,
      createTime: 1_799_999_999_000,
    });
  });

  it("retains an instance-only event when DingTalk omits taskId", () => {
    const event = parseTaskChangeEvent({
      specVersion: "1.0",
      type: "EVENT",
      headers: {
        appId: "app-1",
        connectionId: "connection-1",
        contentType: "application/json",
        messageId: "message-without-task",
        time: "1800000000000",
        topic: "bpms_task_change",
        eventType: "bpms_task_change",
        eventCorpId: "corp-1",
      },
      data: JSON.stringify({
        EventType: "bpms_task_change",
        CorpId: "corp-1",
        processInstanceId: "pi-without-task",
        processCode: "PROC-WITHOUT-TASK",
        staffId: "user-1",
        type: "start",
        EventTime: 1_800_000_000_000,
      }),
    }, "corp-1");

    expect(event).toMatchObject({
      processInstanceId: "pi-without-task",
      processCode: "PROC-WITHOUT-TASK",
      staffId: "user-1",
    });
    expect(event).not.toHaveProperty("taskId");
  });

  it("parses the handled result from a task-finish event", () => {
    expect(parseTaskChangeEvent({
      specVersion: "1.0",
      type: "EVENT",
      headers: {
        appId: "app-1",
        connectionId: "connection-1",
        contentType: "application/json",
        messageId: "message-finish-1",
        time: "1800000000000",
        topic: "/v1.0/event/bpms_task_change/processCode/PROC-1/type/finish",
        eventType: "bpms_task_change",
        eventCorpId: "corp-1",
      },
      data: JSON.stringify({
        EventType: "bpms_task_change",
        EventTime: 1_800_000_000_000,
        CorpId: "corp-1",
        processInstanceId: "pi-finish-1",
        processCode: "PROC-1",
        taskId: 405,
        staffId: "user-1",
        type: "finish",
        result: "agree",
      }),
    }, "corp-1")).toMatchObject({
      processInstanceId: "pi-finish-1",
      taskId: "405",
      staffId: "user-1",
      type: "finish",
      result: "agree",
    });
  });

  it("acknowledges an event only after the pending index accepts it", async () => {
    let listener: ((message: Parameters<typeof parseTaskChangeEvent>[0]) => { status: string }) | undefined;
    const client: DingTalkEventClient = {
      registerAllEventListener: (value) => {
        listener = value;
        return client;
      },
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    const apply = vi.fn().mockResolvedValue(undefined);
    const running = await startDingTalkApprovalEventStream({
      clientId: "client-1",
      clientSecret: "secret-1",
      corpId: "corp-1",
      index: { apply, list: vi.fn() },
      clientFactory: () => client,
    });

    const message = {
      specVersion: "1.0",
      type: "EVENT",
      headers: {
        appId: "app-1",
        connectionId: "connection-1",
        contentType: "application/json",
        messageId: "message-2",
        time: "1800000000000",
        topic: "bpms_task_change",
        eventType: "bpms_task_change",
        eventCorpId: "corp-1",
      },
      data: JSON.stringify({
        EventType: "bpms_task_change",
        CorpId: "corp-1",
        processInstanceId: "pi-stream-2",
        processCode: "PROC-2",
        taskId: 505,
        staffId: "user-1",
        type: "start",
        EventTime: 1_800_000_000_000,
      }),
    };

    const firstResult = listener?.(message);

    expect(firstResult).toEqual({ status: "LATER" });
    expect(firstResult).not.toBeInstanceOf(Promise);
    await vi.waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(listener?.(message)).toEqual({ status: "SUCCESS" });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      processInstanceId: "pi-stream-2",
      taskId: "505",
      staffId: "user-1",
    }));
    expect(client.connect).toHaveBeenCalledTimes(1);
    running.close();
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });
});

describe("approval_inbox public MCP contract", () => {
  it("refreshes completed records from the official instance ID list API", async () => {
    const now = 1_800_000_000_000;
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-openapi-refresh-"));
    const request = vi.fn().mockImplementation((input: {
      method: string;
      path: string;
      body?: Record<string, unknown>;
      query?: Record<string, unknown>;
    }) => {
      if (input.path === "/v1.0/workflow/processes/instanceIds/query") {
        expect(input).toEqual({
          method: "POST",
          path: "/v1.0/workflow/processes/instanceIds/query",
          body: {
            processCode: "PROC-REFRESH",
            startTime: now - 7 * 24 * 60 * 60 * 1000,
            endTime: now,
            nextToken: 0,
            maxResults: 20,
            statuses: ["RUNNING", "COMPLETED"],
          },
        });
        return Promise.resolve({ result: { list: ["pi-refresh-completed"], nextToken: 0 }, success: true });
      }
      expect(input).toEqual({
        method: "GET",
        path: "/v1.0/workflow/processInstances",
        query: { processInstanceId: "pi-refresh-completed" },
      });
      return Promise.resolve({
        result: {
          processInstanceId: "pi-refresh-completed",
          processCode: "PROC-REFRESH",
          title: "Refreshed completed approval",
          status: "RUNNING",
          createTime: now - 10_000,
          tasks: [{
            taskId: "refresh-task",
            userId: "user-1",
            status: "COMPLETED",
            result: "AGREE",
            finishTime: now - 1_000,
          }],
        },
      });
    });
    const service = new ApprovalService({
      api: { request } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
      callerScopes: ["approval:read"],
      inboxIndex: new DirectoryApprovalInboxIndex(root, { now: () => now }),
      inboxProcessCodes: ["PROC-REFRESH"],
      corpId: "corp-1",
      now: () => now,
    });
    const server = createApprovalMcpServer(service);
    const client = new Client({ name: "approval-inbox-openapi-refresh-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({
      name: "approval_inbox",
      arguments: { recordStatus: "completed", refreshWindowDays: 7 },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        data: {
          recordStatus: "completed",
          refresh: {
            windowDays: 7,
            windowStart: now - 7 * 24 * 60 * 60 * 1000,
            windowEnd: now,
            processCodeCount: 1,
            candidateLimit: 40,
            candidateInstanceCount: 1,
            indexedRecordCount: 1,
            truncated: false,
            failures: 0,
          },
          items: [{
            processInstanceId: "pi-refresh-completed",
            taskId: "refresh-task",
            decisionResult: "agree",
            completedAt: now - 1_000,
          }],
        },
      },
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("refreshes only the OAuth user's pending tasks from scanned instances", async () => {
    const now = 1_800_000_000_000;
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-openapi-pending-refresh-"));
    const request = vi.fn().mockImplementation((input: {
      path: string;
      body?: Record<string, unknown>;
      query?: { processInstanceId?: string };
    }) => {
      if (input.path === "/v1.0/workflow/processes/instanceIds/query") {
        expect(input.body).toMatchObject({ statuses: ["RUNNING"], maxResults: 20 });
        return Promise.resolve({
          result: { list: ["pi-pending-mine", "pi-pending-other"], nextToken: 0 },
          success: true,
        });
      }
      const mine = input.query?.processInstanceId === "pi-pending-mine";
      return Promise.resolve({
        result: {
          processInstanceId: input.query?.processInstanceId,
          processCode: "PROC-REFRESH",
          status: "RUNNING",
          createTime: now - 2_000,
          tasks: [{
            taskId: mine ? "pending-mine-task" : "pending-other-task",
            userId: mine ? "user-1" : "user-2",
            status: "RUNNING",
          }],
        },
      });
    });
    const service = new ApprovalService({
      api: { request } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
      callerScopes: ["approval:read"],
      inboxIndex: new DirectoryApprovalInboxIndex(root, { now: () => now }),
      inboxProcessCodes: ["PROC-REFRESH"],
      corpId: "corp-1",
      now: () => now,
    });
    const server = createApprovalMcpServer(service);
    const client = new Client({ name: "approval-inbox-openapi-pending-refresh-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({
      name: "approval_inbox",
      arguments: { recordStatus: "pending", refreshWindowDays: 1 },
    });

    expect(result.structuredContent).toMatchObject({
      result: {
        data: {
          refresh: {
            candidateInstanceCount: 2,
            indexedRecordCount: 1,
            filteredCandidateCount: 1,
            failures: 0,
          },
          items: [{
            processInstanceId: "pi-pending-mine",
            taskId: "pending-mine-task",
            recordStatus: "pending",
          }],
        },
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain("pi-pending-other");
    expect(request).toHaveBeenCalledTimes(4);
  });

  it("stops an instance-ID refresh after five pages per process", async () => {
    const now = 1_800_000_000_000;
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-refresh-page-bound-"));
    let queryCalls = 0;
    const request = vi.fn().mockImplementation((input: {
      path: string;
      query?: { processInstanceId?: string };
    }) => {
      if (input.path === "/v1.0/workflow/processes/instanceIds/query") {
        queryCalls++;
        return Promise.resolve({
          result: { list: ["pi-page-bound"], nextToken: queryCalls },
          success: true,
        });
      }
      return Promise.resolve({
        result: {
          processInstanceId: input.query?.processInstanceId,
          processCode: "PROC-REFRESH",
          status: "COMPLETED",
          tasks: [{ taskId: "page-bound-task", userId: "user-1", status: "COMPLETED", result: "AGREE" }],
        },
      });
    });
    const service = new ApprovalService({
      api: { request } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
      callerScopes: ["approval:read"],
      inboxIndex: new DirectoryApprovalInboxIndex(root, { now: () => now }),
      inboxProcessCodes: ["PROC-REFRESH"],
      corpId: "corp-1",
      now: () => now,
    });
    const server = createApprovalMcpServer(service);
    const client = new Client({ name: "approval-inbox-refresh-page-bound-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({
      name: "approval_inbox",
      arguments: { recordStatus: "completed", refreshWindowDays: 1 },
    });

    expect(result.structuredContent).toMatchObject({
      result: {
        data: {
          coverage: "partial",
          resyncRequired: true,
          refresh: { queryPages: 5, candidateInstanceCount: 1, truncated: true },
          items: [{ processInstanceId: "pi-page-bound" }],
        },
      },
    });
    expect(queryCalls).toBe(5);
    expect(request).toHaveBeenCalledTimes(7);
  });

  it("stops an instance-ID refresh at forty candidates", async () => {
    const now = 1_800_000_000_000;
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-refresh-candidate-bound-"));
    const candidateIds = Array.from({ length: 41 }, (_, index) => `pi-candidate-${index}`);
    let queryCalls = 0;
    let detailCalls = 0;
    const request = vi.fn().mockImplementation((input: {
      path: string;
      query?: { processInstanceId?: string };
    }) => {
      if (input.path === "/v1.0/workflow/processes/instanceIds/query") {
        queryCalls++;
        return Promise.resolve({ result: { list: candidateIds, nextToken: 1 }, success: true });
      }
      detailCalls++;
      const processInstanceId = input.query?.processInstanceId ?? "missing";
      return Promise.resolve({
        result: {
          processInstanceId,
          processCode: "PROC-REFRESH",
          status: "COMPLETED",
          createTime: now - 1_000,
          tasks: [{
            taskId: `task-${processInstanceId}`,
            userId: "user-1",
            status: "COMPLETED",
            result: "AGREE",
            finishTime: now - 500,
          }],
        },
      });
    });
    const service = new ApprovalService({
      api: { request } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
      callerScopes: ["approval:read"],
      inboxIndex: new DirectoryApprovalInboxIndex(root, { now: () => now }),
      inboxProcessCodes: ["PROC-REFRESH"],
      corpId: "corp-1",
      now: () => now,
    });
    const server = createApprovalMcpServer(service);
    const client = new Client({ name: "approval-inbox-refresh-candidate-bound-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({
      name: "approval_inbox",
      arguments: { recordStatus: "completed", refreshWindowDays: 1, limit: 20 },
    });
    const structured = result.structuredContent as {
      result?: { data?: { items?: unknown[]; refresh?: Record<string, unknown>; hasMore?: boolean } };
    };

    expect(structured.result?.data).toMatchObject({
      refresh: {
        candidateLimit: 40,
        candidateInstanceCount: 40,
        indexedRecordCount: 40,
        truncated: true,
      },
      hasMore: true,
    });
    expect(structured.result?.data?.items).toHaveLength(20);
    expect(queryCalls).toBe(1);
    expect(detailCalls).toBe(60);
    expect(request).toHaveBeenCalledTimes(61);
  });

  it("lists a verified completed task through the same inbox tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-completed-public-"));
    const index = new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 });
    await index.apply({
      eventId: "event-completed-start",
      corpId: "corp-1",
      processInstanceId: "pi-completed-public",
      processCode: "PROC-COMPLETED",
      taskId: "304",
      staffId: "user-1",
      title: "Completed expense approval",
      type: "start",
      eventTime: 1_799_999_999_000,
      createTime: 1_799_999_998_000,
    });
    await index.apply({
      eventId: "event-completed-finish",
      corpId: "corp-1",
      processInstanceId: "pi-completed-public",
      processCode: "PROC-COMPLETED",
      taskId: "304",
      staffId: "user-1",
      type: "finish",
      result: "agree",
      eventTime: 1_800_000_000_000,
    });
    const request = vi.fn().mockResolvedValue({
      result: {
        processInstanceId: "pi-completed-public",
        processCode: "PROC-COMPLETED",
        status: "COMPLETED",
        tasks: [{ taskId: "304", userId: "user-1", status: "COMPLETED" }],
      },
    });
    const service = new ApprovalService({
      api: { request } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
      callerScopes: ["approval:read"],
      inboxIndex: new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 }),
    });
    const server = createApprovalMcpServer(service);
    const client = new Client({ name: "approval-inbox-completed-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({
      name: "approval_inbox",
      arguments: { recordStatus: "completed", page: 1, limit: 20 },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        inboxId: "current_user_completed",
        action: "list_completed",
        currentStatus: "PARTIAL",
        safeNextActions: ["view"],
        data: {
          coverage: "partial",
          resyncRequired: true,
          recordStatus: "completed",
          items: [
            {
              processInstanceId: "pi-completed-public",
              taskId: "304",
              processCode: "PROC-COMPLETED",
              currentStatus: "COMPLETED",
              taskStatus: "COMPLETED",
              decisionResult: "agree",
              completedAt: 1_800_000_000_000,
            },
          ],
        },
      },
    });
  });

  it("lists one verified pending task for the OAuth-bound approver", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-public-"));
    const index = new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 });
    await index.apply({
      eventId: "event-public-1",
      corpId: "corp-1",
      processInstanceId: "pi-public-1",
      processCode: "PROC-PUBLIC",
      taskId: "303",
      staffId: "user-1",
      title: "Pending approval",
      type: "start",
      eventTime: 1_800_000_000_000,
    });
    const request = vi.fn().mockResolvedValue({
      result: {
        processInstanceId: "pi-public-1",
        status: "RUNNING",
        tasks: [{ taskId: "303", userId: "user-1", status: "RUNNING" }],
      },
    });
    const service = new ApprovalService({
      api: { request } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
      callerScopes: ["approval:read"],
      inboxIndex: index,
    });
    const server = createApprovalMcpServer(service);
    const client = new Client({ name: "approval-inbox-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "approval_inbox",
      "approval_task",
      "approval_request",
    ]);
    expect(tools.tools[0]?.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });

    const result = await client.callTool({ name: "approval_inbox", arguments: { page: 1, limit: 1 } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      result: {
        action: "list_pending",
        currentStatus: "PARTIAL",
        safeNextActions: ["view"],
        data: {
          coverage: "partial",
          resyncRequired: true,
          items: [
            {
              processInstanceId: "pi-public-1",
              taskId: "303",
              processCode: "PROC-PUBLIC",
              currentStatus: "RUNNING",
            },
          ],
        },
      },
    });
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1.0/workflow/processInstances",
      query: { processInstanceId: "pi-public-1" },
    });
  });

  it("does not return a completed candidate whose current task is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-completed-cancelled-detail-"));
    const index = new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 });
    await index.apply({
      eventId: "event-cancelled-detail-finish",
      corpId: "corp-1",
      processInstanceId: "pi-cancelled-detail",
      processCode: "PROC-CANCELLED-DETAIL",
      taskId: "cancelled-detail-task",
      staffId: "user-1",
      type: "finish",
      result: "agree",
      eventTime: 1_800_000_000_000,
    });
    const service = new ApprovalService({
      api: {
        request: vi.fn().mockResolvedValue({
          result: {
            processInstanceId: "pi-cancelled-detail",
            status: "TERMINATED",
            tasks: [{ taskId: "cancelled-detail-task", userId: "user-1", status: "CANCELED" }],
          },
        }),
      } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
      callerScopes: ["approval:read"],
      inboxIndex: index,
    });
    const server = createApprovalMcpServer(service);
    const client = new Client({ name: "approval-inbox-cancelled-detail-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({
      name: "approval_inbox",
      arguments: { recordStatus: "completed" },
    });

    expect(result.structuredContent).toMatchObject({
      result: { data: { items: [], staleDetected: 1 } },
    });
  });

  it("rejects attempts to select another DingTalk user", async () => {
    const request = vi.fn();
    const service = new ApprovalService({
      api: { request } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
      callerScopes: ["approval:read"],
    });
    const server = createApprovalMcpServer(service);
    const client = new Client({ name: "approval-inbox-identity-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({
      name: "approval_inbox",
      arguments: { page: 1, limit: 20, userId: "user-2" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "INVALID_INPUT" },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("filters a stale entry without shifting the offset-based event page", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-stale-"));
    const index = new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 });
    await index.apply({
      eventId: "event-stale-1",
      corpId: "corp-1",
      processInstanceId: "pi-stale-1",
      processCode: "PROC-STALE",
      taskId: "606",
      staffId: "user-1",
      type: "start",
      eventTime: 1_800_000_000_000,
    });
    const request = vi.fn().mockResolvedValue({
      result: {
        processInstanceId: "pi-stale-1",
        status: "COMPLETED",
        tasks: [{ taskId: "606", userId: "user-1", status: "COMPLETED" }],
      },
    });
    const service = new ApprovalService({
      api: { request } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
      callerScopes: ["approval:read"],
      inboxIndex: index,
    });
    const server = createApprovalMcpServer(service);
    const client = new Client({ name: "approval-inbox-stale-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({ name: "approval_inbox", arguments: { limit: 20 } });

    expect(result.structuredContent).toMatchObject({
      result: { data: { items: [], staleDetected: 1, verificationFailures: 0 } },
    });
    await expect(index.list({ userId: "user-1", page: 1, limit: 20 })).resolves.toMatchObject({
      items: [{ processInstanceId: "pi-stale-1", taskId: "606" }],
    });
  });

  it("does not skip a valid second page after the first candidate is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-stable-page-"));
    const index = new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 });
    await index.apply({
      eventId: "event-valid-second",
      corpId: "corp-1",
      processInstanceId: "pi-valid-second",
      processCode: "PROC-PAGE",
      taskId: "802",
      staffId: "user-1",
      type: "start",
      eventTime: 1_799_999_999_000,
      createTime: 1_799_999_999_000,
    });
    await index.apply({
      eventId: "event-stale-first",
      corpId: "corp-1",
      processInstanceId: "pi-stale-first",
      processCode: "PROC-PAGE",
      taskId: "801",
      staffId: "user-1",
      type: "start",
      eventTime: 1_800_000_000_000,
      createTime: 1_800_000_000_000,
    });
    const request = vi.fn().mockImplementation(({ query }: { query: { processInstanceId: string } }) =>
      Promise.resolve(query.processInstanceId === "pi-stale-first"
        ? {
            result: {
              processInstanceId: "pi-stale-first",
              status: "COMPLETED",
              tasks: [{ taskId: "801", userId: "user-1", status: "COMPLETED" }],
            },
          }
        : {
            result: {
              processInstanceId: "pi-valid-second",
              processCode: "PROC-PAGE",
              status: "RUNNING",
              tasks: [{ taskId: "802", userId: "user-1", status: "RUNNING" }],
            },
          }));
    const service = new ApprovalService({
      api: { request } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
      callerScopes: ["approval:read"],
      inboxIndex: index,
    });
    const server = createApprovalMcpServer(service);
    const client = new Client({ name: "approval-inbox-stable-page-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const first = await client.callTool({ name: "approval_inbox", arguments: { page: 1, limit: 1 } });
    const second = await client.callTool({ name: "approval_inbox", arguments: { page: 2, limit: 1 } });

    expect(first.structuredContent).toMatchObject({
      result: { data: { items: [], staleDetected: 1, hasMore: true } },
    });
    expect(second.structuredContent).toMatchObject({
      result: { data: { items: [{ processInstanceId: "pi-valid-second", taskId: "802" }] } },
    });
  });

  it("returns an instance-only item when the source event had no taskId", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-no-task-"));
    const index = new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 });
    await index.apply({
      eventId: "event-no-task-1",
      corpId: "corp-1",
      processInstanceId: "pi-no-task-1",
      processCode: "PROC-NO-TASK",
      staffId: "user-1",
      type: "start",
      eventTime: 1_800_000_000_000,
    });
    const request = vi.fn().mockResolvedValue({
      result: {
        processInstanceId: "pi-no-task-1",
        processCode: "PROC-NO-TASK",
        status: "RUNNING",
        tasks: [{ taskId: "707", userId: "user-1", status: "RUNNING" }],
      },
    });
    const service = new ApprovalService({
      api: { request } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
      callerScopes: ["approval:read"],
      inboxIndex: index,
    });
    const server = createApprovalMcpServer(service);
    const client = new Client({ name: "approval-inbox-no-task-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({ name: "approval_inbox", arguments: { limit: 1 } });
    const structured = result.structuredContent as {
      result?: { data?: { items?: Array<Record<string, unknown>> } };
    };
    expect(structured.result?.data?.items).toEqual([
      expect.objectContaining({
        processInstanceId: "pi-no-task-1",
        processCode: "PROC-NO-TASK",
        taskIdUnavailable: true,
      }),
    ]);
    expect(structured.result?.data?.items?.[0]).not.toHaveProperty("taskId");
  });

  it("records list_pending as the bounded audit action", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-audit-"));
    const events: Array<Record<string, unknown>> = [];
    const service = new ApprovalService({
      api: { request: vi.fn() } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
      callerScopes: ["approval:read"],
      inboxIndex: new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 }),
    });
    const server = createApprovalMcpServer(service, {
      toolAudit: { record: (event) => void events.push(event as unknown as Record<string, unknown>) },
    });
    const client = new Client({ name: "approval-inbox-audit-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    await client.callTool({ name: "approval_inbox", arguments: {} });

    expect(events).toEqual([
      expect.objectContaining({ phase: "started", toolName: "approval_inbox", action: "list_pending" }),
      expect.objectContaining({ phase: "completed", toolName: "approval_inbox", action: "list_pending" }),
    ]);
  });

  it("records list_completed as the bounded audit action", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-completed-audit-"));
    const events: Array<Record<string, unknown>> = [];
    const service = new ApprovalService({
      api: { request: vi.fn() } as unknown as Pick<DingTalkApiClient, "request">,
      callerUserId: "user-1",
      callerScopes: ["approval:read"],
      inboxIndex: new DirectoryApprovalInboxIndex(root, { now: () => 1_800_000_000_000 }),
    });
    const server = createApprovalMcpServer(service, {
      toolAudit: { record: (event) => void events.push(event as unknown as Record<string, unknown>) },
    });
    const client = new Client({ name: "approval-inbox-completed-audit-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    await client.callTool({ name: "approval_inbox", arguments: { recordStatus: "completed" } });

    expect(events).toEqual([
      expect.objectContaining({ phase: "started", toolName: "approval_inbox", action: "list_completed" }),
      expect.objectContaining({ phase: "completed", toolName: "approval_inbox", action: "list_completed" }),
    ]);
  });
});
