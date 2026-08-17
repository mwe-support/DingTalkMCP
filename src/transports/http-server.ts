import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { ApprovalService } from "../approval/service.js";
import type { McpAuthorizationModule } from "../auth/mcp-authorization.js";
import type { AuditPseudonymizer } from "../auth/security-audit.js";
import type { McpScope } from "../auth/types.js";
import { approvalToolAction, type ApprovalToolAction } from "../core/tool-action.js";
import { createApprovalMcpServer } from "../mcp/create-server.js";
import {
  DEFAULT_AUDIT_WRITE_TIMEOUT_MS,
  runAuditWriteWithinTimeout,
  type AuditInvocationContext,
  type ToolInvocationAuditEventBase,
  type ToolInvocationAuditSink,
} from "../core/audit-log.js";

export interface ApprovalHttpOptions {
  host: string;
  port: number;
  allowedHosts: string[];
  allowedOrigins: string[];
  auth: McpAuthorizationModule;
  toolAudit?: ToolInvocationAuditSink;
  auditContext?: AuditInvocationContext;
  auditPseudonymizer?: AuditPseudonymizer;
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
  const app = createMcpExpressApp({
    host: options.host,
    ...(options.allowedHosts.length === 0 ? {} : { allowedHosts: options.allowedHosts }),
  });
  // The production path is exactly one HTTP reverse proxy (edge-nginx) in
  // front of this loopback-published container port. This preserves the
  // original client address for the SDK OAuth endpoint rate limiters.
  app.set("trust proxy", 1);

  app.use(options.auth.router);
  app.get("/healthz", (_request, response) => {
    response.json({ status: "ok", service: "mwe-dingtalk-approval-mcp", transport: "streamable-http" });
  });

  const requireReadAccess = options.auth.requireAccess(["approval:read"]);
  const requireActionAccess = actionAwareMcpAccess(options);
  const requireTrustedOrigin = trustedOriginMiddleware(options.allowedOrigins);
  app.post("/mcp", requireTrustedOrigin, requireReadAccess, requireActionAccess, async (request, response) => {
    await handleMcpRequest(service, options, request, response);
  });
  app.get("/mcp", requireReadAccess, methodNotAllowed);
  app.delete("/mcp", requireReadAccess, methodNotAllowed);

  const httpServer = app.listen(options.port, options.host);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("listening", resolve);
    httpServer.once("error", reject);
  });

  return {
    httpServer,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error === undefined ? resolve() : reject(error));
      }),
  };
}

function actionAwareMcpAccess(options: ApprovalHttpOptions): RequestHandler {
  return async (request, response, next) => {
    const inspection = inspectRequestScopes(request.body);
    const authInfo = (request as Request & { auth?: AuthInfo }).auth;
    if (authInfo === undefined) {
      response.status(401).json({ error: "invalid_token" });
      return;
    }
    const principal = options.auth.principal(authInfo);
    const missingScopes = inspection.requiredScopes.filter((scope) => !principal.scopes.includes(scope));
    if (missingScopes.length === 0) {
      next();
      return;
    }
    const challengedInvocations = inspection.invocations.filter((invocation) =>
      invocation.requiredScopes.some((scope) => missingScopes.includes(scope))
    );
    const auditStatus = await auditScopeRejections(options, principal.tenantId, principal.subject, challengedInvocations);
    if (auditStatus === "unavailable") {
      response.status(503).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Structured audit logging is unavailable." },
        id: jsonRpcId(request.body),
      });
      return;
    }
    if (auditStatus === "partial") response.setHeader("x-mcp-audit-status", "partial");
    options.auth.requireAccess(inspection.requiredScopes)(request, response, next);
  };
}

interface ScopeChallengedInvocation {
  toolName: "approval_task" | "approval_request";
  action?: ApprovalToolAction;
  requiredScopes: McpScope[];
}

function inspectRequestScopes(body: unknown): {
  requiredScopes: McpScope[];
  invocations: ScopeChallengedInvocation[];
} {
  const messages = Array.isArray(body) ? body : [body];
  let requiresDecision = false;
  let requiresCreation = false;
  const invocations: ScopeChallengedInvocation[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.method !== "tools/call" || !isRecord(message.params)) continue;
    const rawArguments = isRecord(message.params.arguments) ? message.params.arguments : undefined;
    const action = approvalToolAction(rawArguments?.action);
    if (message.params.name === "approval_request") {
      requiresCreation = true;
      invocations.push({
        toolName: "approval_request",
        ...(action === undefined ? {} : { action }),
        requiredScopes: ["approval:read", "approval:create"],
      });
      continue;
    }
    if (message.params.name !== "approval_task" || (action !== "approve" && action !== "reject")) continue;
    requiresDecision = true;
    invocations.push({
      toolName: "approval_task",
      action,
      requiredScopes: ["approval:read", "approval:decide"],
    });
  }
  return {
    requiredScopes: [
      "approval:read",
      ...(requiresDecision ? ["approval:decide" as const] : []),
      ...(requiresCreation ? ["approval:create" as const] : []),
    ],
    invocations,
  };
}

async function auditScopeRejections(
  options: ApprovalHttpOptions,
  tenantId: string,
  subject: string,
  invocations: ScopeChallengedInvocation[],
): Promise<"complete" | "partial" | "unavailable"> {
  if (options.toolAudit === undefined || invocations.length === 0) return "complete";
  const subjectHash = options.auditPseudonymizer?.subject(tenantId, subject);
  let partial = false;
  for (const invocation of invocations) {
    const startedAt = performance.now();
    const base: ToolInvocationAuditEventBase = {
      timestamp: new Date().toISOString(),
      invocationId: randomUUID(),
      transport: "streamable_http",
      toolName: invocation.toolName,
      ...(subjectHash === undefined ? {} : { subjectHash }),
      ...(invocation.action === undefined ? {} : { action: invocation.action }),
    };
    try {
      await runAuditWriteWithinTimeout(
        () => options.toolAudit?.record({ ...base, phase: "started" }),
        DEFAULT_AUDIT_WRITE_TIMEOUT_MS,
      );
    } catch {
      return "unavailable";
    }
    try {
      await runAuditWriteWithinTimeout(
        () => options.toolAudit?.record({
          ...base,
          timestamp: new Date().toISOString(),
          phase: "completed",
          outcome: "rejected",
          httpStatus: 403,
          durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
          auditStatus: "complete",
          errorCode: "INSUFFICIENT_SCOPE",
        }),
        DEFAULT_AUDIT_WRITE_TIMEOUT_MS,
      );
    } catch {
      partial = true;
    }
  }
  return partial ? "partial" : "complete";
}

function jsonRpcId(body: unknown): unknown {
  return isRecord(body) && (typeof body.id === "string" || typeof body.id === "number" || body.id === null)
    ? body.id
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function handleMcpRequest(
  service: ApprovalService,
  options: ApprovalHttpOptions,
  request: Request,
  response: Response,
): Promise<void> {
  const authInfo = (request as Request & { auth?: AuthInfo }).auth;
  if (authInfo === undefined) {
    response.status(401).json({ error: "invalid_token" });
    return;
  }
  const principal = options.auth.principal(authInfo);
  const callerService = service.forCaller({
    tenantId: principal.tenantId,
    subject: principal.subject,
    userId: principal.userId,
    scopes: principal.scopes,
  });
  const server = createApprovalMcpServer(callerService, {
    ...(options.toolAudit === undefined ? {} : { toolAudit: options.toolAudit }),
    ...(options.auditContext === undefined ? {} : { auditContext: options.auditContext }),
    ...(options.auditPseudonymizer === undefined
      ? {}
      : { auditSubjectHash: options.auditPseudonymizer.subject(principal.tenantId, principal.subject) }),
  });
  const transport = new StreamableHTTPServerTransport();
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    void transport.close();
    void server.close();
  };
  response.once("close", close);
  try {
    // SDK 1.30's transport declarations are not exactOptionalPropertyTypes-safe,
    // although this is the SDK's documented Node Streamable HTTP transport.
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(request, response, request.body);
  } catch {
    close();
    if (!response.headersSent) {
      response.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal MCP server error" },
        id: null,
      });
    }
  }
}

function methodNotAllowed(_request: Request, response: Response): void {
  response.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed for stateless Streamable HTTP." },
    id: null,
  });
}

function validateOptions(options: ApprovalHttpOptions): void {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error("port must be an integer between 0 and 65535.");
  }
  if (!isLoopback(options.host) && options.allowedHosts.length === 0) {
    throw new Error("APPROVAL_BACKEND_ALLOWED_HOSTS is required when HTTP binds outside loopback.");
  }
  for (const origin of options.allowedOrigins) {
    const url = new URL(origin);
    if (url.origin !== origin || url.protocol !== "https:") {
      throw new Error("allowedOrigins entries must be canonical HTTPS origins.");
    }
  }
}

function trustedOriginMiddleware(allowedOrigins: string[]) {
  const trusted = new Set(allowedOrigins);
  return (request: Request, response: Response, next: NextFunction): void => {
    const origin = request.get("origin");
    if (origin !== undefined && !trusted.has(origin)) {
      response.status(403).json({ error: "invalid_origin" });
      return;
    }
    next();
  };
}

function isLoopback(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host.toLowerCase());
}
