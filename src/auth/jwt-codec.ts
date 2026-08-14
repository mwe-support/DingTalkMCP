import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";

import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";

import { MCP_SCOPES, type McpScope } from "./types.js";

export interface TokenIdentity {
  subject: string;
  tenantId: string;
  userId: string;
  authenticatedAt: number;
}

export interface IssueMcpTokenInput {
  principal: TokenIdentity;
  clientId: string;
  scopes: readonly McpScope[];
}

export interface JoseMcpTokenCodecOptions {
  privateKeyPem: string;
  keyId: string;
  issuer: string;
  audience: string;
  accessTokenTtlSeconds: number;
  now?: () => number;
}

export class JoseMcpTokenCodec {
  readonly #signingKey: CryptoKey;
  readonly #verificationKey: CryptoKey;
  readonly #keyId: string;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #accessTokenTtlSeconds: number;
  readonly #now: () => number;

  private constructor(
    options: Omit<JoseMcpTokenCodecOptions, "privateKeyPem"> & {
      signingKey: CryptoKey;
      verificationKey: CryptoKey;
    },
  ) {
    this.#signingKey = options.signingKey;
    this.#verificationKey = options.verificationKey;
    this.#keyId = options.keyId;
    this.#issuer = options.issuer;
    this.#audience = options.audience;
    this.#accessTokenTtlSeconds = options.accessTokenTtlSeconds;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  static async create(options: JoseMcpTokenCodecOptions): Promise<JoseMcpTokenCodec> {
    const privateKey = createPrivateKey(options.privateKeyPem);
    const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
    return new JoseMcpTokenCodec({
      ...options,
      signingKey: await importPKCS8(options.privateKeyPem, "EdDSA"),
      verificationKey: await importSPKI(publicKeyPem, "EdDSA"),
    });
  }

  async issue(input: IssueMcpTokenInput): Promise<string> {
    const now = this.#now();
    return new SignJWT({
      tid: input.principal.tenantId,
      uid: input.principal.userId,
      client_id: input.clientId,
      scope: input.scopes.join(" "),
      auth_time: input.principal.authenticatedAt,
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "at+jwt", kid: this.#keyId })
      .setIssuer(this.#issuer)
      .setAudience(this.#audience)
      .setSubject(input.principal.subject)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setNotBefore(now)
      .setExpirationTime(now + this.#accessTokenTtlSeconds)
      .sign(this.#signingKey);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.#verificationKey, {
        algorithms: ["EdDSA"],
        issuer: this.#issuer,
        audience: this.#audience,
        currentDate: new Date(this.#now() * 1000),
        clockTolerance: 60,
        typ: "at+jwt",
      });
      if (protectedHeader.kid !== this.#keyId) throw new Error("Unknown signing key.");
      const subject = requiredString(payload.sub, "sub");
      const tenantId = requiredString(payload.tid, "tid");
      const userId = requiredString(payload.uid, "uid");
      const clientId = requiredString(payload.client_id, "client_id");
      const authenticatedAt = requiredInteger(payload.auth_time, "auth_time");
      const expiresAt = requiredInteger(payload.exp, "exp");
      const scopes = parseScopes(payload.scope);
      return {
        token,
        clientId,
        scopes,
        expiresAt,
        resource: new URL(this.#audience),
        extra: { subject, tenantId, userId, authenticatedAt },
      };
    } catch (error) {
      throw new Error("Invalid MCP access token.", { cause: error });
    }
  }
}

function parseScopes(value: unknown): McpScope[] {
  if (typeof value !== "string") throw new Error("Missing scope claim.");
  const scopes = value.split(" ").filter(Boolean);
  if (scopes.some((scope) => !MCP_SCOPES.includes(scope as McpScope))) {
    throw new Error("Unsupported scope claim.");
  }
  return scopes as McpScope[];
}

function requiredString(value: unknown, claim: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`Missing ${claim} claim.`);
  return value;
}

function requiredInteger(value: unknown, claim: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Missing ${claim} claim.`);
  }
  return value;
}
