export type ApprovalMcpErrorCode =
  | "CONFIGURATION_ERROR"
  | "DINGTALK_AUTH_ERROR"
  | "DINGTALK_API_ERROR"
  | "CONFIRMATION_REQUIRED"
  | "WRITE_ACTOR_NOT_ALLOWED"
  | "PROCESS_CODE_NOT_ALLOWED"
  | "IDEMPOTENCY_CONFLICT"
  | "TASK_NOT_ACTIONABLE"
  | "TASK_ACTOR_MISMATCH"
  | "INSTANCE_NOT_REVOCABLE"
  | "ATTACHMENT_URL_REJECTED"
  | "ATTACHMENT_DOWNLOAD_FAILED"
  | "ATTACHMENT_TOO_LARGE"
  | "INVALID_RESPONSE";

export class ApprovalMcpError extends Error {
  readonly code: ApprovalMcpErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(
    code: ApprovalMcpErrorCode,
    message: string,
    options: { cause?: unknown; details?: Record<string, unknown>; retryable?: boolean } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ApprovalMcpError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}

export function errorPayload(error: unknown): Record<string, unknown> {
  if (error instanceof ApprovalMcpError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }

  return {
    error: {
      code: "INTERNAL_ERROR",
      message: "The approval MCP operation failed unexpectedly.",
      retryable: false,
    },
  };
}
