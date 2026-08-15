import { describe, expect, it, vi } from "vitest";

import { DingTalkOAuthIdentityAdapter } from "../src/auth/dingtalk-identity.js";
import { ApprovalMcpError } from "../src/core/errors.js";

describe("DingTalkOAuthIdentityAdapter", () => {
  it("builds the documented enterprise login URL without exposing application secrets", () => {
    const adapter = fixture().adapter;

    const url = adapter.authorizationUrl("upstream-state-1");

    expect(url.origin + url.pathname).toBe("https://login.dingtalk.com/oauth2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      redirect_uri: "https://dingtalk.mwexk.com/oauth/dingtalk/callback",
      response_type: "code",
      client_id: "ding-app-1",
      scope: "openid corpid",
      state: "upstream-state-1",
      corpId: "corp-1",
    });
    expect(url.href).not.toContain("app-secret");
  });

  it("verifies corpId and maps the server-derived unionId to the enterprise userId", async () => {
    const { adapter, fetch, resolveUserIdByUnionId } = fixture();

    const identity = await adapter.verifyAuthorizationCode("dingtalk-code-1");

    expect(identity).toMatchObject({
      subject: "union-1",
      tenantId: "corp-1",
      userId: "user-1",
    });
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.dingtalk.com/v1.0/oauth2/userAccessToken",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          clientId: "ding-app-1",
          clientSecret: "app-secret",
          code: "dingtalk-code-1",
          grantType: "authorization_code",
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://api.dingtalk.com/v1.0/contact/users/me",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "x-acs-dingtalk-access-token": "ding-user-token" }),
      }),
    );
    expect(resolveUserIdByUnionId).toHaveBeenCalledWith("union-1");
  });

  it("fails closed when DingTalk returns another enterprise", async () => {
    const { adapter, fetch } = fixture();
    fetch.mockReset().mockResolvedValueOnce(jsonResponse({ accessToken: "ding-user-token", corpId: "corp-other" }));

    await expect(adapter.verifyAuthorizationCode("dingtalk-code-1")).rejects.toThrow(
      "DingTalk OAuth returned an unexpected enterprise",
    );
  });

  it("classifies enterprise user mapping failures without exposing upstream details", async () => {
    const { adapter, resolveUserIdByUnionId } = fixture();
    resolveUserIdByUnionId.mockRejectedValueOnce(new ApprovalMcpError(
      "DINGTALK_API_ERROR",
      "DingTalk rejected the enterprise identity mapping request.",
      { details: { upstreamCode: "88", upstreamMessage: "sensitive-upstream-detail" } },
    ));

    await expect(adapter.verifyAuthorizationCode("dingtalk-code-1")).rejects.toMatchObject({
      code: "DINGTALK_AUTH_ERROR",
      details: {
        authStage: "enterprise_user_mapping",
        upstreamCode: "88",
      },
    });
  });
});

function fixture(): {
  adapter: DingTalkOAuthIdentityAdapter;
  fetch: ReturnType<typeof vi.fn>;
  resolveUserIdByUnionId: ReturnType<typeof vi.fn>;
} {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(jsonResponse({ accessToken: "ding-user-token", expireIn: 7200, corpId: "corp-1" }))
    .mockResolvedValueOnce(jsonResponse({ unionId: "union-1", openId: "open-1" }));
  const resolveUserIdByUnionId = vi.fn().mockResolvedValue("user-1");
  return {
    fetch,
    resolveUserIdByUnionId,
    adapter: new DingTalkOAuthIdentityAdapter({
      clientId: "ding-app-1",
      clientSecret: "app-secret",
      corpId: "corp-1",
      redirectUrl: "https://dingtalk.mwexk.com/oauth/dingtalk/callback",
      apiBaseUrl: "https://api.dingtalk.com",
      fetch: fetch as typeof globalThis.fetch,
      applicationApi: { resolveUserIdByUnionId },
      now: () => 1_800_000_000,
    }),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
