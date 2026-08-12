import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import type { ApprovalService } from "../approval/service.js";
import { createApprovalMcpServer } from "../mcp/create-server.js";

export interface ApprovalHttpOptions {
  host: string;
  port: number;
  apiKey: string | undefined;
  allowedHosts: string[];
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

  const requestUrl = new URL(request.url ?? "/", "http://mcp.invalid");
  if (requestUrl.pathname === "/healthz" && request.method === "GET") {
    json(response, 200, { status: "ok", service: "mwe-dingtalk-approval-mcp" });
    return;
  }

  if (requestUrl.pathname !== "/mcp") {
    json(response, 404, { error: "Not Found" });
    return;
  }
  if (!authorized(request.headers.authorization, options.apiKey)) {
    response.setHeader("www-authenticate", "Bearer");
    json(response, 401, { error: "Unauthorized" });
    return;
  }
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    jsonRpcError(response, 405, -32000, "Method not allowed.");
    return;
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, 1024 * 1024);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON request body";
    jsonRpcError(response, 400, -32700, message);
    return;
  }

  const server = createApprovalMcpServer(service);
  const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    void Promise.allSettled([transport.close(), server.close()]);
  };
  response.once("close", cleanup);
  response.once("finish", cleanup);
  try {
    // SDK 1.30.0's optional callback declarations conflict with exactOptionalPropertyTypes.
    await server.connect(transport as unknown as Parameters<typeof server.connect>[0]);
    await transport.handleRequest(request, response, body);
  } catch {
    cleanup();
    if (!response.headersSent) {
      jsonRpcError(response, 500, -32603, "Internal server error.");
    }
  }
}

function validateOptions(options: ApprovalHttpOptions): void {
  const loopback = isLoopback(options.host);
  if (!loopback && options.apiKey === undefined) {
    throw new Error("MCP_HTTP_API_KEY is required when HTTP binds outside loopback.");
  }
  if (!loopback && options.allowedHosts.length === 0) {
    throw new Error("MCP_HTTP_ALLOWED_HOSTS is required when HTTP binds outside loopback.");
  }
  if (options.apiKey !== undefined && Buffer.byteLength(options.apiKey, "utf8") < 32) {
    throw new Error("MCP_HTTP_API_KEY must contain at least 32 UTF-8 bytes.");
  }
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

function jsonRpcError(response: ServerResponse, status: number, code: number, message: string): void {
  json(response, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}
