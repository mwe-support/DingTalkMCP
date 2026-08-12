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
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class DingTalkApiClient {
  readonly #tokenProvider: Pick<DingTalkTokenProvider, "getToken" | "invalidate">;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: DingTalkApiClientOptions) {
    this.#tokenProvider = options.tokenProvider;
    this.#baseUrl = (options.baseUrl ?? "https://api.dingtalk.com").replace(/\/$/u, "");
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
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
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    return payload as T;
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
