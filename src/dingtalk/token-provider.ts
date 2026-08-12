import { ApprovalMcpError } from "../core/errors.js";

type FetchLike = typeof fetch;

interface TokenProviderOptions {
  appKey: string;
  appSecret: string;
  baseUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
  refreshSkewMs?: number;
  timeoutMs?: number;
}

interface TokenResponse {
  accessToken?: unknown;
  expireIn?: unknown;
  code?: unknown;
  message?: unknown;
  requestid?: unknown;
  requestId?: unknown;
}

export class DingTalkTokenProvider {
  readonly #appKey: string;
  readonly #appSecret: string;
  readonly #baseUrl: string;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #refreshSkewMs: number;
  readonly #timeoutMs: number;
  #cached: { token: string; expiresAt: number } | undefined;
  #inFlight: Promise<string> | undefined;

  constructor(options: TokenProviderOptions) {
    this.#appKey = options.appKey;
    this.#appSecret = options.appSecret;
    this.#baseUrl = (options.baseUrl ?? "https://api.dingtalk.com").replace(/\/$/u, "");
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#refreshSkewMs = options.refreshSkewMs ?? 300_000;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  async getToken(): Promise<string> {
    if (this.#cached !== undefined && this.#now() < this.#cached.expiresAt - this.#refreshSkewMs) {
      return this.#cached.token;
    }

    if (this.#inFlight === undefined) {
      this.#inFlight = this.#requestToken().finally(() => {
        this.#inFlight = undefined;
      });
    }
    return this.#inFlight;
  }

  invalidate(): void {
    this.#cached = undefined;
  }

  async #requestToken(): Promise<string> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/v1.0/oauth2/accessToken`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ appKey: this.#appKey, appSecret: this.#appSecret }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new ApprovalMcpError("DINGTALK_AUTH_ERROR", "Unable to reach the DingTalk token endpoint.", {
        cause: error,
        retryable: true,
      });
    }

    const payload = await readJson<TokenResponse>(response);
    if (!response.ok || typeof payload.accessToken !== "string") {
      throw new ApprovalMcpError("DINGTALK_AUTH_ERROR", "DingTalk rejected the application credentials.", {
        details: {
          status: response.status,
          upstreamCode: stringOrUndefined(payload.code),
          upstreamMessage: stringOrUndefined(payload.message),
          requestId: stringOrUndefined(payload.requestid) ?? stringOrUndefined(payload.requestId),
        },
        retryable: response.status >= 500,
      });
    }

    const expireInSeconds = numberOrDefault(payload.expireIn, 7200);
    this.#cached = {
      token: payload.accessToken,
      expiresAt: this.#now() + expireInSeconds * 1000,
    };
    return payload.accessToken;
  }
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new ApprovalMcpError("INVALID_RESPONSE", "DingTalk returned a non-JSON token response.", {
      cause: error,
      details: { status: response.status },
      retryable: response.status >= 500,
    });
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}
