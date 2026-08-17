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
    expect(loadConfig(requiredEnvironment).auditLogPath).toBe(resolve("./data/audit"));
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
      refreshTokenTtlSeconds: 28_800,
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
