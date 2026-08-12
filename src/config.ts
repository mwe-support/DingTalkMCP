import { ApprovalMcpError } from "./core/errors.js";
import { resolve } from "node:path";

export interface ApprovalMcpConfig {
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
  callerUserId?: string;
  writeUserIds: string[];
  allowedProcessCodes: string[];
  downloadMaxBytes: number;
  attachmentBatchMaxBytes: number;
  downloadHostSuffixes: string[];
  idempotencyLedgerPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApprovalMcpConfig {
  const clientId = required(env, "DINGTALK_CLIENT_ID");
  const clientSecret = required(env, "DINGTALK_CLIENT_SECRET");
  const apiBaseUrl = env.DINGTALK_API_BASE_URL?.trim() || "https://api.dingtalk.com";
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(apiBaseUrl);
  } catch (error) {
    throw new ApprovalMcpError("CONFIGURATION_ERROR", "DINGTALK_API_BASE_URL must be a valid URL.", {
      cause: error,
    });
  }
  if (parsedBaseUrl.protocol !== "https:") {
    throw new ApprovalMcpError("CONFIGURATION_ERROR", "DINGTALK_API_BASE_URL must use HTTPS.");
  }
  const callerUserId = optional(env.DINGTALK_CALLER_USER_ID);

  return {
    clientId,
    clientSecret,
    apiBaseUrl: parsedBaseUrl.toString().replace(/\/$/u, ""),
    ...(callerUserId === undefined ? {} : { callerUserId }),
    writeUserIds: csv(env.DINGTALK_WRITE_USER_IDS),
    allowedProcessCodes: csv(env.APPROVAL_ALLOWED_PROCESS_CODES),
    downloadMaxBytes: positiveInteger(
      env.APPROVAL_DOWNLOAD_MAX_BYTES,
      10 * 1024 * 1024,
      "APPROVAL_DOWNLOAD_MAX_BYTES",
    ),
    attachmentBatchMaxBytes: positiveInteger(
      env.APPROVAL_ATTACHMENT_BATCH_MAX_BYTES,
      15 * 1024 * 1024,
      "APPROVAL_ATTACHMENT_BATCH_MAX_BYTES",
    ),
    downloadHostSuffixes: csv(env.APPROVAL_DOWNLOAD_HOST_SUFFIXES, [
      ".dingtalk.com",
      ".alicdn.com",
      ".aliyuncs.com",
    ]),
    idempotencyLedgerPath: resolve(env.APPROVAL_IDEMPOTENCY_LEDGER_PATH?.trim() || "./data/approval-idempotency"),
  };
}

function optional(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result === undefined || result === "" ? undefined : result;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (value === undefined || value === "") {
    throw new ApprovalMcpError("CONFIGURATION_ERROR", `${key} is required.`);
  }
  return value;
}

function csv(value: string | undefined, fallback: string[] = []): string[] {
  if (value === undefined || value.trim() === "") return fallback;
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function positiveInteger(value: string | undefined, fallback: number, key: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApprovalMcpError("CONFIGURATION_ERROR", `${key} must be a positive integer.`);
  }
  return parsed;
}
