import type { AddressInfo } from "node:net";

import { loadConfig } from "../config.js";
import {
  BoundedApprovalAuditSink,
  AuditInvocationContext,
  DailyJsonLineAuditStore,
  RetainedApprovalAuditSink,
  RetainedToolInvocationAuditSink,
  startAuditRetentionSweep,
} from "../core/audit-log.js";
import { createApprovalService } from "../runtime.js";
import { startApprovalHttpServer } from "./http-server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const host = process.env.APPROVAL_BACKEND_HOST?.trim() || "127.0.0.1";
  const port = parsePort(process.env.APPROVAL_BACKEND_PORT);
  const platformApiKey = process.env.MCP_PLATFORM_API_KEY?.trim() || undefined;
  const allowedHosts = csv(process.env.APPROVAL_BACKEND_ALLOWED_HOSTS);
  const auditStore = new DailyJsonLineAuditStore(config.auditLogPath);
  const auditContext = new AuditInvocationContext();
  const retentionSweep = await startAuditRetentionSweep(auditStore, {
    onError: () => {
      process.stderr.write("Structured audit retention sweep failed.\n");
    },
  });
  const running = await startApprovalHttpServer(
    createApprovalService(config, {
      audit: new BoundedApprovalAuditSink(new RetainedApprovalAuditSink(auditStore), auditStore, {
        invocationContext: auditContext,
      }),
    }),
    {
      host,
      port,
      platformApiKey,
      allowedHosts,
      auditContext,
      toolAudit: new RetainedToolInvocationAuditSink(auditStore),
    },
  );
  const address = running.httpServer.address() as AddressInfo;
  process.stderr.write(`MWE approval tool backend listening on http://${host}:${address.port}\n`);
  if (platformApiKey !== undefined) {
    process.stderr.write(`DingTalk MCP Platform backend listening on /platform/tools/<toolName>\n`);
  }

  const shutdown = (): void => {
    retentionSweep.close();
    void running.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  process.stderr.write(`MWE approval tool backend failed to start: ${message}\n`);
  process.exitCode = 1;
});

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 3000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error("APPROVAL_BACKEND_PORT must be an integer between 0 and 65535.");
  }
  return parsed;
}

function csv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}
