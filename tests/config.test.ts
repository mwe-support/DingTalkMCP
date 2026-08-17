import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const requiredEnvironment = {
  DINGTALK_CLIENT_ID: "test-client-id",
  DINGTALK_CLIENT_SECRET: "test-client-secret",
  DINGTALK_CORP_ID: "ding-corp-1",
  MCP_PUBLIC_URL: "https://dingtalk.mwexk.com/mcp",
  MCP_ISSUER_URL: "https://dingtalk.mwexk.com/",
  DINGTALK_OAUTH_REDIRECT_URL: "https://dingtalk.mwexk.com/oauth/dingtalk/callback",
  MCP_SIGNING_PRIVATE_KEY_FILE: "./secrets/mcp-signing-private.pem",
  MCP_AUDIT_HMAC_KEY_FILE: "./secrets/mcp-audit-hmac.key",
};

describe("loadConfig", () => {
  it("uses a persistent audit directory under data by default", () => {
    const config = loadConfig(requiredEnvironment);
    expect(config.auditLogPath).toBe(resolve("./data/audit"));
    expect(config.approvalInboxPath).toBe(resolve("./data/approval-inbox"));
    expect(config.approvalEventsEnabled).toBe(false);
    expect(config.inboxProcessCodes).toEqual([
      "PROC-2DB91B79-3CDD-421D-A223-0489A7BAB2C0",
      "PROC-5E238117-7121-4CB3-8219-9F11A2E42BE4",
    ]);
  });

  it("loads an explicit processCode list for bounded inbox refresh", () => {
    expect(loadConfig({
      ...requiredEnvironment,
      APPROVAL_INBOX_PROCESS_CODES: "PROC-A,PROC-B,PROC-A",
    }).inboxProcessCodes).toEqual(["PROC-A", "PROC-B"]);
  });

  it("rejects more than ten process codes for one inbox refresh", () => {
    expect(() => loadConfig({
      ...requiredEnvironment,
      APPROVAL_INBOX_PROCESS_CODES: Array.from({ length: 11 }, (_, index) => `PROC-${index}`).join(","),
    })).toThrow("Inbox refresh requires between 1 and 10 bounded process codes");
  });

  it("enables the DingTalk approval event stream only from an explicit boolean", () => {
    expect(loadConfig({
      ...requiredEnvironment,
      DINGTALK_APPROVAL_EVENTS_ENABLED: "true",
      APPROVAL_INBOX_PATH: "./mounted/inbox",
    })).toMatchObject({
      approvalEventsEnabled: true,
      approvalInboxPath: resolve("./mounted/inbox"),
    });
    expect(() => loadConfig({
      ...requiredEnvironment,
      DINGTALK_APPROVAL_EVENTS_ENABLED: "yes",
    })).toThrow("DINGTALK_APPROVAL_EVENTS_ENABLED must be true or false");
  });

  it("allows deployment to place retained audit logs on a mounted volume", () => {
    expect(
      loadConfig({
        ...requiredEnvironment,
        APPROVAL_AUDIT_LOG_PATH: "./mounted/audit-stream",
      }).auditLogPath,
    ).toBe(resolve("./mounted/audit-stream"));
  });

  it("loads a canonical OAuth resource and bounded token lifetimes", () => {
    const config = loadConfig(requiredEnvironment);

    expect(config.agentId).toBeUndefined();
    expect(config.uploadHostSuffixes).toEqual([".trans.dingtalk.com", ".aliyuncs.com"]);
    expect(config.auth).toEqual({
      publicUrl: "https://dingtalk.mwexk.com/mcp",
      issuerUrl: "https://dingtalk.mwexk.com/",
      redirectUrl: "https://dingtalk.mwexk.com/oauth/dingtalk/callback",
      corpId: "ding-corp-1",
      signingPrivateKeyPath: resolve("./secrets/mcp-signing-private.pem"),
      signingKeyId: "mwe-approval-mcp-1",
      auditHmacKeyPath: resolve("./secrets/mcp-audit-hmac.key"),
      authStorePath: resolve("./data/auth"),
      accessTokenTtlSeconds: 600,
      refreshTokenTtlSeconds: 7 * 24 * 60 * 60,
      transactionTtlSeconds: 300,
      allowedScopes: ["approval:read", "approval:decide", "approval:create"],
    });
  });

  it("loads the DingTalk microapp agentId required by direct approval attachment uploads", () => {
    const config = loadConfig({
      ...requiredEnvironment,
      DINGTALK_AGENT_ID: "123456",
      APPROVAL_UPLOAD_HOST_SUFFIXES: ".aliyuncs.com,.example.invalid",
    });

    expect(config.agentId).toBe(123456);
    expect(config.uploadHostSuffixes).toEqual([".aliyuncs.com", ".example.invalid"]);
  });

  it("rejects an invalid DingTalk agentId", () => {
    expect(() => loadConfig({ ...requiredEnvironment, DINGTALK_AGENT_ID: "0" })).toThrow(
      "DINGTALK_AGENT_ID must be a positive safe integer",
    );
  });

  it("rejects an OAuth resource URL that is not the canonical /mcp HTTPS endpoint", () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        MCP_PUBLIC_URL: "https://dingtalk.mwexk.com/platform/tools/approval_task",
      }),
    ).toThrow("MCP_PUBLIC_URL must use the exact /mcp path");
  });

  it("rejects a DingTalk OAuth callback URL with the wrong path", () => {
    expect(() =>
      loadConfig({
        ...requiredEnvironment,
        DINGTALK_OAUTH_REDIRECT_URL: "https://dingtalk.mwexk.com/oauth/wrong-callback",
      }),
    ).toThrow("DINGTALK_OAUTH_REDIRECT_URL must use the exact /oauth/dingtalk/callback path");
  });
});
