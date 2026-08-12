import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

describe("stdio transport", () => {
  it("starts as a real child process and answers an MCP capability call", async () => {
    const client = new Client({ name: "stdio-smoke-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/transports/stdio.ts"],
      cwd: process.cwd(),
      env: {
        ...getDefaultEnvironment(),
        DINGTALK_CLIENT_ID: "ding-test",
        DINGTALK_CLIENT_SECRET: "secret-test",
      },
      stderr: "pipe",
    });

    try {
      await client.connect(transport as unknown as Parameters<typeof client.connect>[0]);
      const result = await client.callTool({ name: "get_approval_capabilities", arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        result: { application: "MWE审批MCP", writeGuard: { enabled: false } },
      });
    } finally {
      await client.close();
    }
  });
});
