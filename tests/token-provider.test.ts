import { describe, expect, it, vi } from "vitest";

import { DingTalkTokenProvider } from "../src/dingtalk/token-provider.js";

describe("DingTalkTokenProvider", () => {
  it("requests an app token once and reuses it before expiry", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ accessToken: "token-1", expireIn: 7200 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new DingTalkTokenProvider({
      appKey: "ding-test",
      appSecret: "secret-test",
      fetch: fetchMock,
      now: () => 1_000_000,
    });

    await expect(provider.getToken()).resolves.toBe("token-1");
    await expect(provider.getToken()).resolves.toBe("token-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.dingtalk.com/v1.0/oauth2/accessToken",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ appKey: "ding-test", appSecret: "secret-test" }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("does not expose the client secret when token acquisition fails", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ code: "InvalidAuthentication", message: "bad credentials" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const provider = new DingTalkTokenProvider({
      appKey: "ding-test",
      appSecret: "secret-never-log",
      fetch: fetchMock,
    });

    await expect(provider.getToken()).rejects.not.toThrow(/secret-never-log/);
  });
});
