import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AuditInvocationContext,
  BoundedApprovalAuditSink,
  DailyJsonLineAuditStore,
  RetainedToolInvocationAuditSink,
  startAuditRetentionSweep,
} from "../src/core/audit-log.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("DailyJsonLineAuditStore", () => {
  it("writes one structured JSON line without persisting tool input or secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-audit-structured-"));
    temporaryDirectories.push(root);
    const store = new DailyJsonLineAuditStore(root, {
      now: () => new Date("2026-08-14T08:00:00.000Z"),
    });
    const sink = new RetainedToolInvocationAuditSink(store);

    await sink.record({
      timestamp: "2026-08-14T08:00:00.000Z",
      invocationId: "86d57306-1337-41c6-a87f-4ae201331024",
      transport: "dingtalk_platform_http",
      toolName: "approval_task",
      action: "view",
      phase: "completed",
      outcome: "succeeded",
      httpStatus: 200,
      durationMs: 12,
    });

    const contents = await readFile(join(root, "2026-08-14.jsonl"), "utf8");
    expect(contents.trim().split("\n")).toEqual([
      JSON.stringify({
        schemaVersion: 1,
        type: "mcp_tool_invocation",
        timestamp: "2026-08-14T08:00:00.000Z",
        invocationId: "86d57306-1337-41c6-a87f-4ae201331024",
        transport: "dingtalk_platform_http",
        toolName: "approval_task",
        action: "view",
        phase: "completed",
        outcome: "succeeded",
        httpStatus: 200,
        durationMs: 12,
      }),
    ]);
    expect(contents).not.toContain("processInstanceId");
    expect(contents).not.toContain("authorization");
    expect(contents).not.toContain("downloadUrl");
  });

  it("retains at most 30 UTC calendar days and ignores unrelated files", async () => {
    const root = await mkdtemp(join(tmpdir(), "approval-audit-retention-"));
    temporaryDirectories.push(root);
    await mkdir(root, { recursive: true });
    await Promise.all([
      writeFile(join(root, "2026-07-15.jsonl"), "expired\n", "utf8"),
      writeFile(join(root, "2026-07-16.jsonl"), "boundary\n", "utf8"),
      writeFile(join(root, "README.txt"), "unrelated\n", "utf8"),
    ]);
    const store = new DailyJsonLineAuditStore(root, {
      now: () => new Date("2026-08-14T23:59:59.999Z"),
    });

    await store.prune();

    await expect(stat(join(root, "2026-07-15.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "2026-07-16.jsonl"), "utf8")).resolves.toBe("boundary\n");
    await expect(readFile(join(root, "README.txt"), "utf8")).resolves.toBe("unrelated\n");
  });

  it("rejects retention settings longer than the 30-day policy", () => {
    expect(
      () =>
        new DailyJsonLineAuditStore(join(process.cwd(), "tests", "audit-log-invalid"), {
          retentionDays: 31,
        }),
    ).toThrow("retentionDays must be an integer between 1 and 30");
  });

  it("increments a monotonic failure version when retained audit persistence fails", async () => {
    const parent = await mkdtemp(join(tmpdir(), "approval-audit-failure-"));
    temporaryDirectories.push(parent);
    const root = join(parent, "not-a-directory");
    await writeFile(root, "occupied", "utf8");
    const store = new DailyJsonLineAuditStore(root);
    const sink = new RetainedToolInvocationAuditSink(store);

    expect(store.failureVersion).toBe(0);
    await expect(
      sink.record({
        timestamp: "2026-08-14T08:00:00.000Z",
        invocationId: "86d57306-1337-41c6-a87f-4ae201331024",
        transport: "dingtalk_platform_http",
        toolName: "approval_task",
        phase: "started",
      }),
    ).rejects.toBeDefined();
    expect(store.failureVersion).toBe(1);
  });

  it("bounds a hanging approval mutation audit and marks shared persistence unhealthy", async () => {
    const invocationContext = new AuditInvocationContext();
    const invocationState = invocationContext.createState();
    const health = {
      failureVersion: 0,
      markFailure() {
        this.failureVersion += 1;
      },
    };
    const sink = new BoundedApprovalAuditSink(
      { record: () => new Promise<void>(() => undefined) },
      health,
      { invocationContext, timeoutMs: 10 },
    );

    await expect(
      invocationContext.run(invocationState, () =>
        sink.record({
          action: "approve",
          actorUserId: "user-redacted-from-tool-log",
          timestamp: "2026-08-14T08:00:00.000Z",
          outcome: "succeeded",
        }),
      ),
    ).rejects.toThrow("Structured audit write timed out");
    expect(health.failureVersion).toBe(1);
    expect(invocationState.approvalAuditFailed).toBe(true);
  });

  it("runs retention at startup and periodically even when no tool is called", async () => {
    vi.useFakeTimers();
    const prune = vi.fn().mockResolvedValue(undefined);

    const sweep = await startAuditRetentionSweep({ prune }, { intervalMs: 60_000 });
    expect(prune).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(prune).toHaveBeenCalledTimes(2);

    sweep.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(prune).toHaveBeenCalledTimes(2);
  });
});
