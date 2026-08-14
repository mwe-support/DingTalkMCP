import type { Server } from "node:http";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { NextFunction, Request, Response } from "express";

import type { ApprovalService } from "../approval/service.js";
import type { McpAuthorizationModule } from "../auth/mcp-authorization.js";
import type { AuditPseudonymizer } from "../auth/security-audit.js";
import { createApprovalMcpServer } from "../mcp/create-server.js";
import type { AuditInvocationContext, ToolInvocationAuditSink } from "../core/audit-log.js";

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

  const requireMcpAccess = options.auth.requireAccess(["approval:read"]);
  const requireTrustedOrigin = trustedOriginMiddleware(options.allowedOrigins);
  app.post("/mcp", requireTrustedOrigin, requireMcpAccess, async (request, response) => {
    await handleMcpRequest(service, options, request, response);
  });
  app.get("/mcp", requireMcpAccess, methodNotAllowed);
  app.delete("/mcp", requireMcpAccess, methodNotAllowed);

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
