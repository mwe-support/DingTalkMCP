import { ApprovalMcpError } from "./core/errors.js";
import { resolve } from "node:path";

export interface ApprovalMcpConfig {
  clientId: string;
  clientSecret: string;
  apiBaseUrl: string;
  callerUserId?: string;
  writeUserIds: string[];
  allowedProcessCodes: string[];
  downloadHostSuffixes: string[];
  idempotencyLedgerPath: string;
  auditLogPath: string;
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
    downloadHostSuffixes: csv(env.APPROVAL_DOWNLOAD_HOST_SUFFIXES, [
      ".dingtalk.com",
      ".alicdn.com",
      ".aliyuncs.com",
    ]),
    idempotencyLedgerPath: resolve(env.APPROVAL_IDEMPOTENCY_LEDGER_PATH?.trim() || "./data/approval-idempotency"),
    auditLogPath: resolve(env.APPROVAL_AUDIT_LOG_PATH?.trim() || "./data/audit"),
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
