import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("CVM DingTalk edge contract", () => {
  it("routes the sole production backend through loopback port 3000", async () => {
    const config = await readFile(new URL("../deploy/cvm/edge/dingtalk.conf", import.meta.url), "utf8");

    expect(config).toContain("proxy_pass http://127.0.0.1:3000");
    expect(config).not.toContain("127.0.0.1:3001");
  });

  it("uses exact OAuth/MCP locations with strict method allowlists", async () => {
    const config = await readFile(new URL("../deploy/cvm/edge/dingtalk.conf", import.meta.url), "utf8");

    expect(config).toContain("location = /.well-known/oauth-authorization-server");
    expect(config).toContain("location = /.well-known/oauth-protected-resource/mcp");
    expect(config).not.toMatch(/location \^~ \/\.well-known\/ \{/u);
    expect(config).not.toContain("location ~ ^/(authorize|token|register|revoke)$");
    expect(exactLocation(config, "/mcp")).toMatch(/limit_except GET POST DELETE/u);
    expect(exactLocation(config, "/authorize")).toMatch(/limit_except GET POST/u);
    for (const path of ["/token", "/register", "/revoke", "/oauth/consent"]) {
      expect(exactLocation(config, path)).toMatch(/limit_except POST/u);
    }
    for (const path of [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp",
      "/oauth/dingtalk/callback",
      "/healthz",
    ]) {
      expect(exactLocation(config, path)).toMatch(/limit_except GET/u);
    }
  });
});

function exactLocation(config: string, path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`location = ${escaped} \\{([\\s\\S]*?)\\n    \\}`, "u").exec(config);
  if (match?.[1] === undefined) throw new Error(`Missing exact location for ${path}`);
  return match[1];
}
