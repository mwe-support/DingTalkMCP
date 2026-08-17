import { ApprovalMcpError } from "./core/errors.js";
import { resolve } from "node:path";
import { MCP_SCOPES, type McpScope } from "./auth/types.js";

export interface McpAuthConfig {
  publicUrl: string;
  issuerUrl: string;
  redirectUrl: string;
  corpId: string;
  signingPrivateKeyPath: string;
  signingKeyId: string;
  auditHmacKeyPath: string;
  authStorePath: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  transactionTtlSeconds: number;
  allowedScopes: McpScope[];
}

export interface ApprovalMcpConfig {
  clientId: string;
  clientSecret: string;
  agentId?: number;
  apiBaseUrl: string;
  allowedProcessCodes: string[];
  downloadHostSuffixes: string[];
  uploadHostSuffixes: string[];
  idempotencyLedgerPath: string;
  auditLogPath: string;
  auth: McpAuthConfig;
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
  const publicUrl = canonicalHttpsUrl(required(env, "MCP_PUBLIC_URL"), "MCP_PUBLIC_URL");
  if (publicUrl.pathname !== "/mcp" || publicUrl.search !== "" || publicUrl.hash !== "") {
    throw new ApprovalMcpError("CONFIGURATION_ERROR", "MCP_PUBLIC_URL must use the exact /mcp path.");
  }
  const issuerUrl = canonicalHttpsUrl(required(env, "MCP_ISSUER_URL"), "MCP_ISSUER_URL");
  if (issuerUrl.pathname !== "/" || issuerUrl.search !== "" || issuerUrl.hash !== "") {
    throw new ApprovalMcpError("CONFIGURATION_ERROR", "MCP_ISSUER_URL must be an HTTPS origin URL.");
  }
  const redirectUrl = canonicalHttpsUrl(
    required(env, "DINGTALK_OAUTH_REDIRECT_URL"),
    "DINGTALK_OAUTH_REDIRECT_URL",
  );
  if (publicUrl.origin !== issuerUrl.origin || redirectUrl.origin !== issuerUrl.origin) {
    throw new ApprovalMcpError(
      "CONFIGURATION_ERROR",
      "MCP_PUBLIC_URL, MCP_ISSUER_URL and DINGTALK_OAUTH_REDIRECT_URL must share one origin.",
    );
  }
  if (
    redirectUrl.pathname !== "/oauth/dingtalk/callback" ||
    redirectUrl.search !== "" ||
    redirectUrl.hash !== ""
  ) {
    throw new ApprovalMcpError(
      "CONFIGURATION_ERROR",
      "DINGTALK_OAUTH_REDIRECT_URL must use the exact /oauth/dingtalk/callback path.",
    );
  }

  const accessTokenTtlSeconds = boundedInteger(env.MCP_ACCESS_TOKEN_TTL_SECONDS, 600, 60, 3600, "MCP_ACCESS_TOKEN_TTL_SECONDS");
  const refreshTokenTtlSeconds = boundedInteger(
    env.MCP_REFRESH_TOKEN_TTL_SECONDS,
    7 * 24 * 60 * 60,
    accessTokenTtlSeconds,
    30 * 24 * 60 * 60,
    "MCP_REFRESH_TOKEN_TTL_SECONDS",
  );
  const transactionTtlSeconds = boundedInteger(
    env.MCP_AUTH_TRANSACTION_TTL_SECONDS,
    300,
    60,
    900,
    "MCP_AUTH_TRANSACTION_TTL_SECONDS",
  );
  const allowedScopes = csv(env.MCP_ALLOWED_SCOPES, [...MCP_SCOPES]);
  if (allowedScopes.some((scope) => !MCP_SCOPES.includes(scope as McpScope))) {
    throw new ApprovalMcpError("CONFIGURATION_ERROR", "MCP_ALLOWED_SCOPES contains an unsupported scope.");
  }
  const agentId = optionalPositiveInteger(env.DINGTALK_AGENT_ID, "DINGTALK_AGENT_ID");

  return {
    clientId,
    clientSecret,
    ...(agentId === undefined ? {} : { agentId }),
    apiBaseUrl: parsedBaseUrl.toString().replace(/\/$/u, ""),
    allowedProcessCodes: csv(env.APPROVAL_ALLOWED_PROCESS_CODES),
    downloadHostSuffixes: csv(env.APPROVAL_DOWNLOAD_HOST_SUFFIXES, [
      ".dingtalk.com",
      ".alicdn.com",
      ".aliyuncs.com",
    ]),
    uploadHostSuffixes: csv(env.APPROVAL_UPLOAD_HOST_SUFFIXES, [".trans.dingtalk.com", ".aliyuncs.com"]),
    idempotencyLedgerPath: resolve(env.APPROVAL_IDEMPOTENCY_LEDGER_PATH?.trim() || "./data/approval-idempotency"),
    auditLogPath: resolve(env.APPROVAL_AUDIT_LOG_PATH?.trim() || "./data/audit"),
    auth: {
      publicUrl: publicUrl.href.replace(/\/$/u, ""),
      issuerUrl: issuerUrl.href,
      redirectUrl: redirectUrl.href,
      corpId: required(env, "DINGTALK_CORP_ID"),
      signingPrivateKeyPath: resolve(required(env, "MCP_SIGNING_PRIVATE_KEY_FILE")),
      signingKeyId: optional(env.MCP_SIGNING_KEY_ID) ?? "mwe-approval-mcp-1",
      auditHmacKeyPath: resolve(required(env, "MCP_AUDIT_HMAC_KEY_FILE")),
      authStorePath: resolve(optional(env.MCP_AUTH_STORE_PATH) ?? "./data/auth"),
      accessTokenTtlSeconds,
      refreshTokenTtlSeconds,
      transactionTtlSeconds,
      allowedScopes: allowedScopes as McpScope[],
    },
  };
}

function optionalPositiveInteger(value: string | undefined, key: string): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApprovalMcpError("CONFIGURATION_ERROR", `${key} must be a positive safe integer.`);
  }
  return parsed;
}

function canonicalHttpsUrl(value: string, key: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ApprovalMcpError("CONFIGURATION_ERROR", `${key} must be a valid URL.`, { cause: error });
  }
  if (url.protocol !== "https:") {
    throw new ApprovalMcpError("CONFIGURATION_ERROR", `${key} must use HTTPS.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ApprovalMcpError("CONFIGURATION_ERROR", `${key} must not contain user information.`);
  }
  return url;
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

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  key: string,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ApprovalMcpError(
      "CONFIGURATION_ERROR",
      `${key} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return parsed;
}
