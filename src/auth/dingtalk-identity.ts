import { ApprovalMcpError } from "../core/errors.js";
import type { DingTalkRequest } from "../dingtalk/client.js";
import type { TokenIdentity } from "./jwt-codec.js";
import type { DingTalkIdentityPort } from "./mcp-authorization.js";

interface ApplicationApiPort {
  request<T = unknown>(request: DingTalkRequest): Promise<T>;
}

export interface DingTalkOAuthIdentityAdapterOptions {
  clientId: string;
  clientSecret: string;
  corpId: string;
  redirectUrl: string;
  apiBaseUrl?: string;
  fetch?: typeof fetch;
  applicationApi: ApplicationApiPort;
  now?: () => number;
  timeoutMs?: number;
}

export class DingTalkOAuthIdentityAdapter implements DingTalkIdentityPort {
  readonly #clientId: string;
  readonly #clientSecret: string;
  readonly #corpId: string;
  readonly #redirectUrl: string;
  readonly #apiBaseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #applicationApi: ApplicationApiPort;
  readonly #now: () => number;
  readonly #timeoutMs: number;

  constructor(options: DingTalkOAuthIdentityAdapterOptions) {
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#corpId = options.corpId;
    this.#redirectUrl = options.redirectUrl;
    this.#apiBaseUrl = (options.apiBaseUrl ?? "https://api.dingtalk.com").replace(/\/$/u, "");
    this.#fetch = options.fetch ?? fetch;
    this.#applicationApi = options.applicationApi;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  authorizationUrl(state: string): URL {
    const url = new URL("https://login.dingtalk.com/oauth2/auth");
    url.search = new URLSearchParams({
      redirect_uri: this.#redirectUrl,
      response_type: "code",
      client_id: this.#clientId,
      scope: "openid corpid",
      state,
      corpId: this.#corpId,
    }).toString();
    return url;
  }

  async verifyAuthorizationCode(code: string): Promise<TokenIdentity> {
    const token = await this.#exchangeUserToken(code);
    if (token.corpId !== this.#corpId) {
      throw new ApprovalMcpError(
        "DINGTALK_AUTH_ERROR",
        "DingTalk OAuth returned an unexpected enterprise.",
      );
    }
    const profile = await this.#getUserProfile(token.accessToken);
    const unionId = requiredString(profile.unionId, "DingTalk user profile did not contain unionId.");
    const mapped = await this.#applicationApi.request({
      method: "POST",
      path: "/v1.0/contact/users/unionId",
      body: { unionId },
    });
    const result = record(record(mapped)?.result) ?? record(mapped);
    const userId = requiredString(
      result?.userId ?? result?.userid,
      "DingTalk did not map the OAuth unionId to an enterprise userId.",
    );
    return {
      subject: unionId,
      tenantId: this.#corpId,
      userId,
      authenticatedAt: this.#now(),
    };
  }

  async #exchangeUserToken(code: string): Promise<{ accessToken: string; corpId: string }> {
    const payload = await this.#requestJson(
      "/v1.0/oauth2/userAccessToken",
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          clientId: this.#clientId,
          clientSecret: this.#clientSecret,
          code,
          grantType: "authorization_code",
        }),
      },
      "DingTalk rejected the OAuth authorization code.",
    );
    return {
      accessToken: requiredString(payload.accessToken, "DingTalk OAuth did not return an accessToken."),
      corpId: requiredString(payload.corpId, "DingTalk OAuth did not return a corpId."),
    };
  }

  async #getUserProfile(accessToken: string): Promise<Record<string, unknown>> {
    return this.#requestJson(
      "/v1.0/contact/users/me",
      {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-acs-dingtalk-access-token": accessToken,
        },
      },
      "DingTalk rejected the OAuth user identity request.",
    );
  }

  async #requestJson(
    path: string,
    init: RequestInit,
    rejectedMessage: string,
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#apiBaseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new ApprovalMcpError("DINGTALK_AUTH_ERROR", "Unable to reach the DingTalk OAuth endpoint.", {
        cause: error,
        retryable: true,
      });
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ApprovalMcpError("INVALID_RESPONSE", "DingTalk OAuth returned a non-JSON response.", {
        cause: error,
        details: { status: response.status },
        retryable: response.status >= 500,
      });
    }
    const parsed = record(payload);
    if (!response.ok || parsed === undefined) {
      throw new ApprovalMcpError("DINGTALK_AUTH_ERROR", rejectedMessage, {
        details: {
          status: response.status,
          upstreamCode: stringValue(parsed?.code),
          requestId: stringValue(parsed?.requestId ?? parsed?.requestid),
        },
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    return parsed;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value === "") {
    throw new ApprovalMcpError("DINGTALK_AUTH_ERROR", message);
  }
  return value;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}
