import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const STATE_FILE = "pending-approval-index.json";
const SEEN_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SEEN_EVENTS = 10_000;
const MAX_STATE_BYTES = 4 * 1024 * 1024;

export type PendingApprovalEventType = "start" | "finish" | "cancel";

export interface PendingApprovalEvent {
  eventId: string;
  corpId: string;
  processInstanceId: string;
  processCode: string;
  taskId?: string;
  staffId: string;
  title?: string;
  type: PendingApprovalEventType;
  result?: "agree" | "refuse" | "redirect";
  eventTime: number;
  createTime?: number;
}

export interface PendingApprovalItem {
  processInstanceId: string;
  processCode: string;
  taskId?: string;
  userId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PendingApprovalPage {
  coverage: "partial";
  coverageSince: number;
  lastEventAt?: number;
  resyncRequired: true;
  page: number;
  limit: number;
  items: PendingApprovalItem[];
  hasMore: boolean;
}

export interface PendingApprovalIndex {
  apply(event: PendingApprovalEvent): Promise<void>;
  list(input: { userId: string; page: number; limit: number }): Promise<PendingApprovalPage>;
}

interface PendingApprovalState {
  schemaVersion: 1;
  activatedAt: number;
  lastEventAt?: number;
  items: Record<string, PendingApprovalItem>;
  seenEvents: Record<string, number>;
}

export interface DirectoryPendingApprovalIndexOptions {
  now?: () => number;
}

export class DirectoryPendingApprovalIndex implements PendingApprovalIndex {
  readonly #root: string;
  readonly #statePath: string;
  readonly #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(root: string, options: DirectoryPendingApprovalIndexOptions = {}) {
    this.#root = resolve(root);
    this.#statePath = resolve(this.#root, STATE_FILE);
    this.#now = options.now ?? Date.now;
  }

  apply(event: PendingApprovalEvent): Promise<void> {
    assertEvent(event);
    return this.#update((state) => {
      if (state.seenEvents[event.eventId] !== undefined) return;
      state.seenEvents[event.eventId] = event.eventTime;
      state.lastEventAt = Math.max(state.lastEventAt ?? 0, event.eventTime);
      const key = itemKey(event.staffId, event.processInstanceId, event.taskId);
      const instanceOnlyKey = itemKey(event.staffId, event.processInstanceId, undefined);
      if (event.type === "start") {
        if (event.taskId !== undefined) {
          delete state.items[instanceOnlyKey];
        } else if (Object.values(state.items).some((item) =>
          item.userId === event.staffId &&
          item.processInstanceId === event.processInstanceId &&
          item.taskId !== undefined
        )) {
          return;
        }
        state.items[key] = {
          processInstanceId: event.processInstanceId,
          processCode: event.processCode,
          ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
          userId: event.staffId,
          ...(event.title === undefined ? {} : { title: event.title }),
          createdAt: event.createTime ?? event.eventTime,
          updatedAt: event.eventTime,
        };
        return;
      }
      if (event.taskId !== undefined) {
        delete state.items[key];
        delete state.items[instanceOnlyKey];
        return;
      }
      for (const [candidateKey, item] of Object.entries(state.items)) {
        if (item.userId === event.staffId && item.processInstanceId === event.processInstanceId) {
          delete state.items[candidateKey];
        }
      }
    });
  }

  list(input: { userId: string; page: number; limit: number }): Promise<PendingApprovalPage> {
    assertPage(input);
    return this.#update((state) => {
      const matching = Object.values(state.items)
        .filter((item) => item.userId === input.userId)
        .sort((left, right) => right.createdAt - left.createdAt || right.updatedAt - left.updatedAt);
      const offset = (input.page - 1) * input.limit;
      const items = matching.slice(offset, offset + input.limit).map((item) => ({ ...item }));
      return {
        coverage: "partial",
        coverageSince: state.activatedAt,
        ...(state.lastEventAt === undefined ? {} : { lastEventAt: state.lastEventAt }),
        resyncRequired: true,
        page: input.page,
        limit: input.limit,
        items,
        hasMore: offset + items.length < matching.length,
      };
    });
  }

  #update<T>(operation: (state: PendingApprovalState) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const state = await this.#read();
      prune(state, this.#now());
      const result = await operation(state);
      await this.#write(state);
      return result;
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.then(() => undefined, () => undefined);
    return next;
  }

  async #read(): Promise<PendingApprovalState> {
    try {
      const raw = await readFile(this.#statePath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) throw new Error("Pending approval index exceeds its size limit.");
      return parseState(JSON.parse(raw) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const now = this.#now();
      return { schemaVersion: 1, activatedAt: now, items: {}, seenEvents: {} };
    }
  }

  async #write(state: PendingApprovalState): Promise<void> {
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) throw new Error("Pending approval index exceeds its size limit.");
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const temporaryPath = resolve(this.#root, `.pending-approval-index-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.#statePath);
  }
}

function assertEvent(event: PendingApprovalEvent): void {
  for (const [name, value] of Object.entries({
    eventId: event.eventId,
    corpId: event.corpId,
    processInstanceId: event.processInstanceId,
    processCode: event.processCode,
    staffId: event.staffId,
  })) {
    if (typeof value !== "string" || value.trim() === "") throw new Error(`Invalid pending approval event ${name}.`);
  }
  if (event.taskId !== undefined && event.taskId.trim() === "") throw new Error("Invalid pending approval event taskId.");
  if (!Number.isSafeInteger(event.eventTime) || event.eventTime <= 0) throw new Error("Invalid pending approval event time.");
}

function assertPage(input: { userId: string; page: number; limit: number }): void {
  if (input.userId.trim() === "") throw new Error("Pending approval userId is required.");
  if (!Number.isInteger(input.page) || input.page < 1 || input.page > 10) throw new Error("Pending approval page must be between 1 and 10.");
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 20) throw new Error("Pending approval limit must be between 1 and 20.");
}

function itemKey(userId: string, processInstanceId: string, taskId: string | undefined): string {
  return createHash("sha256").update(`${userId}\0${processInstanceId}\0${taskId ?? ""}`, "utf8").digest("hex");
}

function prune(state: PendingApprovalState, now: number): void {
  for (const [eventId, eventTime] of Object.entries(state.seenEvents)) {
    if (now - eventTime > SEEN_EVENT_TTL_MS) delete state.seenEvents[eventId];
  }
  const entries = Object.entries(state.seenEvents).sort((left, right) => right[1] - left[1]);
  for (const [eventId] of entries.slice(MAX_SEEN_EVENTS)) delete state.seenEvents[eventId];
}

function parseState(value: unknown): PendingApprovalState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Pending approval index is malformed.");
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Number.isSafeInteger(record.activatedAt)) throw new Error("Pending approval index is malformed.");
  if (typeof record.items !== "object" || record.items === null || Array.isArray(record.items)) throw new Error("Pending approval index is malformed.");
  if (typeof record.seenEvents !== "object" || record.seenEvents === null || Array.isArray(record.seenEvents)) throw new Error("Pending approval index is malformed.");
  return value as PendingApprovalState;
}
