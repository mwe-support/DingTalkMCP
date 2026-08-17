import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApprovalService } from "../src/approval/service.js";
import { JoseMcpTokenCodec } from "../src/auth/jwt-codec.js";
import { createMcpAuthorization, InMemoryAuthorizationStore } from "../src/auth/mcp-authorization.js";
import type { DingTalkApiClient } from "../src/dingtalk/client.js";
import { startApprovalHttpServer, type RunningApprovalHttpServer } from "../src/transports/http-server.js";
import { APPROVAL_MCP_VERSION } from "../src/version.js";

const resource = "https://dingtalk.mwexk.com/mcp";
const running: RunningApprovalHttpServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

describe("self-hosted Streamable HTTP transport", () => {
  it("exposes the current server version without caching MCP discovery", async () => {
    const { baseUrl, accessToken } = await fixture();

    const health = await fetch(new URL("/healthz", baseUrl));
    expect(health.headers.get("cache-control")).toBe("no-store");
    await expect(health.json()).resolves.toMatchObject({
      status: "ok",
      version: APPROVAL_MCP_VERSION,
      toolsRevision: APPROVAL_MCP_VERSION,
    });

    const initialized = await mcpRequest(baseUrl, initializeRequest(), accessToken);
    expect(initialized.headers.get("cache-control")).toContain("no-cache");
    expect(initialized.headers.get("x-mcp-server-version")).toBe(APPROVAL_MCP_VERSION);
    expect(initialized.headers.get("x-mcp-tools-revision")).toBe(APPROVAL_MCP_VERSION);
    expect(await jsonRpcBody(initialized)).toMatchObject({
      result: { serverInfo: { version: APPROVAL_MCP_VERSION } },
    });
  });

  it("advertises OAuth metadata and rejects unauthenticated MCP requests", async () => {
    const { baseUrl } = await fixture();

    const metadata = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", baseUrl));
    expect(metadata.status).toBe(200);
    await expect(metadata.json()).resolves.toMatchObject({
      resource,
      authorization_servers: ["https://dingtalk.mwexk.com/"],
      scopes_supported: ["approval:read", "approval:decide", "approval:create"],
    });

    const response = await mcpRequest(baseUrl, initializeRequest(), undefined);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://dingtalk.mwexk.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(response.headers.get("www-authenticate")).not.toContain("scope=");
  });

  it("serves initialize, tools/list and an OAuth-bound approval_task call", async () => {
    const { baseUrl, accessToken, request } = await fixture();

    const initialized = await mcpRequest(baseUrl, initializeRequest(), accessToken);
    expect(initialized.status).toBe(200);
    expect(await jsonRpcBody(initialized)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { serverInfo: { name: "mwe-dingtalk-approval-mcp" } },
    });

    const listed = await mcpRequest(
      baseUrl,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      accessToken,
    );
    expect((await jsonRpcBody(listed)) as Record<string, unknown>).toMatchObject({
      result: { tools: [{ name: "approval_task" }, { name: "approval_request" }] },
    });

    const called = await mcpRequest(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "approval_task",
          arguments: { action: "view", processInstanceId: "pi-oauth-1" },
        },
      },
      accessToken,
    );
    const payload = await jsonRpcBody(called) as {
      result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
    };
    expect(payload.result?.isError).not.toBe(true);
    expect(payload.result?.structuredContent).toMatchObject({
      result: {
        processInstanceId: "pi-oauth-1",
        safeNextActions: ["view", "approve", "reject"],
      },
    });
    expect(request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1.0/workflow/processInstances",
      query: { processInstanceId: "pi-oauth-1" },
    });
  });

  it("challenges approval_request calls for the incremental create scope", async () => {
    const { baseUrl, accessToken, auditEvents } = await fixture();

    const response = await mcpRequest(
      baseUrl,
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "approval_request",
          arguments: { action: "prepare", template: "expense_reimbursement" },
        },
      },
      accessToken,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
    expect(response.headers.get("www-authenticate")).toContain('scope="approval:read approval:create"');
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://dingtalk.mwexk.com/.well-known/oauth-protected-resource/mcp"',
    );
    expect(auditEvents).toEqual([
      expect.objectContaining({ phase: "started", toolName: "approval_request", action: "prepare" }),
      expect.objectContaining({
        phase: "completed",
        toolName: "approval_request",
        action: "prepare",
        outcome: "rejected",
        httpStatus: 403,
        errorCode: "INSUFFICIENT_SCOPE",
      }),
    ]);
  });

  it("challenges approval decisions for the incremental decide scope", async () => {
    const { baseUrl, readOnlyAccessToken } = await fixture();

    for (const action of ["approve", "reject"]) {
      const response = await mcpRequest(
        baseUrl,
        {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "approval_task",
            arguments: { action, processInstanceId: "pi-oauth-1", confirm: true },
          },
        },
        readOnlyAccessToken,
      );

      expect(response.status).toBe(403);
      expect(response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
      expect(response.headers.get("www-authenticate")).toContain('scope="approval:read approval:decide"');
    }
  });

  it("does not expose the retired DingTalk platform route", async () => {
    const { baseUrl, accessToken } = await fixture();
    const response = await fetch(new URL("/platform/tools/approval_task", baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ action: "view", processInstanceId: "pi-1" }),
    });

    expect(response.status).toBe(404);
  });

  it("rejects browser requests from an untrusted Origin", async () => {
    const { baseUrl, accessToken } = await fixture();
    const response = await fetch(new URL("/mcp", baseUrl), {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify(initializeRequest()),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "invalid_origin" });
  });

  it("rate-limits dynamic registration per forwarded client IP", async () => {
    const { baseUrl } = await fixture();

    for (let index = 0; index < 20; index += 1) {
      expect((await registerFrom(baseUrl, "198.51.100.10", index)).status).toBe(201);
    }
    expect((await registerFrom(baseUrl, "198.51.100.10", 20)).status).toBe(429);
    expect((await registerFrom(baseUrl, "198.51.100.11", 21)).status).toBe(201);
  });

  it("returns the stateless MCP method response for authenticated GET and DELETE", async () => {
    const { baseUrl, accessToken } = await fixture();

    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(new URL("/mcp", baseUrl), {
        method,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(response.status).toBe(405);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: "Method not allowed for stateless Streamable HTTP." },
      });
    }
  });
});

async function fixture(): Promise<{
  baseUrl: URL;
  accessToken: string;
  readOnlyAccessToken: string;
  request: ReturnType<typeof vi.fn>;
  auditEvents: Array<Record<string, unknown>>;
}> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const codec = await JoseMcpTokenCodec.create({
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    keyId: "test-key",
    issuer: "https://dingtalk.mwexk.com/",
    audience: resource,
    expectedTenantId: "corp-1",
    accessTokenTtlSeconds: 600,
  });
  const auth = createMcpAuthorization({
    issuerUrl: new URL("https://dingtalk.mwexk.com/"),
    resourceUrl: new URL(resource),
    redirectUrl: new URL("https://dingtalk.mwexk.com/oauth/dingtalk/callback"),
    expectedCorpId: "corp-1",
    allowedScopes: ["approval:read", "approval:decide", "approval:create"],
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 28_800,
    transactionTtlSeconds: 300,
    identity: {
      authorizationUrl: (state) => new URL(`https://login.dingtalk.test/oauth?state=${state}`),
      verifyAuthorizationCode: () => Promise.reject(new Error("not used")),
    },
    store: new InMemoryAuthorizationStore(),
    tokenCodec: codec,
  });
  const accessToken = await codec.issue({
    principal: {
      subject: "union-1",
      tenantId: "corp-1",
      userId: "user-1",
      authenticatedAt: Math.floor(Date.now() / 1000),
    },
    clientId: "real-client-test",
    scopes: ["approval:read", "approval:decide"],
  });
  const readOnlyAccessToken = await codec.issue({
    principal: {
      subject: "union-1",
      tenantId: "corp-1",
      userId: "user-1",
      authenticatedAt: Math.floor(Date.now() / 1000),
    },
    clientId: "read-only-client-test",
    scopes: ["approval:read"],
  });
  const request = vi.fn().mockResolvedValue({
    result: {
      processInstanceId: "pi-oauth-1",
      status: "RUNNING",
      originatorUserId: "originator-1",
      tasks: [{ taskId: "task-1", userId: "user-1", status: "RUNNING" }],
      operationRecords: [],
      formComponentValues: [],
    },
  });
  const auditEvents: Array<Record<string, unknown>> = [];
  const server = await startApprovalHttpServer(
    new ApprovalService({ api: { request } as unknown as Pick<DingTalkApiClient, "request"> }),
    {
      host: "127.0.0.1",
      port: 0,
      allowedHosts: [],
      allowedOrigins: ["https://dingtalk.mwexk.com"],
      auth,
      toolAudit: { record: (event) => void auditEvents.push(event as unknown as Record<string, unknown>) },
    },
  );
  running.push(server);
  const address = server.httpServer.address() as AddressInfo;
  return {
    baseUrl: new URL(`http://127.0.0.1:${address.port}`),
    accessToken,
    readOnlyAccessToken,
    request,
    auditEvents,
  };
}

function initializeRequest(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "real-client-test", version: "1.0.0" },
    },
  };
}

function mcpRequest(baseUrl: URL, body: unknown, accessToken: string | undefined): Promise<Response> {
  return fetch(new URL("/mcp", baseUrl), {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
    },
    body: JSON.stringify(body),
  });
}

async function jsonRpcBody(response: Response): Promise<unknown> {
  const body = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = body.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    if (data === undefined) throw new Error(`Missing SSE data: ${body}`);
    return JSON.parse(data) as unknown;
  }
  return JSON.parse(body) as unknown;
}

function registerFrom(baseUrl: URL, clientIp: string, index: number): Promise<Response> {
  return fetch(new URL("/register", baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": clientIp,
    },
    body: JSON.stringify({
      redirect_uris: [`http://127.0.0.1/callback/${index}`],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: `rate-limit-test-${index}`,
    }),
  });
}
