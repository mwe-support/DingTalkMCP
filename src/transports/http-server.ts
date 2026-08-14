import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";

import type { ApprovalService } from "../approval/service.js";
import {
  DEFAULT_AUDIT_WRITE_TIMEOUT_MS,
  type AuditInvocationContext,
  runAuditWriteWithinTimeout,
  type ToolInvocationAuditEvent,
  type ToolInvocationAuditEventBase,
  type ToolInvocationAuditOutcome,
  type ToolInvocationAuditSink,
} from "../core/audit-log.js";
import { invokeApprovalTool } from "../mcp/invoke-tool.js";

export interface ApprovalHttpOptions {
  host: string;
  port: number;
  platformApiKey?: string | undefined;
  allowedHosts: string[];
  auditContext?: AuditInvocationContext;
  auditWriteTimeoutMs?: number;
  toolAudit?: ToolInvocationAuditSink;
}

export interface RunningApprovalHttpServer {
  httpServer: Server;
  close(): Promise<void>;
}

export async function startApprovalHttpServer(
  service: ApprovalService,
  options: ApprovalHttpOptions,
): Promise<RunningApprovalHttpServer> {
  validateOptions(options);
  const allowedHosts = allowedHostSet(options);
  const httpServer = createServer((request, response) => {
    void handleRequest(service, options, allowedHosts, request, response);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  return {
    httpServer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

async function handleRequest(
  service: ApprovalService,
  options: ApprovalHttpOptions,
  allowedHosts: Set<string>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (!hostAllowed(request.headers.host, allowedHosts)) {
    json(response, 421, { error: "Misdirected Request" });
    return;
  }

  const requestUrl = new URL(request.url ?? "/", "http://approval-tools.invalid");
  if (requestUrl.pathname === "/healthz" && request.method === "GET") {
    json(response, 200, { status: "ok", service: "mwe-dingtalk-approval-mcp" });
    return;
  }

  const platformToolName = platformToolFromPath(requestUrl.pathname);
  if (platformToolName !== undefined) {
    await handlePlatformTool(service, options, platformToolName, request, response);
    return;
  }

  json(response, 404, { error: "Not Found" });
}

async function handlePlatformTool(
  service: ApprovalService,
  options: ApprovalHttpOptions,
  toolName: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (options.platformApiKey === undefined) {
    json(response, 404, { error: "Not Found" });
    return;
  }
  if (!authorized(request.headers.authorization, options.platformApiKey)) {
    response.setHeader("www-authenticate", "Bearer");
    json(response, 401, { error: "Unauthorized" });
    return;
  }
  const invocationId = randomUUID();
  const timestamp = new Date().toISOString();
  const startedAt = performance.now();
  const audit = options.toolAudit ?? unavailableToolInvocationAuditSink;
  const auditWriteTimeoutMs = options.auditWriteTimeoutMs ?? DEFAULT_AUDIT_WRITE_TIMEOUT_MS;
  const baseEvent: ToolInvocationAuditEventBase = {
    timestamp,
    invocationId,
    transport: "dingtalk_platform_http",
    toolName,
  };
  response.setHeader("x-mwe-audit-id", invocationId);
  try {
    await runAuditWriteWithinTimeout(() => audit.record({ ...baseEvent, phase: "started" }), auditWriteTimeoutMs);
  } catch {
    response.setHeader("x-mwe-audit-status", "failed");
    json(response, 503, { error: "Structured audit log is unavailable" });
    return;
  }
  const invocationAuditState = options.auditContext?.createState();
  const auditedJson = async (
    status: number,
    responseBody: unknown,
    outcome: ToolInvocationAuditOutcome,
    input?: Record<string, unknown>,
    errorCode?: string,
  ): Promise<void> => {
    const action = approvalAction(input);
    const event: ToolInvocationAuditEvent = {
      ...baseEvent,
      timestamp: new Date().toISOString(),
      ...(action === undefined ? {} : { action }),
      phase: "completed",
      outcome,
      httpStatus: status,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      ...(errorCode === undefined ? {} : { errorCode }),
    };
    const nestedAuditFailed = invocationAuditState?.approvalAuditFailed === true;
    if (nestedAuditFailed) {
      response.setHeader("x-mwe-audit-status", "partial");
      process.stderr.write("Structured tool audit completion write failed.\n");
      json(response, status, responseBody);
      return;
    }
    try {
      await runAuditWriteWithinTimeout(() => audit.record(event), auditWriteTimeoutMs);
      response.setHeader("x-mwe-audit-status", "recorded");
    } catch {
      response.setHeader("x-mwe-audit-status", "partial");
      process.stderr.write("Structured tool audit completion write failed.\n");
    }
    json(response, status, responseBody);
  };

  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    await auditedJson(405, { error: "Method Not Allowed" }, "rejected", undefined, "METHOD_NOT_ALLOWED");
    return;
  }
  if (!isJson(request.headers["content-type"])) {
    await auditedJson(
      415,
      { error: "Content-Type must be application/json" },
      "rejected",
      undefined,
      "UNSUPPORTED_MEDIA_TYPE",
    );
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, 1024 * 1024);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON request body";
    await auditedJson(400, { error: message }, "rejected", undefined, "INVALID_JSON_BODY");
    return;
  }
  if (!isRecord(body)) {
    await auditedJson(
      400,
      { error: "JSON request body must be an object" },
      "rejected",
      undefined,
      "INVALID_JSON_BODY",
    );
    return;
  }

  try {
    const invoke = () => invokeApprovalTool(service, toolName, body);
    const result =
      options.auditContext === undefined || invocationAuditState === undefined
        ? await invoke()
        : await options.auditContext.run(invocationAuditState, invoke);
    if (result === undefined) {
      await auditedJson(404, { error: "Unknown approval tool" }, "unknown_tool", body, "UNKNOWN_TOOL");
      return;
    }
    if (result.isError === true) {
      const payload = isRecord(result.structuredContent)
        ? result.structuredContent
        : {
            error: {
              code: "TOOL_INPUT_OR_EXECUTION_ERROR",
              message: firstTextContent(result.content) ?? "Approval tool rejected the request.",
            },
          };
      const errorCode = safeErrorCode(payload, "TOOL_INPUT_OR_EXECUTION_ERROR");
      await auditedJson(422, payload, toolErrorOutcome(errorCode), body, errorCode);
      return;
    }
    const payload = isRecord(result.structuredContent) ? result.structuredContent : { result: result.content };
    await auditedJson(200, payload, "succeeded", body);
  } catch {
    await auditedJson(
      500,
      { error: "Approval tool invocation failed" },
      "failed",
      body,
      "TOOL_INVOCATION_FAILED",
    );
  }
}

function validateOptions(options: ApprovalHttpOptions): void {
  const loopback = isLoopback(options.host);
  if (!loopback && options.platformApiKey === undefined) {
    throw new Error("MCP_PLATFORM_API_KEY is required when HTTP binds outside loopback.");
  }
  if (!loopback && options.allowedHosts.length === 0) {
    throw new Error("APPROVAL_BACKEND_ALLOWED_HOSTS is required when HTTP binds outside loopback.");
  }
  if (options.platformApiKey !== undefined && Buffer.byteLength(options.platformApiKey, "utf8") < 32) {
    throw new Error("MCP_PLATFORM_API_KEY must contain at least 32 UTF-8 bytes.");
  }
  if (options.auditWriteTimeoutMs !== undefined && (!Number.isInteger(options.auditWriteTimeoutMs) || options.auditWriteTimeoutMs < 1)) {
    throw new Error("auditWriteTimeoutMs must be a positive integer.");
  }
}

function platformToolFromPath(pathname: string): string | undefined {
  const prefix = "/platform/tools/";
  if (!pathname.startsWith(prefix)) return undefined;
  const name = pathname.slice(prefix.length);
  return /^[A-Za-z][A-Za-z0-9_]{0,127}$/u.test(name) ? name : "";
}

function allowedHostSet(options: ApprovalHttpOptions): Set<string> {
  const configured = options.allowedHosts.map(normalizeHost).filter(Boolean);
  if (configured.length > 0) return new Set(configured);
  return new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
}

function hostAllowed(header: string | undefined, allowedHosts: Set<string>): boolean {
  if (header === undefined) return false;
  return allowedHosts.has(normalizeHost(header));
}

function normalizeHost(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end >= 0 ? value.slice(0, end + 1) : value;
  }
  return value.replace(/:\d+$/u, "");
}

function authorized(header: string | undefined, apiKey: string | undefined): boolean {
  if (apiKey === undefined) return true;
  const prefix = "Bearer ";
  if (header === undefined || !header.startsWith(prefix)) return false;
  const supplied = Buffer.from(header.slice(prefix.length), "utf8");
  const expected = Buffer.from(apiKey, "utf8");
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

function isJson(contentType: string | undefined): boolean {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstTextContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const item = content.find(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.type === "text" && typeof candidate.text === "string",
  );
  return typeof item?.text === "string" ? item.text : undefined;
}

function approvalAction(input: Record<string, unknown> | undefined): ToolInvocationAuditEventBase["action"] {
  const action = input?.action;
  return action === "view" || action === "approve" || action === "reject" ? action : undefined;
}

function safeErrorCode(payload: Record<string, unknown>, fallback: string): string {
  const error = isRecord(payload.error) ? payload.error : undefined;
  const code = typeof error?.code === "string" ? error.code : undefined;
  return code !== undefined && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : fallback;
}

function toolErrorOutcome(errorCode: string): ToolInvocationAuditOutcome {
  if (errorCode === "IDEMPOTENCY_OUTCOME_UNKNOWN") return "uncertain";
  return TOOL_FAILURE_CODES.has(errorCode) ? "failed" : "rejected";
}

const TOOL_FAILURE_CODES = new Set([
  "CONFIGURATION_ERROR",
  "DINGTALK_AUTH_ERROR",
  "DINGTALK_API_ERROR",
  "IDEMPOTENCY_LEDGER_ERROR",
  "INTERNAL_ERROR",
  "INVALID_RESPONSE",
]);

const unavailableToolInvocationAuditSink: ToolInvocationAuditSink = {
  record: () => Promise.reject(new Error("Tool invocation audit sink is not configured.")),
};


async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error("JSON request body is too large.");
    chunks.push(buffer);
  }
  if (total === 0) throw new Error("JSON request body is required.");
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
}

function isLoopback(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.toLowerCase());
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}
