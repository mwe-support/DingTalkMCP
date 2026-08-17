import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DirectoryPendingApprovalIndex } from "../src/approval/pending-index.js";
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
    const index = new DirectoryPendingApprovalIndex(root, { now: () => 1_800_000_000_000 });

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
      taskId: "202",
      staffId: "user-1",
      type: "start" as const,
      eventTime: 1_800_000_000_000,
    };
    const first = new DirectoryPendingApprovalIndex(root, { now: () => 1_800_000_000_000 });
    await first.apply(event);
    await first.apply(event);

    const restarted = new DirectoryPendingApprovalIndex(root, { now: () => 1_800_000_001_000 });
    const page = await restarted.list({ userId: "user-1", page: 1, limit: 20 });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ processInstanceId: "pi-restart", taskId: "202" });
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

  it("acknowledges an event only after the pending index accepts it", async () => {
    let listener: ((message: Parameters<typeof parseTaskChangeEvent>[0]) => { status: string } | Promise<{ status: string }>) | undefined;
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
      index: { apply, list: vi.fn(), remove: vi.fn() },
      clientFactory: () => client,
    });

    const result = await listener?.({
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
        taskId: 505,
        staffId: "user-1",
        type: "start",
        EventTime: 1_800_000_000_000,
      }),
    });

    expect(result).toEqual({ status: "SUCCESS" });
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
  it("lists one verified pending task for the OAuth-bound approver", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-public-"));
    const index = new DirectoryPendingApprovalIndex(root, { now: () => 1_800_000_000_000 });
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
      pendingIndex: index,
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

  it("removes an event-index entry that no longer belongs to an active caller task", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-inbox-stale-"));
    const index = new DirectoryPendingApprovalIndex(root, { now: () => 1_800_000_000_000 });
    await index.apply({
      eventId: "event-stale-1",
      corpId: "corp-1",
      processInstanceId: "pi-stale-1",
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
      pendingIndex: index,
    });
    const server = createApprovalMcpServer(service);
    const client = new Client({ name: "approval-inbox-stale-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeables.push(client, server);

    const result = await client.callTool({ name: "approval_inbox", arguments: { limit: 20 } });

    expect(result.structuredContent).toMatchObject({
      result: { data: { items: [], staleRemoved: 1, verificationFailures: 0 } },
    });
    await expect(index.list({ userId: "user-1", page: 1, limit: 20 })).resolves.toMatchObject({ items: [] });
  });
});
