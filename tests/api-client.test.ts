import { describe, expect, it, vi } from "vitest";

import { DingTalkApiClient, getDingTalkRequestId } from "../src/dingtalk/client.js";

describe("DingTalkApiClient", () => {
  it("preserves the successful upstream request id as non-serialized metadata", async () => {
    const tokenProvider = { getToken: vi.fn().mockResolvedValue("token"), invalidate: vi.fn() };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ instanceId: "pi-1" }), {
        status: 200,
        headers: { "content-type": "application/json", "x-acs-request-id": "upstream-success-1" },
      }),
    );
    const client = new DingTalkApiClient({ tokenProvider, fetch: fetchMock });

    const result = await client.request({ method: "POST", path: "/v1.0/workflow/processInstances", body: {} });

    expect(getDingTalkRequestId(result)).toBe("upstream-success-1");
    expect(JSON.stringify(result)).toBe('{"instanceId":"pi-1"}');
  });
});
