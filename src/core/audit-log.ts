import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

import type { ApprovalAuditEvent, ApprovalAuditSink } from "./audit.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_AUDIT_RETENTION_DAYS = 30;
export const DEFAULT_AUDIT_WRITE_TIMEOUT_MS = 2_000;

export type ToolInvocationAuditOutcome = "succeeded" | "rejected" | "failed" | "uncertain" | "unknown_tool";

export interface ToolInvocationAuditEventBase {
  timestamp: string;
  invocationId: string;
  transport: "streamable_http";
  toolName: string;
  subjectHash?: string;
  action?: "view" | "approve" | "reject";
}

export type ToolInvocationAuditEvent = ToolInvocationAuditEventBase &
  (
    | { phase: "started" }
    | {
        phase: "completed";
        outcome: ToolInvocationAuditOutcome;
        httpStatus: number;
        durationMs: number;
        auditStatus?: "complete" | "partial";
        errorCode?: string;
      }
  );

export interface ToolInvocationAuditSink {
  record(event: ToolInvocationAuditEvent): void | Promise<void>;
}

export interface AuditPersistenceHealth {
  readonly failureVersion: number;
}

export interface AuditPersistenceMonitor extends AuditPersistenceHealth {
  markFailure(): void;
}

export interface AuditInvocationState {
  approvalAuditFailed: boolean;
}

export class AuditInvocationContext {
  readonly #storage = new AsyncLocalStorage<AuditInvocationState>();

  createState(): AuditInvocationState {
    return { approvalAuditFailed: false };
  }

  run<T>(state: AuditInvocationState, operation: () => Promise<T>): Promise<T> {
    return this.#storage.run(state, operation);
  }

  markApprovalAuditFailure(): void {
    const state = this.#storage.getStore();
    if (state !== undefined) state.approvalAuditFailed = true;
  }
}

export interface DailyJsonLineAuditStoreOptions {
  now?: () => Date;
  retentionDays?: number;
}

export interface AuditRetentionSweep {
  close(): void;
}

export interface AuditRetentionSweepOptions {
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface PrunableAuditStore {
  prune(): Promise<void>;
}

export async function startAuditRetentionSweep(
  store: PrunableAuditStore,
  options: AuditRetentionSweepOptions = {},
): Promise<AuditRetentionSweep> {
  const intervalMs = options.intervalMs ?? 6 * 60 * 60 * 1000;
  if (!Number.isInteger(intervalMs) || intervalMs < 1) {
    throw new Error("intervalMs must be a positive integer.");
  }
  await store.prune();
  const timer = setInterval(() => {
    void store.prune().catch((error: unknown) => options.onError?.(error));
  }, intervalMs);
  timer.unref();
  return { close: () => clearInterval(timer) };
}

export class DailyJsonLineAuditStore implements AuditPersistenceMonitor {
  readonly #root: string;
  readonly #now: () => Date;
  readonly #retentionDays: number;
  #queue: Promise<void> = Promise.resolve();
  #failureVersion = 0;

  constructor(root: string, options: DailyJsonLineAuditStoreOptions = {}) {
    const retentionDays = options.retentionDays ?? MAX_AUDIT_RETENTION_DAYS;
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > MAX_AUDIT_RETENTION_DAYS) {
      throw new Error(`retentionDays must be an integer between 1 and ${MAX_AUDIT_RETENTION_DAYS}.`);
    }
    this.#root = resolve(root);
    this.#now = options.now ?? (() => new Date());
    this.#retentionDays = retentionDays;
  }

  get failureVersion(): number {
    return this.#failureVersion;
  }

  markFailure(): void {
    this.#failureVersion += 1;
  }

  append(type: "approval_audit" | "mcp_tool_invocation" | "oauth_security", event: object): Promise<void> {
    return this.#enqueue(async () => {
      const now = this.#now();
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      await appendFile(
        resolve(this.#root, `${utcDateKey(now)}.jsonl`),
        `${JSON.stringify({ schemaVersion: 1, type, ...event })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await this.#pruneNow(now);
    });
  }

  prune(): Promise<void> {
    return this.#enqueue(async () => {
      const now = this.#now();
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      await this.#pruneNow(now);
    });
  }

  #enqueue(operation: () => Promise<void>): Promise<void> {
    const trackedOperation = async (): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        this.markFailure();
        throw error;
      }
    };
    const next = this.#queue.then(trackedOperation, trackedOperation);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #pruneNow(now: Date): Promise<void> {
    const cutoff = utcDayStart(now) - (this.#retentionDays - 1) * DAY_MS;
    const entries = await readdir(this.#root, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isFile()) return;
        const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u.exec(entry.name);
        if (match === null) return;
        const entryDay = Date.parse(`${match[1]}T00:00:00.000Z`);
        if (!Number.isFinite(entryDay) || entryDay >= cutoff) return;
        await rm(resolve(this.#root, entry.name), { force: true });
      }),
    );
  }
}

export class RetainedToolInvocationAuditSink implements ToolInvocationAuditSink {
  readonly #store: DailyJsonLineAuditStore;

  constructor(store: DailyJsonLineAuditStore) {
    this.#store = store;
  }

  record(event: ToolInvocationAuditEvent): Promise<void> {
    return this.#store.append("mcp_tool_invocation", event);
  }
}

export class RetainedApprovalAuditSink implements ApprovalAuditSink {
  readonly #store: DailyJsonLineAuditStore;

  constructor(store: DailyJsonLineAuditStore) {
    this.#store = store;
  }

  record(event: ApprovalAuditEvent): Promise<void> {
    return this.#store.append("approval_audit", event);
  }
}

export class BoundedApprovalAuditSink implements ApprovalAuditSink {
  readonly #delegate: ApprovalAuditSink;
  readonly #health: AuditPersistenceMonitor;
  readonly #invocationContext: AuditInvocationContext | undefined;
  readonly #timeoutMs: number;

  constructor(
    delegate: ApprovalAuditSink,
    health: AuditPersistenceMonitor,
    options: { invocationContext?: AuditInvocationContext; timeoutMs?: number } = {},
  ) {
    this.#delegate = delegate;
    this.#health = health;
    this.#invocationContext = options.invocationContext;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_AUDIT_WRITE_TIMEOUT_MS;
    assertPositiveTimeout(this.#timeoutMs);
  }

  async record(event: ApprovalAuditEvent): Promise<void> {
    const failureVersion = this.#health.failureVersion;
    try {
      await runAuditWriteWithinTimeout(() => this.#delegate.record(event), this.#timeoutMs);
    } catch (error) {
      if (this.#health.failureVersion === failureVersion) this.#health.markFailure();
      this.#invocationContext?.markApprovalAuditFailure();
      throw error;
    }
  }
}

export async function runAuditWriteWithinTimeout(
  writeOperation: () => void | Promise<void>,
  timeoutMs: number,
): Promise<void> {
  assertPositiveTimeout(timeoutMs);
  let timer: NodeJS.Timeout | undefined;
  const write = Promise.resolve().then(writeOperation);
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Structured audit write timed out.")), timeoutMs);
    timer.unref();
  });
  try {
    await Promise.race([write, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void write.catch(() => undefined);
  }
}

function utcDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDayStart(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function assertPositiveTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("timeoutMs must be a positive integer.");
  }
}
