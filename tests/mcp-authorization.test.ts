import { createHash, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMcpAuthorization,
  InMemoryAuthorizationStore,
  type DingTalkIdentityPort,
} from "../src/auth/mcp-authorization.js";
import { ApprovalMcpError } from "../src/core/errors.js";
import { JoseMcpTokenCodec } from "../src/auth/jwt-codec.js";
import type { SecurityAuditEventInput } from "../src/auth/security-audit.js";

const resource = "https://dingtalk.mwexk.com/mcp";
const issuer = "https://dingtalk.mwexk.com/";
const redirectUri = "http://127.0.0.1/callback";
const servers: Array<{ close(callback: (error?: Error) => void): void }> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    ),
  );
});

describe("createMcpAuthorization", () => {
  it("publishes only the public-client authentication methods it implements", async () => {
    const { baseUrl } = await fixture();

    const response = await fetch(new URL("/.well-known/oauth-authorization-server", baseUrl));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      issuer,
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
    });
  });

  it("completes DingTalk-backed OAuth with PKCE and protects a resource-bound route", async () => {
    const { baseUrl, securityEvents } = await fixture();
    const client = await registerPublicClient(baseUrl);
    const verifier = "workbuddy-codex-verifier-that-is-long-enough-1234567890";
    const challenge = createHash("sha256").update(verifier).digest("base64url");

    const authorize = new URL("/authorize", baseUrl);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
      scope: "approval:read approval:decide",
      state: "client-state-1",
    }).toString();
    const start = await fetch(authorize, { redirect: "manual" });
    expect(start.status).toBe(200);
    const consentHtml = await start.text();
    expect(consentHtml).toContain("OAuth test client");
    expect(consentHtml).toContain("approval:decide");
    const dingtalkLocation = await submitConsent(baseUrl, consentHtml, "approve");
    expect(dingtalkLocation.origin).toBe("https://login.dingtalk.test");

    const callback = new URL("/oauth/dingtalk/callback", baseUrl);
    callback.searchParams.set("authCode", "valid-dingtalk-code");
    callback.searchParams.set("state", requiredParam(dingtalkLocation, "state"));
    const callbackResponse = await fetch(callback, { redirect: "manual" });
    expect(callbackResponse.status).toBe(302);
    const clientCallback = new URL(requiredHeader(callbackResponse, "location"));
    expect(clientCallback.origin + clientCallback.pathname).toBe(redirectUri);
    expect(clientCallback.searchParams.get("state")).toBe("client-state-1");

    const tokens = await exchangeCode(baseUrl, {
      clientId: client.client_id,
      code: requiredParam(clientCallback, "code"),
      verifier,
    });
    expect(tokens).toMatchObject({
      token_type: "bearer",
      expires_in: 600,
      scope: "approval:read approval:decide",
    });
    expect(typeof tokens.access_token).toBe("string");
    expect(typeof tokens.refresh_token).toBe("string");

    const protectedResponse = await fetch(new URL("/whoami", baseUrl), {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    expect(protectedResponse.status).toBe(200);
    expect(await protectedResponse.json()).toEqual({
      subject: "union-1",
      tenantId: "corp-1",
      userId: "user-1",
      clientId: client.client_id,
      scopes: ["approval:read", "approval:decide"],
      authenticatedAt: 1_800_000_000,
    });
    expect(securityEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "consent_approved", outcome: "succeeded" }),
      expect.objectContaining({ event: "login_succeeded", outcome: "succeeded", subject: "union-1" }),
    ]));
  });

  it("audits the safe DingTalk identity stage when enterprise user mapping fails", async () => {
    const identity = {
      authorizationUrl: vi.fn((state: string) => new URL(`https://login.dingtalk.test/oauth?state=${encodeURIComponent(state)}`)),
      verifyAuthorizationCode: vi.fn(() => Promise.reject(new ApprovalMcpError(
        "DINGTALK_AUTH_ERROR",
        "DingTalk rejected the enterprise identity mapping request.",
        { details: { authStage: "enterprise_user_mapping", upstreamMessage: "must-not-enter-audit" } },
      ))),
    } satisfies DingTalkIdentityPort;
    const { baseUrl, securityEvents } = await fixture(identity);
    const client = await registerPublicClient(baseUrl);
    const verifier = "mapping-failure-verifier-that-is-long-enough-1234567890";
    const authorize = new URL("/authorize", baseUrl);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      resource,
      scope: "approval:read",
    }).toString();
    const login = new URL(requiredHeader(await fetch(authorize, { redirect: "manual" }), "location"));
    const callback = new URL("/oauth/dingtalk/callback", baseUrl);
    callback.searchParams.set("authCode", "mapping-failure-code");
    callback.searchParams.set("state", requiredParam(login, "state"));

    const response = await fetch(callback, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(new URL(requiredHeader(response, "location")).searchParams.get("error")).toBe("access_denied");
    expect(securityEvents).toContainEqual(expect.objectContaining({
      event: "login_failed",
      outcome: "failed",
      reasonCode: "DINGTALK_ENTERPRISE_USER_MAPPING_FAILED",
    }));
    expect(JSON.stringify(securityEvents)).not.toContain("must-not-enter-audit");
  });

  it("does not start DingTalk login when the user denies approval decision scope", async () => {
    const { baseUrl, identity } = await fixture();
    const client = await registerPublicClient(baseUrl);
    const authorize = new URL("/authorize", baseUrl);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: createHash("sha256").update("verifier-that-is-long-enough-1234567890").digest("base64url"),
      code_challenge_method: "S256",
      resource,
      scope: "approval:read approval:decide",
      state: "client-denied-state",
    }).toString();
    const start = await fetch(authorize, { redirect: "manual" });
    const denied = await submitConsent(baseUrl, await start.text(), "deny");

    expect(denied.origin + denied.pathname).toBe(redirectUri);
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.searchParams.get("state")).toBe("client-denied-state");
    expect(identity.authorizationUrl).not.toHaveBeenCalled();
  });

  it("rotates refresh tokens and revokes the family when an old token is replayed", async () => {
    const { baseUrl, securityEvents } = await fixture();
    const client = await registerPublicClient(baseUrl);
    const initial = await completeLogin(baseUrl, client.client_id);

    const refreshed = await refresh(baseUrl, client.client_id, initial.refresh_token);
    expect(refreshed.refresh_token).not.toBe(initial.refresh_token);

    const replay = await fetch(new URL("/token", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: initial.refresh_token,
        resource,
      }),
    });
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });

    const familyRevoked = await fetch(new URL("/token", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: refreshed.refresh_token,
        resource,
      }),
    });
    expect(familyRevoked.status).toBe(400);
    expect(await familyRevoked.json()).toMatchObject({ error: "invalid_grant" });
    expect(securityEvents).toContainEqual(expect.objectContaining({ event: "refresh_replay", outcome: "rejected" }));
  });

  it("audits invalid state, authorization code, refresh target and scope expansion", async () => {
    const { baseUrl, securityEvents } = await fixture();
    const client = await registerPublicClient(baseUrl);

    const invalidState = new URL("/oauth/dingtalk/callback", baseUrl);
    invalidState.searchParams.set("authCode", "valid-dingtalk-code");
    invalidState.searchParams.set("state", "expired-state");
    expect((await fetch(invalidState)).status).toBe(400);

    const invalidCode = await fetch(new URL("/token", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: "expired-code",
        code_verifier: "verifier-that-is-long-enough-1234567890",
        redirect_uri: redirectUri,
        resource,
      }),
    });
    expect(invalidCode.status).toBe(400);

    const targetTokens = await completeLogin(baseUrl, client.client_id);
    const invalidTarget = await fetch(new URL("/token", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: targetTokens.refresh_token,
        resource: "https://dingtalk.mwexk.com/not-mcp",
      }),
    });
    expect(invalidTarget.status).toBe(400);

    const scopeTokens = await completeLogin(baseUrl, client.client_id);
    const expandedScope = await fetch(new URL("/token", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: scopeTokens.refresh_token,
        resource,
        scope: "approval:read approval:decide",
      }),
    });
    expect(expandedScope.status).toBe(400);

    expect(securityEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "authorization_failed", reasonCode: "OAUTH_STATE_INVALID" }),
      expect.objectContaining({ event: "authorization_failed", reasonCode: "AUTHORIZATION_CODE_INVALID" }),
      expect.objectContaining({ event: "authorization_failed", reasonCode: "REFRESH_TARGET_INVALID" }),
      expect.objectContaining({ event: "scope_rejected", reasonCode: "REFRESH_SCOPE_EXPANSION" }),
    ]));
  });

  it("audits OAuth requests rejected by SDK validation before provider exchange", async () => {
    const { baseUrl, securityEvents } = await fixture();
    const client = await registerPublicClient(baseUrl);
    const invalidAuthorize = new URL("/authorize", baseUrl);
    invalidAuthorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      resource,
      state: "invalid-pkce-state",
    }).toString();
    const invalidAuthorizeResponse = await fetch(invalidAuthorize, { redirect: "manual" });
    expect(invalidAuthorizeResponse.status).toBe(302);
    expect(new URL(requiredHeader(invalidAuthorizeResponse, "location")).searchParams.get("error")).toBe("invalid_request");
    expect(securityEvents).toContainEqual(expect.objectContaining({
      event: "authorization_failed",
      reasonCode: "AUTHORIZATION_REQUEST_REJECTED",
    }));

    const verifier = "correct-verifier-that-is-long-enough-1234567890";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = new URL("/authorize", baseUrl);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource,
      scope: "approval:read",
    }).toString();
    const login = new URL(requiredHeader(await fetch(authorize, { redirect: "manual" }), "location"));
    const callback = new URL("/oauth/dingtalk/callback", baseUrl);
    callback.searchParams.set("authCode", "valid-dingtalk-code");
    callback.searchParams.set("state", requiredParam(login, "state"));
    const clientCallback = new URL(requiredHeader(await fetch(callback, { redirect: "manual" }), "location"));

    const rejected = await fetch(new URL("/token", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: requiredParam(clientCallback, "code"),
        code_verifier: "wrong-verifier-that-is-long-enough-1234567890",
        redirect_uri: redirectUri,
        resource,
      }),
    });

    expect(rejected.status).toBe(400);
    expect(securityEvents).toContainEqual(expect.objectContaining({
      event: "authorization_failed",
      reasonCode: "TOKEN_REQUEST_REJECTED",
    }));
  });
});

async function fixture(identityOverride?: DingTalkIdentityPort): Promise<{
  baseUrl: URL;
  securityEvents: SecurityAuditEventInput[];
  identity: DingTalkIdentityPort;
}> {
  const { privateKey } = generateKeyPairSync("ed25519");
  const tokenCodec = await JoseMcpTokenCodec.create({
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    keyId: "test-key",
    issuer,
    audience: resource,
    expectedTenantId: "corp-1",
    accessTokenTtlSeconds: 600,
    now: () => 1_800_000_000,
  });
  const identity = identityOverride ?? {
    authorizationUrl: vi.fn((state: string) => new URL(`https://login.dingtalk.test/oauth?state=${encodeURIComponent(state)}`)),
    verifyAuthorizationCode: async (code) => {
      if (code !== "valid-dingtalk-code") throw new Error("invalid code");
      return {
        subject: "union-1",
        tenantId: "corp-1",
        userId: "user-1",
        authenticatedAt: 1_800_000_000,
      };
    },
  } satisfies DingTalkIdentityPort;
  const securityEvents: SecurityAuditEventInput[] = [];
  const auth = createMcpAuthorization({
    issuerUrl: new URL(issuer),
    resourceUrl: new URL(resource),
    expectedCorpId: "corp-1",
    redirectUrl: new URL("https://dingtalk.mwexk.com/oauth/dingtalk/callback"),
    allowedScopes: ["approval:read", "approval:decide"],
    accessTokenTtlSeconds: 600,
    refreshTokenTtlSeconds: 28_800,
    transactionTtlSeconds: 300,
    identity,
    store: new InMemoryAuthorizationStore({ now: () => 1_800_000_000 }),
    tokenCodec,
    securityAudit: { record: (event) => { securityEvents.push(event); } },
    now: () => 1_800_000_000,
  });
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  app.use(auth.router);
  app.get("/whoami", auth.requireAccess(["approval:read"]), (request, response) => {
    const principal = auth.principal((request as typeof request & { auth: AuthInfo }).auth);
    response.json(principal);
  });
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return { baseUrl: new URL(`http://127.0.0.1:${address.port}`), securityEvents, identity };
}

async function submitConsent(baseUrl: URL, html: string, decision: "approve" | "deny"): Promise<URL> {
  const token = /name="consent_token" value="([^"]+)"/u.exec(html)?.[1];
  if (token === undefined) throw new Error(`Missing consent token: ${html}`);
  const response = await fetch(new URL("/oauth/consent", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ consent_token: token, decision }),
  });
  expect(response.status).toBe(302);
  return new URL(requiredHeader(response, "location"));
}

async function registerPublicClient(baseUrl: URL): Promise<{ client_id: string }> {
  const response = await fetch(new URL("/register", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "OAuth test client",
    }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ client_id: string }>;
}

async function completeLogin(baseUrl: URL, clientId: string): Promise<{ access_token: string; refresh_token: string }> {
  const verifier = "another-verifier-that-is-long-enough-1234567890";
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL("/authorize", baseUrl);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
    scope: "approval:read",
  }).toString();
  const start = await fetch(authorize, { redirect: "manual" });
  const login = new URL(requiredHeader(start, "location"));
  const callback = new URL("/oauth/dingtalk/callback", baseUrl);
  callback.searchParams.set("authCode", "valid-dingtalk-code");
  callback.searchParams.set("state", requiredParam(login, "state"));
  const completed = await fetch(callback, { redirect: "manual" });
  const target = new URL(requiredHeader(completed, "location"));
  return exchangeCode(baseUrl, { clientId, code: requiredParam(target, "code"), verifier });
}

async function exchangeCode(
  baseUrl: URL,
  input: { clientId: string; code: string; verifier: string },
): Promise<{ access_token: string; refresh_token: string; [key: string]: unknown }> {
  const response = await fetch(new URL("/token", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: input.clientId,
      code: input.code,
      code_verifier: input.verifier,
      redirect_uri: redirectUri,
      resource,
    }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ access_token: string; refresh_token: string; [key: string]: unknown }>;
}

async function refresh(
  baseUrl: URL,
  clientId: string,
  refreshToken: string,
): Promise<{ access_token: string; refresh_token: string }> {
  const response = await fetch(new URL("/token", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
      resource,
    }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ access_token: string; refresh_token: string }>;
}

function requiredHeader(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (value === null) throw new Error(`Missing ${name} response header.`);
  return value;
}

function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (value === null) throw new Error(`Missing ${name} URL parameter.`);
  return value;
}
