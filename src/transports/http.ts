import type { AddressInfo } from "node:net";

import { loadConfig } from "../config.js";
import { createApprovalService } from "../runtime.js";
import { startApprovalHttpServer } from "./http-server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const host = process.env.MCP_HTTP_HOST?.trim() || "127.0.0.1";
  const port = parsePort(process.env.MCP_HTTP_PORT);
  const apiKey = process.env.MCP_HTTP_API_KEY?.trim() || undefined;
  const allowedHosts = csv(process.env.MCP_HTTP_ALLOWED_HOSTS);
  const running = await startApprovalHttpServer(createApprovalService(config), {
    host,
    port,
    apiKey,
    allowedHosts,
  });
  const address = running.httpServer.address() as AddressInfo;
  process.stderr.write(`MWE approval MCP listening on http://${host}:${address.port}/mcp\n`);

  const shutdown = (): void => {
    void running.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  process.stderr.write(`MWE approval MCP HTTP transport failed to start: ${message}\n`);
  process.exitCode = 1;
});

function parsePort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return 3000;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error("MCP_HTTP_PORT must be an integer between 0 and 65535.");
  }
  return parsed;
}

function csv(value: string | undefined): string[] {
  return value?.split(",").map((item) => item.trim()).filter(Boolean) ?? [];
}
