export interface NormalizedProcessInstance {
  processInstanceId?: string;
  title?: string;
  status?: string;
  result?: string;
  processCode?: string;
  originatorUserId?: string;
  createTime?: string | number;
  finishTime?: string | number;
  tasks: unknown[];
  operationRecords: unknown[];
  formComponentValues: unknown[];
}

export function unwrapResult(payload: unknown): unknown {
  const record = asRecord(payload);
  return record !== undefined && "result" in record ? record.result : payload;
}

export function normalizeProcessInstance(raw: unknown): NormalizedProcessInstance {
  const record = asRecord(raw) ?? {};
  const processInstanceId = text(record.processInstanceId ?? record.instanceId ?? record.id);
  const title = text(record.title);
  const status = text(record.status);
  const result = text(record.result);
  const processCode = text(record.processCode);
  const originatorUserId = text(record.originatorUserId);
  const createTime = textOrNumber(record.createTime);
  const finishTime = textOrNumber(record.finishTime);
  return {
    ...(processInstanceId === undefined ? {} : { processInstanceId }),
    ...(title === undefined ? {} : { title }),
    ...(status === undefined ? {} : { status }),
    ...(result === undefined ? {} : { result }),
    ...(processCode === undefined ? {} : { processCode }),
    ...(originatorUserId === undefined ? {} : { originatorUserId }),
    ...(createTime === undefined ? {} : { createTime }),
    ...(finishTime === undefined ? {} : { finishTime }),
    tasks: array(record.tasks),
    operationRecords: array(record.operationRecords),
    formComponentValues: array(record.formComponentValues),
  };
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function textOrNumber(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}
