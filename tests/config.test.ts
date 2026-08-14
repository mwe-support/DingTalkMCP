import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const requiredEnvironment = {
  DINGTALK_CLIENT_ID: "test-client-id",
  DINGTALK_CLIENT_SECRET: "test-client-secret",
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
});
