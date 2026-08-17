import type { PendingApprovalEvent, PendingApprovalIndex } from "../approval/pending-index.js";

export interface DingTalkStreamEventEnvelope {
  specVersion: string;
  type: string;
  headers: {
    appId: string;
    connectionId: string;
    contentType: string;
    messageId: string;
    time: string;
    topic: string;
    eventType?: string;
    eventBornTime?: string;
    eventId?: string;
    eventCorpId?: string;
  };
  data: string;
}

export interface DingTalkEventClient {
  registerAllEventListener(
    listener: (message: DingTalkStreamEventEnvelope) => { status: string },
  ): DingTalkEventClient;
  connect(): Promise<void>;
  disconnect(): void;
}

export interface DingTalkEventClientConfig {
  clientId: string;
  clientSecret: string;
  keepAlive: boolean;
  debug: boolean;
  maxPendingEventHandlers: number;
  subscriptions: Array<{ type: "EVENT"; topic: "*" }>;
}

export interface DingTalkApprovalEventStreamOptions {
  clientId: string;
  clientSecret: string;
  corpId: string;
  index: PendingApprovalIndex;
  clientFactory?: ((config: DingTalkEventClientConfig) => DingTalkEventClient) | undefined;
}

export interface RunningDingTalkApprovalEventStream {
  close(): void;
}

export async function startDingTalkApprovalEventStream(
  options: DingTalkApprovalEventStreamOptions,
): Promise<RunningDingTalkApprovalEventStream> {
  const factory = options.clientFactory ?? await defaultClientFactory();
  const client = factory({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    keepAlive: true,
    debug: false,
    maxPendingEventHandlers: 20,
    subscriptions: [{ type: "EVENT", topic: "*" }],
  });
  const eventStates = new Map<string, { state: "pending" | "complete"; updatedAt: number }>();
  client.registerAllEventListener((message) => {
    try {
      const event = parseTaskChangeEvent(message, options.corpId);
      if (event === undefined) return { status: "SUCCESS" };
      pruneEventStates(eventStates, Date.now());
      const current = eventStates.get(event.eventId);
      if (current?.state === "complete") return { status: "SUCCESS" };
      if (current?.state === "pending") return { status: "LATER" };
      eventStates.set(event.eventId, { state: "pending", updatedAt: Date.now() });
      void Promise.resolve()
        .then(() => options.index.apply(event))
        .then(() => eventStates.set(event.eventId, { state: "complete", updatedAt: Date.now() }))
        .catch(() => eventStates.delete(event.eventId));
      return { status: "LATER" };
    } catch {
      return { status: "LATER" };
    }
  });
  await client.connect();
  return { close: () => client.disconnect() };
}

export function parseTaskChangeEvent(
  message: DingTalkStreamEventEnvelope,
  expectedCorpId: string,
): PendingApprovalEvent | undefined {
  if (message.type !== "EVENT") return undefined;
  const payload = parseRecord(message.data);
  const eventType = stringValue(payload.EventType ?? payload.eventType ?? message.headers.eventType);
  if (eventType !== "bpms_task_change") return undefined;
  const corpId = stringValue(payload.CorpId ?? payload.corpId ?? message.headers.eventCorpId);
  if (corpId !== expectedCorpId) return undefined;
  const rawType = stringValue(payload.type)?.toLowerCase();
  if (rawType !== "start" && rawType !== "finish" && rawType !== "cancel") {
    throw new Error("DingTalk task-change event has an unsupported type.");
  }
  const eventTime = integerValue(payload.EventTime ?? payload.eventTime ?? message.headers.eventBornTime ?? message.headers.time);
  const processInstanceId = requiredString(payload.processInstanceId, "processInstanceId");
  const taskId = optionalScalar(payload.taskId);
  const staffId = requiredString(payload.staffId, "staffId");
  const eventId = stringValue(payload.eventId ?? message.headers.eventId ?? message.headers.messageId);
  if (eventId === undefined) throw new Error("DingTalk task-change event is missing eventId.");
  const result = stringValue(payload.result)?.toLowerCase();
  if (result !== undefined && result !== "agree" && result !== "refuse" && result !== "redirect") {
    throw new Error("DingTalk task-change event has an unsupported result.");
  }
  const processCode = requiredString(payload.processCode, "processCode");
  const title = stringValue(payload.title);
  const createTime = optionalInteger(payload.createTime);
  return {
    eventId,
    corpId,
    processInstanceId,
    processCode,
    ...(taskId === undefined ? {} : { taskId }),
    staffId,
    ...(title === undefined ? {} : { title }),
    type: rawType,
    ...(result === undefined ? {} : { result }),
    eventTime,
    ...(createTime === undefined ? {} : { createTime }),
  };
}

function parseRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("DingTalk Stream event data must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  const parsed = stringValue(value);
  if (parsed === undefined) throw new Error(`DingTalk task-change event is missing ${name}.`);
  return parsed;
}

function optionalScalar(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return stringValue(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function integerValue(value: unknown): number {
  const parsed = optionalInteger(value);
  if (parsed === undefined || parsed <= 0) throw new Error("DingTalk task-change event has an invalid event time.");
  return parsed;
}

function optionalInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  return undefined;
}

async function defaultClientFactory(): Promise<(config: DingTalkEventClientConfig) => DingTalkEventClient> {
  const { DWClient, EventAck } = await import("dingtalk-stream");
  return (config) => {
    const sdkClient = new DWClient(config);
    let adapter: DingTalkEventClient;
    adapter = {
      registerAllEventListener: (listener) => {
        sdkClient.registerAllEventListener((message) => {
          const result = listener(message as DingTalkStreamEventEnvelope);
          return { status: result.status === "SUCCESS" ? EventAck.SUCCESS : EventAck.LATER };
        });
        return adapter;
      },
      connect: () => sdkClient.connect(),
      disconnect: () => sdkClient.disconnect(),
    };
    return adapter;
  };
}

function pruneEventStates(
  states: Map<string, { state: "pending" | "complete"; updatedAt: number }>,
  now: number,
): void {
  for (const [eventId, value] of states) {
    if (now - value.updatedAt > 5 * 60 * 1000) states.delete(eventId);
  }
  while (states.size > 10_000) {
    const oldest = states.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    states.delete(oldest);
  }
}
