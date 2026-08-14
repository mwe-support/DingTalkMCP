import { createHmac } from "node:crypto";

import {
  DEFAULT_AUDIT_WRITE_TIMEOUT_MS,
  runAuditWriteWithinTimeout,
  type DailyJsonLineAuditStore,
} from "../core/audit-log.js";

export type SecurityAuditEventName =
  | "consent_approved"
  | "consent_denied"
  | "login_succeeded"
  | "login_failed"
  | "tenant_mismatch"
  | "scope_rejected"
  | "refresh_replay"
  | "token_revoked";

export interface SecurityAuditEventInput {
  event: SecurityAuditEventName;
  outcome: "succeeded" | "rejected" | "failed";
  tenantId?: string;
  subject?: string;
  clientId?: string;
  reasonCode?: string;
}

export interface SecurityAuditSink {
  record(event: SecurityAuditEventInput): void | Promise<void>;
}

export class AuditPseudonymizer {
  readonly #secret: string;

  constructor(secret: string) {
    if (Buffer.byteLength(secret, "utf8") < 16) throw new Error("Audit pseudonym key must be at least 16 bytes.");
    this.#secret = secret;
  }

  subject(tenantId: string, subject: string): string {
    return this.#hash("subject", tenantId, subject);
  }

  client(clientId: string): string {
    return this.#hash("client", "mcp", clientId);
  }

  #hash(kind: string, namespace: string, value: string): string {
    return `v1:${createHmac("sha256", this.#secret).update(`${kind}\0${namespace}\0${value}`).digest("base64url")}`;
  }
}

export class RetainedSecurityAuditSink implements SecurityAuditSink {
  readonly #store: DailyJsonLineAuditStore;
  readonly #pseudonymizer: AuditPseudonymizer;

  constructor(store: DailyJsonLineAuditStore, pseudonymizer: AuditPseudonymizer) {
    this.#store = store;
    this.#pseudonymizer = pseudonymizer;
  }

  record(event: SecurityAuditEventInput): Promise<void> {
    return this.#store.append("oauth_security", {
      timestamp: new Date().toISOString(),
      event: event.event,
      outcome: event.outcome,
      ...(event.subject === undefined || event.tenantId === undefined
        ? {}
        : { subjectHash: this.#pseudonymizer.subject(event.tenantId, event.subject) }),
      ...(event.clientId === undefined ? {} : { clientHash: this.#pseudonymizer.client(event.clientId) }),
      ...(event.reasonCode === undefined ? {} : { reasonCode: event.reasonCode }),
    });
  }
}

export class BoundedSecurityAuditSink implements SecurityAuditSink {
  readonly #delegate: SecurityAuditSink;
  readonly #timeoutMs: number;

  constructor(delegate: SecurityAuditSink, timeoutMs = DEFAULT_AUDIT_WRITE_TIMEOUT_MS) {
    this.#delegate = delegate;
    this.#timeoutMs = timeoutMs;
  }

  record(event: SecurityAuditEventInput): Promise<void> {
    return runAuditWriteWithinTimeout(() => this.#delegate.record(event), this.#timeoutMs);
  }
}
