export type ApprovalAuditAction = "start" | "approve" | "reject" | "revoke";
export type ApprovalAuditOutcome = "succeeded" | "rejected" | "failed" | "uncertain";

export interface ApprovalAuditContext {
  action: ApprovalAuditAction;
  actorUserId: string;
  processInstanceId?: string;
  processCode?: string;
  taskId?: string;
  requestId?: string;
}

export interface ApprovalAuditEvent extends ApprovalAuditContext {
  timestamp: string;
  outcome: ApprovalAuditOutcome;
  errorCode?: string;
  returnedInstanceId?: string;
  upstreamRequestId?: string;
}

export interface ApprovalAuditSink {
  record(event: ApprovalAuditEvent): void | Promise<void>;
}

export class JsonLineAuditSink implements ApprovalAuditSink {
  readonly #stream: NodeJS.WritableStream;

  constructor(stream: NodeJS.WritableStream = process.stderr) {
    this.#stream = stream;
  }

  record(event: ApprovalAuditEvent): void {
    this.#stream.write(`${JSON.stringify({ type: "approval_audit", ...event })}\n`);
  }
}

export const noopAuditSink: ApprovalAuditSink = { record: () => undefined };
