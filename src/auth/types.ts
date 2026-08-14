import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export const MCP_SCOPES = ["approval:read", "approval:decide"] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

export interface McpPrincipal {
  subject: string;
  tenantId: string;
  userId: string;
  clientId: string;
  scopes: readonly McpScope[];
  authenticatedAt: number;
}

export interface ApprovalCaller {
  tenantId: string;
  subject: string;
  userId: string;
  scopes: readonly McpScope[];
}

export function principalFromAuthInfo(auth: AuthInfo): McpPrincipal {
  const extra = auth.extra;
  const subject = requiredClaim(extra, "subject");
  const tenantId = requiredClaim(extra, "tenantId");
  const userId = requiredClaim(extra, "userId");
  const authenticatedAt = extra?.authenticatedAt;
  if (typeof authenticatedAt !== "number" || !Number.isInteger(authenticatedAt) || authenticatedAt < 0) {
    throw new Error("Authenticated MCP token is missing a valid authenticatedAt claim.");
  }
  const scopes = auth.scopes.filter((scope): scope is McpScope => MCP_SCOPES.includes(scope as McpScope));
  if (scopes.length !== auth.scopes.length) {
    throw new Error("Authenticated MCP token contains an unsupported scope.");
  }
  return {
    subject,
    tenantId,
    userId,
    clientId: auth.clientId,
    scopes,
    authenticatedAt,
  };
}

function requiredClaim(extra: AuthInfo["extra"], key: string): string {
  const value = extra?.[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`Authenticated MCP token is missing the ${key} claim.`);
  }
  return value;
}
