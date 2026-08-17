import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { RequestHandler, Router } from "express";
import express from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  AccessDeniedError,
  InsufficientScopeError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidScopeError,
  InvalidTargetError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { JoseMcpTokenCodec, TokenIdentity } from "./jwt-codec.js";
import { MCP_SCOPES, principalFromAuthInfo, type McpPrincipal, type McpScope } from "./types.js";
import type { SecurityAuditEventInput, SecurityAuditSink } from "./security-audit.js";
import { ApprovalMcpError } from "../core/errors.js";

export interface DingTalkIdentityPort {
  authorizationUrl(state: string): URL;
  verifyAuthorizationCode(code: string): Promise<TokenIdentity>;
}

export interface AuthorizationTransaction {
  clientId: string;
  clientState?: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: McpScope[];
  expiresAt: number;
}

export interface AuthorizationCodeRecord extends AuthorizationTransaction {
  principal: TokenIdentity;
}

export interface RefreshTokenRecord {
  familyId: string;
  clientId: string;
  resource: string;
  scopes: McpScope[];
  principal: TokenIdentity;
  expiresAt: number;
}

export type RefreshConsumeResult =
  | { status: "active"; record: RefreshTokenRecord }
  | { status: "replayed" }
  | { status: "missing" };

export interface AuthorizationStore extends OAuthRegisteredClientsStore {
  prune(): Promise<void>;
  putTransaction(state: string, transaction: AuthorizationTransaction): Promise<void>;
  consumeTransaction(state: string): Promise<AuthorizationTransaction | undefined>;
  putAuthorizationCode(code: string, record: AuthorizationCodeRecord): Promise<void>;
  getAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined>;
  consumeAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined>;
  putRefreshToken(token: string, record: RefreshTokenRecord): Promise<void>;
  consumeRefreshToken(token: string): Promise<RefreshConsumeResult>;
  isRefreshFamilyRevoked(familyId: string): Promise<boolean>;
  revokeRefreshToken(token: string): Promise<void>;
}

export interface InMemoryAuthorizationStoreOptions {
  now?: () => number;
  maximumClients?: number;
  clientTtlSeconds?: number;
}

export const DEFAULT_DYNAMIC_CLIENT_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MAX_DYNAMIC_CLIENT_METADATA_BYTES = 16 * 1024;

interface StoredClient {
  client: OAuthClientInformationFull;
  expiresAt: number;
}

export class InMemoryAuthorizationStore implements AuthorizationStore {
  readonly #clients = new Map<string, StoredClient>();
  readonly #transactions = new Map<string, AuthorizationTransaction>();
  readonly #codes = new Map<string, AuthorizationCodeRecord>();
  readonly #refresh = new Map<string, RefreshTokenRecord>();
  readonly #spentRefresh = new Map<string, string>();
  readonly #revokedFamilies = new Set<string>();
  readonly #now: () => number;
  readonly #maximumClients: number;
  readonly #clientTtlSeconds: number;

  constructor(options: InMemoryAuthorizationStoreOptions = {}) {
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#maximumClients = options.maximumClients ?? 1000;
    this.#clientTtlSeconds = options.clientTtlSeconds ?? DEFAULT_DYNAMIC_CLIENT_TTL_SECONDS;
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    this.#prune();
    const stored = this.#clients.get(clientId);
    if (stored === undefined) return undefined;
    stored.expiresAt = this.#now() + this.#clientTtlSeconds;
    return structuredClone(stored.client);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    const full = client as OAuthClientInformationFull;
    validateDynamicClientRegistration(full);
    this.#prune();
    if (this.#clients.size >= this.#maximumClients && !this.#clients.has(full.client_id)) {
      throw new InvalidClientMetadataError("The dynamic client registration limit has been reached.");
    }
    this.#clients.set(full.client_id, {
      client: structuredClone(full),
      expiresAt: this.#now() + this.#clientTtlSeconds,
    });
    return structuredClone(full);
  }

  async prune(): Promise<void> {
    this.#prune();
  }

  async putTransaction(state: string, transaction: AuthorizationTransaction): Promise<void> {
    this.#transactions.set(hash(state), transaction);
  }

  async consumeTransaction(state: string): Promise<AuthorizationTransaction | undefined> {
    const key = hash(state);
    const transaction = this.#transactions.get(key);
    this.#transactions.delete(key);
    return transaction !== undefined && transaction.expiresAt >= this.#now() ? transaction : undefined;
  }

  async putAuthorizationCode(code: string, record: AuthorizationCodeRecord): Promise<void> {
    this.#codes.set(hash(code), record);
  }

  async getAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    const record = this.#codes.get(hash(code));
    return record !== undefined && record.expiresAt >= this.#now() ? record : undefined;
  }

  async consumeAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    const key = hash(code);
    const record = this.#codes.get(key);
    this.#codes.delete(key);
    return record !== undefined && record.expiresAt >= this.#now() ? record : undefined;
  }

  async putRefreshToken(token: string, record: RefreshTokenRecord): Promise<void> {
    this.#refresh.set(hash(token), record);
  }

  async consumeRefreshToken(token: string): Promise<RefreshConsumeResult> {
    const key = hash(token);
    const record = this.#refresh.get(key);
    if (record !== undefined) {
      this.#refresh.delete(key);
      this.#spentRefresh.set(key, record.familyId);
      if (record.expiresAt < this.#now() || this.#revokedFamilies.has(record.familyId)) {
        return { status: "missing" };
      }
      return { status: "active", record };
    }
    const replayedFamily = this.#spentRefresh.get(key);
    if (replayedFamily !== undefined) {
      this.#revokedFamilies.add(replayedFamily);
      return { status: "replayed" };
    }
    return { status: "missing" };
  }

  async isRefreshFamilyRevoked(familyId: string): Promise<boolean> {
    return this.#revokedFamilies.has(familyId);
  }

  async revokeRefreshToken(token: string): Promise<void> {
    const key = hash(token);
    const familyId = this.#refresh.get(key)?.familyId ?? this.#spentRefresh.get(key);
    if (familyId !== undefined) this.#revokedFamilies.add(familyId);
  }

  #prune(): void {
    const now = this.#now();
    for (const [clientId, stored] of this.#clients) {
      if (stored.expiresAt < now) this.#clients.delete(clientId);
    }
  }
}

export interface CreateMcpAuthorizationOptions {
  issuerUrl: URL;
  resourceUrl: URL;
  redirectUrl: URL;
  expectedCorpId: string;
  allowedScopes: readonly McpScope[];
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  transactionTtlSeconds: number;
  identity: DingTalkIdentityPort;
  store: AuthorizationStore;
  tokenCodec: JoseMcpTokenCodec;
  securityAudit?: SecurityAuditSink;
  now?: () => number;
  randomToken?: () => string;
}

export interface McpAuthorizationModule {
  readonly router: Router;
  requireAccess(scopes?: readonly McpScope[]): RequestHandler;
  principal(auth: AuthInfo): McpPrincipal;
}

export function createMcpAuthorization(options: CreateMcpAuthorizationOptions): McpAuthorizationModule {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const randomToken = options.randomToken ?? (() => randomBytes(32).toString("base64url"));
  const provider = new DingTalkBackedOAuthProvider(options, now, randomToken);
  const router = express.Router();

  router.use("/authorize", auditRejectedOAuthResponse(options.securityAudit, "AUTHORIZATION_REQUEST_REJECTED"));
  router.use("/token", auditRejectedOAuthResponse(options.securityAudit, "TOKEN_REQUEST_REJECTED"));

  router.get("/oauth/dingtalk/callback", async (request, response) => {
    response.setHeader("cache-control", "no-store");
    const state = singleQueryValue(request.query.state);
    const authCode = singleQueryValue(request.query.authCode);
    if (state === undefined || authCode === undefined) {
      await recordSecurity(options.securityAudit, {
        event: "authorization_failed",
        outcome: "rejected",
        reasonCode: "OAUTH_CALLBACK_INVALID",
      }).catch(() => undefined);
      response.status(400).json({ error: "invalid_request", error_description: "Missing DingTalk OAuth callback data." });
      return;
    }
    const transaction = await options.store.consumeTransaction(state);
    if (transaction === undefined) {
      await recordSecurity(options.securityAudit, {
        event: "authorization_failed",
        outcome: "rejected",
        reasonCode: "OAUTH_STATE_INVALID",
      }).catch(() => undefined);
      response.status(400).json({ error: "invalid_request", error_description: "OAuth state is invalid or expired." });
      return;
    }
    try {
      const principal = await options.identity.verifyAuthorizationCode(authCode);
      if (principal.tenantId !== options.expectedCorpId) {
        await recordSecurity(options.securityAudit, {
          event: "tenant_mismatch",
          outcome: "rejected",
          tenantId: principal.tenantId,
          subject: principal.subject,
          clientId: transaction.clientId,
          reasonCode: "TENANT_MISMATCH",
        });
        throw new AccessDeniedError("The DingTalk user does not belong to the configured enterprise.");
      }
      await recordSecurity(options.securityAudit, {
        event: "login_succeeded",
        outcome: "succeeded",
        tenantId: principal.tenantId,
        subject: principal.subject,
        clientId: transaction.clientId,
      });
      const localCode = randomToken();
      await options.store.putAuthorizationCode(localCode, { ...transaction, principal });
      const target = new URL(transaction.redirectUri);
      target.searchParams.set("code", localCode);
      if (transaction.clientState !== undefined) target.searchParams.set("state", transaction.clientState);
      response.redirect(302, target.href);
    } catch (error) {
      await recordSecurity(options.securityAudit, {
        event: "login_failed",
        outcome: "failed",
        clientId: transaction.clientId,
        reasonCode: dingTalkIdentityFailureReasonCode(error),
      }).catch(() => undefined);
      const target = new URL(transaction.redirectUri);
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("error_description", "DingTalk identity verification failed.");
      if (transaction.clientState !== undefined) target.searchParams.set("state", transaction.clientState);
      response.redirect(302, target.href);
    }
  });

  const oauthMetadata = {
    ...createOAuthMetadata({
      provider,
      issuerUrl: options.issuerUrl,
      scopesSupported: [...options.allowedScopes],
    }),
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
  };
  router.get("/.well-known/oauth-authorization-server", (_request, response) => {
    response.setHeader("access-control-allow-origin", "*");
    response.status(200).json(oauthMetadata);
  });

  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: options.issuerUrl,
      resourceServerUrl: options.resourceUrl,
      scopesSupported: [...options.allowedScopes],
      resourceName: "MWE审批MCP",
      clientRegistrationOptions: {
        clientSecretExpirySeconds: 0,
      },
    }),
  );

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(options.resourceUrl);
  return {
    router,
    requireAccess: (scopes = []) => scopedBearerAuth(provider, scopes, resourceMetadataUrl),
    principal: principalFromAuthInfo,
  };
}

function scopedBearerAuth(
  verifier: DingTalkBackedOAuthProvider,
  requiredScopes: readonly McpScope[],
  resourceMetadataUrl: string,
): RequestHandler {
  const verifyBearer = requireBearerAuth({ verifier, resourceMetadataUrl });
  return async (request, response, next) => {
    await verifyBearer(request, response, (error?: unknown) => {
      if (error !== undefined) {
        next(error);
        return;
      }
      const authInfo = request.auth;
      if (authInfo === undefined) {
        response.status(500).json({ error: "server_error", error_description: "Bearer verification failed." });
        return;
      }
      if (requiredScopes.every((scope) => authInfo.scopes.includes(scope))) {
        next();
        return;
      }
      const insufficientScope = new InsufficientScopeError("Insufficient scope");
      response.setHeader(
        "WWW-Authenticate",
        `Bearer error="${insufficientScope.errorCode}", error_description="${insufficientScope.message}", scope="${requiredScopes.join(" ")}", resource_metadata="${resourceMetadataUrl}"`,
      );
      response.status(403).json(insufficientScope.toResponseObject());
    });
  };
}

function dingTalkIdentityFailureReasonCode(error: unknown): string {
  if (!(error instanceof ApprovalMcpError)) return "DINGTALK_IDENTITY_VERIFICATION_FAILED";
  switch (error.details?.authStage) {
    case "enterprise_user_mapping":
      return "DINGTALK_ENTERPRISE_USER_MAPPING_FAILED";
    default:
      return "DINGTALK_IDENTITY_VERIFICATION_FAILED";
  }
}

class DingTalkBackedOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: AuthorizationStore;
  readonly #options: CreateMcpAuthorizationOptions;
  readonly #now: () => number;
  readonly #randomToken: () => string;

  constructor(
    options: CreateMcpAuthorizationOptions,
    now: () => number,
    randomToken: () => string,
  ) {
    this.clientsStore = options.store;
    this.#options = options;
    this.#now = now;
    this.#randomToken = randomToken;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, response: express.Response): Promise<void> {
    let resource: string;
    try {
      resource = this.#validateResource(params.resource);
    } catch (error) {
      await recordSecurity(this.#options.securityAudit, {
        event: "authorization_failed",
        outcome: "rejected",
        clientId: client.client_id,
        reasonCode: "AUTHORIZATION_TARGET_INVALID",
      }).catch(() => undefined);
      throw error;
    }
    let scopes: McpScope[];
    try {
      scopes = this.#validateScopes(params.scopes);
    } catch (error) {
      await recordSecurity(this.#options.securityAudit, {
        event: "scope_rejected",
        outcome: "rejected",
        clientId: client.client_id,
        reasonCode: "INVALID_SCOPE",
      }).catch(() => undefined);
      throw error;
    }
    const upstreamState = this.#randomToken();
    await this.#options.store.putTransaction(upstreamState, {
      clientId: client.client_id,
      ...(params.state === undefined ? {} : { clientState: params.state }),
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      resource,
      scopes,
      expiresAt: this.#now() + this.#options.transactionTtlSeconds,
    });
    response.redirect(302, this.#options.identity.authorizationUrl(upstreamState).href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const record = await this.#options.store.getAuthorizationCode(authorizationCode);
    if (record === undefined || record.clientId !== client.client_id) {
      await recordSecurity(this.#options.securityAudit, {
        event: "authorization_failed",
        outcome: "rejected",
        clientId: client.client_id,
        reasonCode: "AUTHORIZATION_CODE_INVALID",
      }).catch(() => undefined);
      throw new InvalidGrantError("Authorization code is invalid or expired.");
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    try {
      const record = await this.#options.store.consumeAuthorizationCode(authorizationCode);
      if (
        record === undefined ||
        record.clientId !== client.client_id ||
        redirectUri !== record.redirectUri ||
        this.#validateResource(resource) !== record.resource
      ) {
        throw new InvalidGrantError("Authorization code is invalid, expired, or bound to another request.");
      }
      return this.#issueTokenPair(record.clientId, record.resource, record.scopes, record.principal, randomUUID());
    } catch (error) {
      await recordSecurity(this.#options.securityAudit, {
        event: "authorization_failed",
        outcome: "rejected",
        clientId: client.client_id,
        reasonCode: "AUTHORIZATION_CODE_EXCHANGE_FAILED",
      }).catch(() => undefined);
      throw error;
    }
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const consumed = await this.#options.store.consumeRefreshToken(refreshToken);
    if (consumed.status !== "active") {
      if (consumed.status === "replayed") {
        await recordSecurity(this.#options.securityAudit, {
          event: "refresh_replay",
          outcome: "rejected",
          clientId: client.client_id,
          reasonCode: "REFRESH_TOKEN_REPLAY",
        }).catch(() => undefined);
      } else {
        await recordSecurity(this.#options.securityAudit, {
          event: "authorization_failed",
          outcome: "rejected",
          clientId: client.client_id,
          reasonCode: "REFRESH_TOKEN_INVALID",
        }).catch(() => undefined);
      }
      throw new InvalidGrantError("Refresh token is invalid, expired, revoked, or replayed.");
    }
    const record = consumed.record;
    let refreshResource: string;
    try {
      refreshResource = this.#validateResource(resource);
    } catch (error) {
      await recordSecurity(this.#options.securityAudit, {
        event: "authorization_failed",
        outcome: "rejected",
        clientId: client.client_id,
        reasonCode: "REFRESH_TARGET_INVALID",
      }).catch(() => undefined);
      throw error;
    }
    if (
      record.clientId !== client.client_id ||
      refreshResource !== record.resource ||
      await this.#options.store.isRefreshFamilyRevoked(record.familyId)
    ) {
      await this.#options.store.revokeRefreshToken(refreshToken);
      await recordSecurity(this.#options.securityAudit, {
        event: "authorization_failed",
        outcome: "rejected",
        clientId: client.client_id,
        reasonCode: "REFRESH_BINDING_INVALID",
      }).catch(() => undefined);
      throw new InvalidGrantError("Refresh token is not valid for this client or resource.");
    }
    let requestedScopes: McpScope[];
    try {
      requestedScopes = scopes === undefined ? record.scopes : this.#validateScopes(scopes);
    } catch (error) {
      await recordSecurity(this.#options.securityAudit, {
        event: "scope_rejected",
        outcome: "rejected",
        clientId: client.client_id,
        reasonCode: "REFRESH_SCOPE_INVALID",
      }).catch(() => undefined);
      throw error;
    }
    if (requestedScopes.some((scope) => !record.scopes.includes(scope))) {
      await recordSecurity(this.#options.securityAudit, {
        event: "scope_rejected",
        outcome: "rejected",
        clientId: client.client_id,
        reasonCode: "REFRESH_SCOPE_EXPANSION",
      }).catch(() => undefined);
      throw new InvalidScopeError("A refresh request cannot expand the original scope.");
    }
    return this.#issueTokenPair(
      record.clientId,
      record.resource,
      requestedScopes,
      record.principal,
      record.familyId,
    );
  }

  verifyAccessToken(token: string): Promise<AuthInfo> {
    return this.#options.tokenCodec.verifyAccessToken(token);
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.#options.store.revokeRefreshToken(request.token);
    await recordSecurity(this.#options.securityAudit, {
      event: "token_revoked",
      outcome: "succeeded",
      clientId: _client.client_id,
    });
  }

  #validateResource(resource: URL | undefined): string {
    if (resource === undefined || resource.href !== this.#options.resourceUrl.href) {
      throw new InvalidTargetError("The resource must exactly match this MCP server.");
    }
    return resource.href;
  }

  #validateScopes(requested: readonly string[] | undefined): McpScope[] {
    const scopes = requested === undefined || requested.length === 0 ? ["approval:read"] : [...new Set(requested)];
    if (
      scopes.some((scope) => !this.#options.allowedScopes.includes(scope as McpScope)) ||
      !scopes.includes("approval:read")
    ) {
      throw new InvalidScopeError("The requested approval scope is not allowed.");
    }
    return scopes as McpScope[];
  }

  async #issueTokenPair(
    clientId: string,
    resource: string,
    scopes: McpScope[],
    principal: TokenIdentity,
    familyId: string,
  ): Promise<OAuthTokens> {
    const accessToken = await this.#options.tokenCodec.issue({ principal, clientId, scopes });
    const refreshToken = this.#randomToken();
    await this.#options.store.putRefreshToken(refreshToken, {
      familyId,
      clientId,
      resource,
      scopes,
      principal,
      expiresAt: this.#now() + this.#options.refreshTokenTtlSeconds,
    });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.#options.accessTokenTtlSeconds,
      scope: scopes.join(" "),
      refresh_token: refreshToken,
    };
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function singleQueryValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function recordSecurity(sink: SecurityAuditSink | undefined, event: SecurityAuditEventInput): Promise<void> {
  return Promise.resolve(sink?.record(event));
}

function auditRejectedOAuthResponse(sink: SecurityAuditSink | undefined, reasonCode: string): RequestHandler {
  return (_request, response, next) => {
    response.once("finish", () => {
      if (response.statusCode < 400 && !hasOAuthErrorRedirect(response)) return;
      void recordSecurity(sink, {
        event: "authorization_failed",
        outcome: "rejected",
        reasonCode,
      }).catch(() => undefined);
    });
    next();
  };
}

function hasOAuthErrorRedirect(response: express.Response): boolean {
  if (response.statusCode < 300 || response.statusCode >= 400) return false;
  const location = response.getHeader("location");
  if (typeof location !== "string") return false;
  try {
    return new URL(location).searchParams.has("error");
  } catch {
    return false;
  }
}

function validateRedirectUri(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidClientMetadataError("redirect_uri must be a valid URL.");
  }
  if (url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new InvalidClientMetadataError("redirect_uri contains forbidden URL components.");
  }
  if (url.protocol === "https:") return;
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
  if (!loopback) throw new InvalidClientMetadataError("redirect_uri must use HTTPS or a loopback HTTP host.");
}

export function validateDynamicClientRegistration(client: OAuthClientInformationFull): void {
  if (Buffer.byteLength(JSON.stringify(client), "utf8") > MAX_DYNAMIC_CLIENT_METADATA_BYTES) {
    throw new InvalidClientMetadataError("Dynamic client metadata exceeds the size limit.");
  }
  if (client.client_id === undefined || client.client_id === "") {
    throw new InvalidClientMetadataError("Generated client_id is missing.");
  }
  if (client.token_endpoint_auth_method !== "none" || client.client_secret !== undefined) {
    throw new InvalidClientMetadataError("Dynamic registration accepts public PKCE clients only.");
  }
  if (client.redirect_uris.length < 1 || client.redirect_uris.length > 5) {
    throw new InvalidClientMetadataError("A client must register between one and five redirect URIs.");
  }
  for (const redirectUri of client.redirect_uris) validateRedirectUri(redirectUri);
}

export function isMcpScope(value: string): value is McpScope {
  return MCP_SCOPES.includes(value as McpScope);
}
