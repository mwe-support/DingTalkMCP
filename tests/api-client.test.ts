import { describe, expect, it, vi } from "vitest";

import { errorPayload } from "../src/core/errors.js";
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

  it("maps an OAuth unionId to the enterprise userId through the supported application API", async () => {
    const tokenProvider = { getToken: vi.fn().mockResolvedValue("application-token"), invalidate: vi.fn() };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        errcode: 0,
        errmsg: "ok",
        result: { contact_type: 0, userid: "enterprise-user-1" },
        request_id: "mapping-request-1",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new DingTalkApiClient({ tokenProvider, fetch: fetchMock });

    await expect(client.resolveUserIdByUnionId("union-1")).resolves.toBe("enterprise-user-1");
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(requestUrl));
    expect(url.origin + url.pathname).toBe("https://oapi.dingtalk.com/topapi/user/getbyunionid");
    expect(url.searchParams.get("access_token")).toBe("application-token");
    expect(requestInit).toMatchObject({
      method: "POST",
      body: JSON.stringify({ unionid: "union-1" }),
    });
  });

  it("preserves a bounded legacy rejection without exposing the application token", async () => {
    const tokenProvider = { getToken: vi.fn().mockResolvedValue("secret-query-token"), invalidate: vi.fn() };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({
        errcode: 88,
        errmsg: "application permission denied",
        request_id: "mapping-denied-1",
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new DingTalkApiClient({ tokenProvider, fetch: fetchMock });

    const error = await client.resolveUserIdByUnionId("union-1").catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: "DINGTALK_API_ERROR",
      retryable: false,
      details: {
        status: 200,
        path: "/topapi/user/getbyunionid",
        upstreamCode: "88",
        requestId: "mapping-denied-1",
      },
    });
    expect(JSON.stringify(errorPayload(error))).not.toContain("secret-query-token");
  });

  it("invalidates the application token when the mapping endpoint returns HTTP 401", async () => {
    const tokenProvider = { getToken: vi.fn().mockResolvedValue("expired-token"), invalidate: vi.fn() };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ errcode: 401, errmsg: "invalid token" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new DingTalkApiClient({ tokenProvider, fetch: fetchMock });

    await expect(client.resolveUserIdByUnionId("union-1")).rejects.toMatchObject({
      code: "DINGTALK_API_ERROR",
      retryable: false,
    });
    expect(tokenProvider.invalidate).toHaveBeenCalledOnce();
  });

  it("rejects a successful mapping response that omits the enterprise userId", async () => {
    const tokenProvider = { getToken: vi.fn().mockResolvedValue("application-token"), invalidate: vi.fn() };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ errcode: 0, errmsg: "ok", result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new DingTalkApiClient({ tokenProvider, fetch: fetchMock });

    await expect(client.resolveUserIdByUnionId("union-1")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      retryable: false,
      details: { path: "/topapi/user/getbyunionid" },
    });
  });

  it("drops a network error that contains the query token from the public error", async () => {
    const tokenProvider = { getToken: vi.fn().mockResolvedValue("network-secret-token"), invalidate: vi.fn() };
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(
      new Error("request failed: ?access_token=network-secret-token"),
    );
    const client = new DingTalkApiClient({ tokenProvider, fetch: fetchMock });

    const error = await client.resolveUserIdByUnionId("union-1").catch((cause: unknown) => cause);

    expect(error).toMatchObject({ code: "DINGTALK_API_ERROR", retryable: true });
    expect(JSON.stringify(errorPayload(error))).not.toContain("network-secret-token");
  });

  it("resolves the server-bound applicant and department through DingTalk directory APIs", async () => {
    const tokenProvider = { getToken: vi.fn().mockResolvedValue("application-token"), invalidate: vi.fn() };
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errcode: 0,
        result: { name: "张三", dept_id_list: [42, 43] },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        errcode: 0,
        result: { name: "研发部" },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new DingTalkApiClient({ tokenProvider, fetch: fetchMock });

    await expect(client.getUserProfile("user-1")).resolves.toEqual({
      name: "张三",
      departmentIds: [42, 43],
    });
    await expect(client.getDepartmentProfile(42)).resolves.toEqual({ name: "研发部" });

    const firstUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(firstUrl.pathname).toBe("/topapi/v2/user/get");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ userid: "user-1", language: "zh_CN" }),
    });
    const secondUrl = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(secondUrl.pathname).toBe("/topapi/v2/department/get");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ dept_id: 42, language: "zh_CN" }),
    });
  });
});
