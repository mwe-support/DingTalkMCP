import { ApprovalMcpError } from "../core/errors.js";
import type { DingTalkTokenProvider } from "./token-provider.js";

export interface DingTalkRequest {
  method: "GET" | "POST";
  path: `/${string}`;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

interface DingTalkApiClientOptions {
  tokenProvider: Pick<DingTalkTokenProvider, "getToken" | "invalidate">;
  baseUrl?: string;
  legacyBaseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const responseMetadata = new WeakMap<object, { requestId?: string; status: number }>();

export interface DingTalkUserProfile {
  name: string;
  departmentIds: number[];
}

export interface DingTalkDepartmentProfile {
  name: string;
}

export function getDingTalkRequestId(value: unknown): string | undefined {
  return typeof value === "object" && value !== null ? responseMetadata.get(value)?.requestId : undefined;
}

export function getDingTalkResponseStatus(value: unknown): number | undefined {
  return typeof value === "object" && value !== null ? responseMetadata.get(value)?.status : undefined;
}

export class DingTalkApiClient {
  readonly #tokenProvider: Pick<DingTalkTokenProvider, "getToken" | "invalidate">;
  readonly #baseUrl: string;
  readonly #legacyBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: DingTalkApiClientOptions) {
    this.#tokenProvider = options.tokenProvider;
    this.#baseUrl = (options.baseUrl ?? "https://api.dingtalk.com").replace(/\/$/u, "");
    this.#legacyBaseUrl = (options.legacyBaseUrl ?? "https://oapi.dingtalk.com").replace(/\/$/u, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
  }

  async resolveUserIdByUnionId(unionId: string): Promise<string> {
    const token = await this.#tokenProvider.getToken();
    const url = new URL(`${this.#legacyBaseUrl}/topapi/user/getbyunionid`);
    url.searchParams.set("access_token", token);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ unionid: unionId }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new ApprovalMcpError(
        "DINGTALK_API_ERROR",
        "Unable to reach the DingTalk enterprise identity mapping endpoint.",
        {
          details: { method: "POST", path: "/topapi/user/getbyunionid" },
          retryable: true,
        },
      );
    }

    const payload = await parseResponseBody(response);
    const record = asRecord(payload);
    const result = asRecord(record?.result);
    const upstreamCode = stringValue(record?.errcode ?? record?.code);
    if (!response.ok || upstreamCode !== "0" || result === undefined) {
      if (response.status === 401) this.#tokenProvider.invalidate();
      const denied = asRecord(record?.AccessDeniedDetail ?? record?.accessDeniedDetail);
      throw new ApprovalMcpError(
        "DINGTALK_API_ERROR",
        "DingTalk rejected the enterprise identity mapping request.",
        {
          details: {
            status: response.status,
            method: "POST",
            path: "/topapi/user/getbyunionid",
            upstreamCode,
            upstreamMessage: stringValue(record?.errmsg ?? record?.message),
            requestId: stringValue(record?.request_id ?? record?.requestid ?? record?.requestId),
            requiredScopes: denied?.requiredScopes,
          },
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
        },
      );
    }

    const userId = result.userid ?? result.userId;
    if (typeof userId !== "string" || userId === "") {
      throw new ApprovalMcpError(
        "INVALID_RESPONSE",
        "DingTalk enterprise identity mapping did not return a userId.",
        { details: { path: "/topapi/user/getbyunionid" } },
      );
    }
    return userId;
  }

  async getUserProfile(userId: string): Promise<DingTalkUserProfile> {
    const payload = await this.#legacyPost("/topapi/v2/user/get", { userid: userId, language: "zh_CN" });
    const result = asRecord(asRecord(payload)?.result);
    const name = result?.name;
    const rawDepartmentIds = result?.dept_id_list ?? result?.deptIdList;
    const departmentIds = Array.isArray(rawDepartmentIds)
      ? rawDepartmentIds.filter((value): value is number => typeof value === "number" && Number.isInteger(value))
      : [];
    if (typeof name !== "string" || name === "" || departmentIds.length === 0) {
      throw new ApprovalMcpError(
        "INVALID_RESPONSE",
        "DingTalk did not return a usable applicant directory profile.",
        { details: { path: "/topapi/v2/user/get" } },
      );
    }
    return { name, departmentIds };
  }

  async getDepartmentProfile(deptId: number): Promise<DingTalkDepartmentProfile> {
    const payload = await this.#legacyPost("/topapi/v2/department/get", { dept_id: deptId, language: "zh_CN" });
    const name = asRecord(asRecord(payload)?.result)?.name;
    if (typeof name !== "string" || name === "") {
      throw new ApprovalMcpError(
        "INVALID_RESPONSE",
        "DingTalk did not return a usable department profile.",
        { details: { path: "/topapi/v2/department/get" } },
      );
    }
    return { name };
  }

  async request<T = unknown>(request: DingTalkRequest): Promise<T> {
    const token = await this.#tokenProvider.getToken();
    const url = new URL(`${this.#baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: request.method,
        headers: {
          "x-acs-dingtalk-access-token": token,
          accept: "application/json",
          ...(request.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new ApprovalMcpError("DINGTALK_API_ERROR", "Unable to reach the DingTalk OpenAPI endpoint.", {
        cause: error,
        details: { method: request.method, path: request.path },
        retryable: true,
      });
    }

    const payload = await parseResponseBody(response);
    if (!response.ok) {
      if (response.status === 401) {
        this.#tokenProvider.invalidate();
      }
      const record = asRecord(payload);
      const denied = asRecord(record?.AccessDeniedDetail ?? record?.accessDeniedDetail);
      throw new ApprovalMcpError("DINGTALK_API_ERROR", "DingTalk OpenAPI rejected the request.", {
        details: {
          status: response.status,
          method: request.method,
          path: request.path,
          upstreamCode: stringValue(record?.code ?? record?.errcode),
          upstreamMessage: stringValue(record?.message ?? record?.errmsg),
          requestId:
            response.headers.get("x-acs-request-id") ??
            stringValue(record?.requestid ?? record?.requestId),
          requiredScopes: denied?.requiredScopes,
        },
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      });
    }

    if (typeof payload === "object" && payload !== null) {
      const successfulRequestId = response.headers.get("x-acs-request-id") ?? undefined;
      responseMetadata.set(payload, {
        ...(successfulRequestId === undefined ? {} : { requestId: successfulRequestId }),
        status: response.status,
      });
    }
    return payload as T;
  }

  async #legacyPost(path: `/${string}`, body: Record<string, unknown>): Promise<unknown> {
    const token = await this.#tokenProvider.getToken();
    const url = new URL(`${this.#legacyBaseUrl}${path}`);
    url.searchParams.set("access_token", token);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new ApprovalMcpError("DINGTALK_API_ERROR", "Unable to reach the DingTalk directory endpoint.", {
        details: { method: "POST", path },
        retryable: true,
      });
    }
    const payload = await parseResponseBody(response);
    const record = asRecord(payload);
    const upstreamCode = stringValue(record?.errcode ?? record?.code);
    if (!response.ok || upstreamCode !== "0") {
      if (response.status === 401) this.#tokenProvider.invalidate();
      const denied = asRecord(record?.AccessDeniedDetail ?? record?.accessDeniedDetail);
      throw new ApprovalMcpError("DINGTALK_API_ERROR", "DingTalk rejected the directory request.", {
        details: {
          status: response.status,
          method: "POST",
          path,
          upstreamCode,
          upstreamMessage: stringValue(record?.errmsg ?? record?.message),
          requestId: stringValue(record?.request_id ?? record?.requestid ?? record?.requestId),
          requiredScopes: denied?.requiredScopes,
        },
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      });
    }
    return payload;
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return {};
  }
  try {
    return await response.json();
  } catch (error) {
    throw new ApprovalMcpError("INVALID_RESPONSE", "DingTalk returned a non-JSON API response.", {
      cause: error,
      details: { status: response.status },
      retryable: response.status >= 500,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}
