import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";

import { DirectoryAuthorizationStore, startAuthorizationStoreSweep } from "../auth/authorization-store.js";
import { DingTalkOAuthIdentityAdapter } from "../auth/dingtalk-identity.js";
import { JoseMcpTokenCodec } from "../auth/jwt-codec.js";
import { createMcpAuthorization } from "../auth/mcp-authorization.js";
import { AuditPseudonymizer, BoundedSecurityAuditSink, RetainedSecurityAuditSink } from "../auth/security-audit.js";
import { loadConfig } from "../config.js";
import {
  BoundedApprovalAuditSink,
  AuditInvocationContext,
  DailyJsonLineAuditStore,
  RetainedApprovalAuditSink,
  RetainedToolInvocationAuditSink,
  startAuditRetentionSweep,
} from "../core/audit-log.js";
import { createApprovalRuntime } from "../runtime.js";
import { startApprovalHttpServer } from "./http-server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const host = process.env.APPROVAL_BACKEND_HOST?.trim() || "127.0.0.1";
  const port = parsePort(process.env.APPROVAL_BACKEND_PORT);
  const allowedHosts = csv(process.env.APPROVAL_BACKEND_ALLOWED_HOSTS);
  const auditStore = new DailyJsonLineAuditStore(config.auditLogPath);
  const auditContext = new AuditInvocationContext();
  const retentionSweep = await startAuditRetentionSweep(auditStore, {
    onError: () => {
      process.stderr.write("Structured audit retention sweep failed.\n");
    },
  });
  const runtime = createApprovalRuntime(config, {
    audit: new BoundedApprovalAuditSink(new RetainedApprovalAuditSink(auditStore), auditStore, {
      invocationContext: auditContext,
    }),
  });
  const privateKeyPem = await readFile(config.auth.signingPrivateKeyPath, "utf8");
  const auditHmacKey = (await readFile(config.auth.auditHmacKeyPath, "utf8")).trim();
  const auditPseudonymizer = new AuditPseudonymizer(auditHmacKey);
  const tokenCodec = await JoseMcpTokenCodec.create({
    privateKeyPem,
    keyId: config.auth.signingKeyId,
    issuer: config.auth.issuerUrl,
    audience: config.auth.publicUrl,
    expectedTenantId: config.auth.corpId,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
  });
  const identity = new DingTalkOAuthIdentityAdapter({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    corpId: config.auth.corpId,
    redirectUrl: config.auth.redirectUrl,
    apiBaseUrl: config.apiBaseUrl,
    applicationApi: runtime.api,
  });
  const authorizationStore = new DirectoryAuthorizationStore(config.auth.authStorePath, {
    refreshTokenUpgradeTtlSeconds: config.auth.refreshTokenTtlSeconds,
  });
  const authorizationSweep = await startAuthorizationStoreSweep(authorizationStore, {
    onError: () => {
      process.stderr.write("Authorization state retention sweep failed.\n");
    },
  });
  const auth = createMcpAuthorization({
    issuerUrl: new URL(config.auth.issuerUrl),
    resourceUrl: new URL(config.auth.publicUrl),
    redirectUrl: new URL(config.auth.redirectUrl),
    expectedCorpId: config.auth.corpId,
    allowedScopes: config.auth.allowedScopes,
    accessTokenTtlSeconds: config.auth.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.auth.refreshTokenTtlSeconds,
    transactionTtlSeconds: config.auth.transactionTtlSeconds,
    identity,
    store: authorizationStore,
    tokenCodec,
    securityAudit: new BoundedSecurityAuditSink(new RetainedSecurityAuditSink(auditStore, auditPseudonymizer)),
  });
  const running = await startApprovalHttpServer(runtime.service, {
    host,
    port,
    allowedHosts,
    allowedOrigins: [new URL(config.auth.publicUrl).origin],
    auth,
    auditContext,
    auditPseudonymizer,
    toolAudit: new RetainedToolInvocationAuditSink(auditStore),
  });
  const address = running.httpServer.address() as AddressInfo;
  process.stderr.write(`MWE approval MCP listening on http://${host}:${address.port}/mcp\n`);

  const shutdown = (): void => {
    retentionSweep.close();
    authorizationSweep.close();
    void running.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  process.stderr.write(`MWE approval MCP failed to start: ${message}\n`);
  process.exitCode = 1;
});

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 3000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error("APPROVAL_BACKEND_PORT must be an integer between 0 and 65535.");
  }
  return parsed;
}

function csv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}
