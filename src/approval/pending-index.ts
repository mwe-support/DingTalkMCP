import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const STATE_FILE = "pending-approval-index.json";
const SEEN_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SEEN_EVENTS = 10_000;
const COMPLETED_ITEM_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_COMPLETED_ITEMS = 5_000;
const MAX_STATE_BYTES = 4 * 1024 * 1024;

export type ApprovalInboxEventType = "start" | "finish" | "cancel";

export interface ApprovalInboxEvent {
  eventId: string;
  corpId: string;
  processInstanceId: string;
  processCode: string;
  taskId?: string;
  staffId: string;
  title?: string;
  type: ApprovalInboxEventType;
  result?: "agree" | "refuse" | "redirect";
  eventTime: number;
  createTime?: number;
}

export interface ApprovalInboxItem {
  processInstanceId: string;
  processCode: string;
  taskId?: string;
  userId: string;
  title?: string;
  createdAt: number;
  updatedAt: number;
  recordStatus: "pending" | "completed";
  decisionResult?: "agree" | "refuse" | "redirect";
  completedAt?: number;
}

export interface ApprovalInboxPage {
  coverage: "partial";
  coverageSince: number;
  lastEventAt?: number;
  resyncRequired: true;
  page: number;
  limit: number;
  recordStatus: "pending" | "completed";
  capacityTruncated?: true;
  items: ApprovalInboxItem[];
  hasMore: boolean;
}

export interface ApprovalInboxIndex {
  apply(event: ApprovalInboxEvent): Promise<void>;
  list(input: {
    userId: string;
    page: number;
    limit: number;
    recordStatus?: "pending" | "completed";
  }): Promise<ApprovalInboxPage>;
}

interface ApprovalInboxState {
  schemaVersion: 2;
  activatedAt: number;
  completedActivatedAt: number;
  completedCapacityTruncatedBefore?: number;
  lastEventAt?: number;
  pendingItems: Record<string, ApprovalInboxItem>;
  completedItems: Record<string, ApprovalInboxItem>;
  seenEvents: Record<string, number>;
}

export interface DirectoryApprovalInboxIndexOptions {
  now?: () => number;
}

export class DirectoryApprovalInboxIndex implements ApprovalInboxIndex {
  readonly #root: string;
  readonly #statePath: string;
  readonly #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(root: string, options: DirectoryApprovalInboxIndexOptions = {}) {
    this.#root = resolve(root);
    this.#statePath = resolve(this.#root, STATE_FILE);
    this.#now = options.now ?? Date.now;
  }

  apply(event: ApprovalInboxEvent): Promise<void> {
    assertEvent(event);
    return this.#update((state) => {
      if (state.seenEvents[event.eventId] !== undefined) return;
      state.seenEvents[event.eventId] = event.eventTime;
      state.lastEventAt = Math.max(state.lastEventAt ?? 0, event.eventTime);
      const key = itemKey(event.staffId, event.processInstanceId, event.taskId);
      const instanceOnlyKey = itemKey(event.staffId, event.processInstanceId, undefined);
      if (event.type === "start") {
        if (event.taskId !== undefined) {
          delete state.pendingItems[instanceOnlyKey];
        } else if (Object.values(state.pendingItems).some((item) =>
          item.userId === event.staffId &&
          item.processInstanceId === event.processInstanceId &&
          item.taskId !== undefined
        )) {
          return;
        }
        delete state.completedItems[key];
        state.pendingItems[key] = {
          processInstanceId: event.processInstanceId,
          processCode: event.processCode,
          ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
          userId: event.staffId,
          ...(event.title === undefined ? {} : { title: event.title }),
          createdAt: event.createTime ?? event.eventTime,
          updatedAt: event.eventTime,
          recordStatus: "pending",
        };
        return;
      }
      const priorItems = Object.values(state.pendingItems).filter((item) =>
        item.userId === event.staffId &&
        item.processInstanceId === event.processInstanceId &&
        (event.taskId === undefined || item.taskId === event.taskId || item.taskId === undefined)
      );
      if (event.taskId !== undefined) {
        delete state.pendingItems[key];
        delete state.pendingItems[instanceOnlyKey];
      } else for (const [candidateKey, item] of Object.entries(state.pendingItems)) {
        if (item.userId === event.staffId && item.processInstanceId === event.processInstanceId) {
          delete state.pendingItems[candidateKey];
        }
      }
      if (event.type === "cancel") {
        for (const [candidateKey, item] of Object.entries(state.completedItems)) {
          const sameTask = event.taskId === undefined || item.taskId === event.taskId || item.taskId === undefined;
          if (
            item.userId === event.staffId &&
            item.processInstanceId === event.processInstanceId &&
            sameTask &&
            item.updatedAt <= event.eventTime
          ) {
            delete state.completedItems[candidateKey];
          }
        }
        return;
      }
      if (event.taskId !== undefined) {
        delete state.completedItems[instanceOnlyKey];
      } else if (Object.values(state.completedItems).some((item) =>
        item.userId === event.staffId &&
        item.processInstanceId === event.processInstanceId &&
        item.taskId !== undefined
      )) {
        return;
      }
      const prior = priorItems.sort((left, right) => right.updatedAt - left.updatedAt)[0];
      const resolvedTitle = event.title ?? prior?.title;
      state.completedItems[key] = {
        processInstanceId: event.processInstanceId,
        processCode: event.processCode,
        ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
        userId: event.staffId,
        ...(resolvedTitle === undefined ? {} : { title: resolvedTitle }),
        createdAt: event.createTime ?? prior?.createdAt ?? event.eventTime,
        updatedAt: event.eventTime,
        recordStatus: "completed",
        ...(event.result === undefined ? {} : { decisionResult: event.result }),
        completedAt: event.eventTime,
      };
    });
  }

  list(input: {
    userId: string;
    page: number;
    limit: number;
    recordStatus?: "pending" | "completed";
  }): Promise<ApprovalInboxPage> {
    assertPage(input);
    return this.#update((state) => {
      const now = this.#now();
      const recordStatus = input.recordStatus ?? "pending";
      const source = recordStatus === "completed" ? state.completedItems : state.pendingItems;
      const matching = Object.values(source)
        .filter((item) => item.userId === input.userId)
        .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt);
      const offset = (input.page - 1) * input.limit;
      const items = matching.slice(offset, offset + input.limit).map((item) => ({ ...item }));
      const retentionCoverageSince = now - COMPLETED_ITEM_TTL_MS;
      const capacityTruncated = recordStatus === "completed" &&
        state.completedCapacityTruncatedBefore !== undefined &&
        state.completedCapacityTruncatedBefore > retentionCoverageSince;
      return {
        coverage: "partial",
        coverageSince: recordStatus === "completed"
          ? Math.max(
              state.completedActivatedAt,
              retentionCoverageSince,
              state.completedCapacityTruncatedBefore ?? 0,
            )
          : state.activatedAt,
        ...(state.lastEventAt === undefined ? {} : { lastEventAt: state.lastEventAt }),
        resyncRequired: true,
        page: input.page,
        limit: input.limit,
        recordStatus,
        ...(capacityTruncated ? { capacityTruncated: true as const } : {}),
        items,
        hasMore: offset + items.length < matching.length,
      };
    });
  }

  #update<T>(operation: (state: ApprovalInboxState) => T | Promise<T>): Promise<T> {
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

  async #read(): Promise<ApprovalInboxState> {
    try {
      const raw = await readFile(this.#statePath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_STATE_BYTES) throw new Error("Pending approval index exceeds its size limit.");
      return parseState(JSON.parse(raw) as unknown, this.#now());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const now = this.#now();
      return {
        schemaVersion: 2,
        activatedAt: now,
        completedActivatedAt: now,
        pendingItems: {},
        completedItems: {},
        seenEvents: {},
      };
    }
  }

  async #write(state: ApprovalInboxState): Promise<void> {
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) throw new Error("Pending approval index exceeds its size limit.");
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const temporaryPath = resolve(this.#root, `.pending-approval-index-${randomUUID()}.tmp`);
    await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, this.#statePath);
  }
}

function assertEvent(event: ApprovalInboxEvent): void {
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

function prune(state: ApprovalInboxState, now: number): void {
  for (const [eventId, eventTime] of Object.entries(state.seenEvents)) {
    if (now - eventTime > SEEN_EVENT_TTL_MS) delete state.seenEvents[eventId];
  }
  const entries = Object.entries(state.seenEvents).sort((left, right) => right[1] - left[1]);
  for (const [eventId] of entries.slice(MAX_SEEN_EVENTS)) delete state.seenEvents[eventId];
  const retentionCutoff = now - COMPLETED_ITEM_TTL_MS;
  for (const [key, item] of Object.entries(state.completedItems)) {
    if ((item.completedAt ?? item.updatedAt) < retentionCutoff) delete state.completedItems[key];
  }
  if (
    state.completedCapacityTruncatedBefore !== undefined &&
    state.completedCapacityTruncatedBefore <= retentionCutoff
  ) {
    delete state.completedCapacityTruncatedBefore;
  }
  const completedEntries = Object.entries(state.completedItems)
    .sort((left, right) => right[1].updatedAt - left[1].updatedAt);
  const dropped = completedEntries.slice(MAX_COMPLETED_ITEMS);
  if (dropped.length > 0) {
    const latestDroppedAt = Math.max(...dropped.map(([, item]) => item.updatedAt));
    const truncatedBefore = latestDroppedAt === Number.MAX_SAFE_INTEGER ? latestDroppedAt : latestDroppedAt + 1;
    state.completedCapacityTruncatedBefore = Math.max(
      state.completedCapacityTruncatedBefore ?? 0,
      truncatedBefore,
    );
  }
  for (const [key] of dropped) delete state.completedItems[key];
}

function parseState(value: unknown, now: number): ApprovalInboxState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Pending approval index is malformed.");
  const record = value as Record<string, unknown>;
  const activatedAt = positiveSafeInteger(record.activatedAt);
  if (activatedAt === undefined) throw new Error("Pending approval index is malformed.");
  const lastEventAt = record.lastEventAt === undefined ? undefined : positiveSafeInteger(record.lastEventAt);
  if (record.lastEventAt !== undefined && lastEventAt === undefined) throw new Error("Pending approval index is malformed.");
  const seenEvents = parseEventTimes(record.seenEvents);
  if (record.schemaVersion === 1) {
    return {
      schemaVersion: 2,
      activatedAt,
      completedActivatedAt: now,
      ...(lastEventAt === undefined ? {} : { lastEventAt }),
      pendingItems: parseItems(record.items, "pending", true),
      completedItems: {},
      seenEvents,
    };
  }
  if (record.schemaVersion !== 2) throw new Error("Pending approval index is malformed.");
  const completedActivatedAt = positiveSafeInteger(record.completedActivatedAt);
  if (completedActivatedAt === undefined) throw new Error("Pending approval index is malformed.");
  const completedCapacityTruncatedBefore = record.completedCapacityTruncatedBefore === undefined
    ? undefined
    : positiveSafeInteger(record.completedCapacityTruncatedBefore);
  if (record.completedCapacityTruncatedBefore !== undefined && completedCapacityTruncatedBefore === undefined) {
    throw new Error("Pending approval index is malformed.");
  }
  return {
    schemaVersion: 2,
    activatedAt,
    completedActivatedAt,
    ...(completedCapacityTruncatedBefore === undefined ? {} : { completedCapacityTruncatedBefore }),
    ...(lastEventAt === undefined ? {} : { lastEventAt }),
    pendingItems: parseItems(record.pendingItems, "pending", false),
    completedItems: parseItems(record.completedItems, "completed", false),
    seenEvents,
  };
}

function parseItems(
  value: unknown,
  expectedStatus: "pending" | "completed",
  allowMissingStatus: boolean,
): Record<string, ApprovalInboxItem> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Pending approval index is malformed.");
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, parseItem(item, expectedStatus, allowMissingStatus)]));
}

function parseItem(
  value: unknown,
  expectedStatus: "pending" | "completed",
  allowMissingStatus: boolean,
): ApprovalInboxItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Pending approval index is malformed.");
  }
  const record = value as Record<string, unknown>;
  const processInstanceId = nonEmptyString(record.processInstanceId);
  const processCode = nonEmptyString(record.processCode);
  const userId = nonEmptyString(record.userId);
  const taskId = record.taskId === undefined ? undefined : nonEmptyString(record.taskId);
  const title = record.title === undefined ? undefined : nonEmptyString(record.title);
  const createdAt = positiveSafeInteger(record.createdAt);
  const updatedAt = positiveSafeInteger(record.updatedAt);
  const storedStatus = record.recordStatus;
  if (
    processInstanceId === undefined ||
    processCode === undefined ||
    userId === undefined ||
    (record.taskId !== undefined && taskId === undefined) ||
    (record.title !== undefined && title === undefined) ||
    createdAt === undefined ||
    updatedAt === undefined ||
    (!allowMissingStatus && storedStatus !== expectedStatus) ||
    (allowMissingStatus && storedStatus !== undefined && storedStatus !== expectedStatus)
  ) {
    throw new Error("Pending approval index is malformed.");
  }
  const decisionResult = record.decisionResult;
  const completedAt = record.completedAt === undefined ? undefined : positiveSafeInteger(record.completedAt);
  if (
    (decisionResult !== undefined && decisionResult !== "agree" && decisionResult !== "refuse" && decisionResult !== "redirect") ||
    (record.completedAt !== undefined && completedAt === undefined) ||
    (expectedStatus === "pending" && (decisionResult !== undefined || completedAt !== undefined)) ||
    (expectedStatus === "completed" && completedAt === undefined)
  ) {
    throw new Error("Pending approval index is malformed.");
  }
  return {
    processInstanceId,
    processCode,
    ...(taskId === undefined ? {} : { taskId }),
    userId,
    ...(title === undefined ? {} : { title }),
    createdAt,
    updatedAt,
    recordStatus: expectedStatus,
    ...(decisionResult === undefined ? {} : { decisionResult }),
    ...(completedAt === undefined ? {} : { completedAt }),
  };
}

function parseEventTimes(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Pending approval index is malformed.");
  }
  return Object.fromEntries(Object.entries(value).map(([eventId, rawTime]) => {
    const eventTime = positiveSafeInteger(rawTime);
    if (eventId.trim() === "" || eventTime === undefined) throw new Error("Pending approval index is malformed.");
    return [eventId, eventTime];
  }));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
