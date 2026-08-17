import { createHash, randomUUID } from "node:crypto";

import { noopAuditSink, type ApprovalAuditContext, type ApprovalAuditSink } from "../core/audit.js";
import { ApprovalMcpError, type ApprovalMcpErrorCode } from "../core/errors.js";
import {
  InMemoryIdempotencyLedger,
  type IdempotencyLedger,
} from "../core/idempotency.js";
import { getDingTalkRequestId, type DingTalkApiClient } from "../dingtalk/client.js";
import {
  AttachmentLinkPolicy,
  extractApprovalAttachments,
  type AttachmentClientDownload,
  type ApprovalAttachmentSource,
} from "./attachments.js";
import { array, asRecord, normalizeProcessInstance, text, unwrapResult } from "./normalize.js";
import type { ApprovalCaller, McpScope } from "../auth/types.js";
import {
  APPROVAL_REQUEST_CONTRACTS,
  approvalRequestTemplateForProcessCode,
  assertApprovalRequestTemplateSchema,
  assertAttachmentFieldAllowed,
  buildApprovalFormComponentValues,
  parseApprovalRequestFields,
  type ApprovalAttachmentField,
  type ApprovalAttachmentFormValue,
  type ApprovalRequestFields,
  type ApprovalRequestTemplate,
  type ApplicantFormContext,
} from "./request-templates.js";

type ApiPort = Pick<DingTalkApiClient, "request"> &
  Partial<Pick<DingTalkApiClient, "getUserProfile" | "getDepartmentProfile">>;

export interface StartProcessInstanceInput {
  [key: string]: unknown;
  confirm: boolean;
  dryRun?: boolean | undefined;
  requestId: string;
  processCode: string;
  originatorUserId?: string | undefined;
  deptId?: number | undefined;
  formComponentValues: unknown[];
  approvers?: unknown[] | undefined;
  ccList?: string[] | undefined;
  ccPosition?: string | undefined;
  targetSelectActioners?: unknown[] | undefined;
}

export interface ExecuteTaskInput {
  confirm: boolean;
  dryRun?: boolean | undefined;
  correlationId?: string | undefined;
  processInstanceId: string;
  taskId: string | number;
  requestId: string;
  actionerUserId?: string | undefined;
  result: "agree" | "refuse";
  remark?: string | undefined;
  file?: unknown;
}

export interface RevokeProcessInstanceInput {
  confirm: boolean;
  dryRun?: boolean | undefined;
  processInstanceId: string;
  requestId?: string | undefined;
  operatingUserId?: string | undefined;
  remark?: string | undefined;
}

interface ApprovalServiceOptions {
  api: ApiPort;
  attachmentLinkPolicy?: AttachmentLinkPolicy;
  writeUserIds?: Iterable<string>;
  callerUserId?: string;
  callerUnionId?: string;
  agentId?: number;
  uploadHostSuffixes?: Iterable<string>;
  allowedProcessCodes?: Iterable<string>;
  audit?: ApprovalAuditSink;
  idempotencyLedger?: IdempotencyLedger;
  callerScopes?: Iterable<McpScope>;
}

export interface GetApprovalInstanceInput {
  processInstanceId: string;
  attachmentAction?: "list" | "download";
  attachmentIds?: string[];
  maxAttachments?: number;
}

export interface ApprovalAttachmentDownloadResult {
  ok: boolean;
  fileId: string;
  source?: ApprovalAttachmentSource;
  fileName?: string;
  download?: AttachmentClientDownload;
  error?: {
    code: ApprovalMcpErrorCode | "INTERNAL_ERROR";
    message: string;
    retryable: boolean;
  };
}

export type ApprovalTaskInput =
  | {
      action: "view";
      processInstanceId: string;
      attachmentAction?: "list" | undefined;
    }
  | {
      action: "view";
      processInstanceId: string;
      attachmentAction: "download";
      attachmentIds: string[];
      maxAttachments?: number | undefined;
    }
  | {
      action: "approve" | "reject";
      processInstanceId: string;
      taskId: string | number;
      requestId: string;
      confirm: boolean;
      dryRun?: boolean | undefined;
      remark?: string | undefined;
    };

export interface ApprovalTaskEnvelope {
  processInstanceId: string;
  action: "view" | "approve" | "reject";
  currentStatus: string;
  auditCorrelationId: string;
  safeNextActions: Array<"view" | "approve" | "reject">;
  data: unknown;
}

export type ApprovalRequestInput =
  | {
      action: "prepare";
      template: ApprovalRequestTemplate;
      deptId?: number | undefined;
      fields: unknown;
      attachments?: Array<{ field: ApprovalAttachmentField; fileName: string; fileSize: number }> | undefined;
      confirm?: boolean | undefined;
      dryRun?: boolean | undefined;
    }
  | {
      action: "submit";
      template: ApprovalRequestTemplate;
      deptId?: number | undefined;
      fields: unknown;
      uploads?: Array<{
        field: ApprovalAttachmentField;
        fileName: string;
        fileSize: number;
        uploadKey: string;
        spaceId: string | number;
      }> | undefined;
      confirm: boolean;
      dryRun?: boolean | undefined;
      requestId: string;
    }
  | {
      action: "comment";
      processInstanceId: string;
      text: string;
      requestId: string;
      confirm: boolean;
      dryRun?: boolean | undefined;
    }
  | {
      action: "revoke";
      processInstanceId: string;
      requestId: string;
      confirm: boolean;
      dryRun?: boolean | undefined;
      remark?: string | undefined;
    };

export interface ApprovalRequestEnvelope {
  processInstanceId?: string;
  action: "prepare" | "submit" | "comment" | "revoke";
  template?: ApprovalRequestTemplate;
  currentStatus: string;
  auditCorrelationId: string;
  safeNextActions: Array<"prepare" | "submit" | "comment" | "revoke">;
  data: unknown;
}

const ACTIVE_TASK_STATUSES = new Set(["NEW", "PENDING", "RUNNING", "TODO"]);
const CLIENT_ATTACHMENT_HANDLING = {
  mode: "agent_client",
  agentMustDownload: true,
  agentMustIdentify: true,
  agentMustValidateRedirects: true,
  serverDownloadsFiles: false,
  serverParsesFiles: false,
  serverPerformsOcr: false,
  instruction:
    "The Agent client must promptly download each temporary downloadUrl, revalidate HTTPS hosts across redirects, enforce its own size and content-safety limits, then identify or parse the file and run OCR locally when needed. The MCP server never downloads, parses, or OCRs attachment content.",
} as const;

export class ApprovalService {
  readonly #api: ApiPort;
  readonly #attachmentLinkPolicy: AttachmentLinkPolicy;
  readonly #writeUserIds: Set<string>;
  readonly #callerUserId: string | undefined;
  readonly #callerUnionId: string | undefined;
  readonly #agentId: number | undefined;
  readonly #uploadHostSuffixes: Set<string>;
  readonly #callerScopes: Set<McpScope> | undefined;
  readonly #allowedProcessCodes: Set<string>;
  readonly #audit: ApprovalAuditSink;
  readonly #idempotencyLedger: IdempotencyLedger;
  readonly #startRequests = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  readonly #decisionRequests = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  readonly #approvalRequestSubmissions = new Map<
    string,
    { fingerprint: string; promise: Promise<ApprovalRequestEnvelope> }
  >();
  readonly #approvalRequestRevocations = new Map<
    string,
    { fingerprint: string; promise: Promise<ApprovalRequestEnvelope> }
  >();

  constructor(options: ApprovalServiceOptions) {
    this.#api = options.api;
    this.#attachmentLinkPolicy = options.attachmentLinkPolicy ?? new AttachmentLinkPolicy();
    this.#writeUserIds = new Set(options.writeUserIds ?? []);
    this.#callerUserId = options.callerUserId;
    this.#callerUnionId = options.callerUnionId;
    this.#agentId = options.agentId;
    this.#uploadHostSuffixes = new Set(
      [...(options.uploadHostSuffixes ?? [".trans.dingtalk.com", ".aliyuncs.com"])]
        .map((suffix) => suffix.trim().toLowerCase())
        .filter(Boolean),
    );
    this.#callerScopes = options.callerScopes === undefined ? undefined : new Set(options.callerScopes);
    this.#allowedProcessCodes = new Set(options.allowedProcessCodes ?? []);
    this.#audit = options.audit ?? noopAuditSink;
    this.#idempotencyLedger = options.idempotencyLedger ?? new InMemoryIdempotencyLedger();
  }

  forCaller(caller: ApprovalCaller): ApprovalService {
    return new ApprovalService({
      api: this.#api,
      attachmentLinkPolicy: this.#attachmentLinkPolicy,
      callerUserId: caller.userId,
      callerUnionId: caller.subject,
      ...(this.#agentId === undefined ? {} : { agentId: this.#agentId }),
      uploadHostSuffixes: this.#uploadHostSuffixes,
      callerScopes: caller.scopes,
      writeUserIds: caller.scopes.some((scope) => scope === "approval:decide" || scope === "approval:create")
        ? [caller.userId]
        : [],
      allowedProcessCodes: this.#allowedProcessCodes,
      audit: this.#audit,
      idempotencyLedger: this.#idempotencyLedger,
    });
  }

  async getProcessInstanceDetail(processInstanceId: string): Promise<{
    normalized: ReturnType<typeof normalizeProcessInstance>;
    raw: unknown;
  }> {
    const payload = await this.#api.request({
      method: "GET",
      path: "/v1.0/workflow/processInstances",
      query: { processInstanceId },
    });
    const raw = unwrapResult(payload);
    return { normalized: normalizeProcessInstance(raw), raw };
  }

  async getApprovalInstance(input: GetApprovalInstanceInput): Promise<{
    processInstanceId: string;
    normalized: ReturnType<typeof normalizeProcessInstance>;
    raw: unknown;
    attachments: ReturnType<typeof extractApprovalAttachments>;
    attachmentDownloads: ApprovalAttachmentDownloadResult[];
  }> {
    const detail = await this.getProcessInstanceDetail(input.processInstanceId);
    this.#assertCallerCanView(detail.normalized);
    const attachments = extractApprovalAttachments(detail.raw);
    const attachmentDownloads =
      input.attachmentAction === "download"
        ? await this.#prepareSelectedAttachmentDownloads(
            input.processInstanceId,
            attachments,
            input.attachmentIds ?? [],
            input.maxAttachments ?? 3,
          )
        : [];
    return {
      processInstanceId: input.processInstanceId,
      normalized: detail.normalized,
      raw: detail.raw,
      attachments,
      attachmentDownloads,
    };
  }

  async approvalTask(input: ApprovalTaskInput): Promise<ApprovalTaskEnvelope> {
    const auditCorrelationId = randomUUID();
    if (input.action === "view") {
      this.#assertScope("approval:read");
      const approval = await this.getApprovalInstance({
        processInstanceId: input.processInstanceId,
        ...(input.attachmentAction === undefined ? {} : { attachmentAction: input.attachmentAction }),
        ...(input.attachmentAction === "download"
          ? {
              attachmentIds: input.attachmentIds,
              ...(input.maxAttachments === undefined ? {} : { maxAttachments: input.maxAttachments }),
            }
          : {}),
      });
      const actionableTasks = approval.normalized.tasks.filter((task) => {
        const status = text(asRecord(task)?.status)?.toUpperCase();
        return status !== undefined && ACTIVE_TASK_STATUSES.has(status);
      });
      const callerCanDecide =
        this.#callerUserId !== undefined &&
        this.#writeUserIds.has(this.#callerUserId) &&
        actionableTasks.some((task) => {
          const record = asRecord(task);
          return text(record?.userId ?? record?.actionerUserId) === this.#callerUserId;
        });
      return {
        processInstanceId: input.processInstanceId,
        action: input.action,
        currentStatus: approval.normalized.status?.toUpperCase() ?? "UNKNOWN",
        auditCorrelationId,
        safeNextActions: callerCanDecide ? ["view", "approve", "reject"] : ["view"],
        data: {
          normalized: approval.normalized,
          attachments: approval.attachments,
          attachmentHandling: CLIENT_ATTACHMENT_HANDLING,
          attachmentDownloads: approval.attachmentDownloads,
          actionableTasks,
        },
      };
    }
    this.#assertScope("approval:read");
    this.#assertScope("approval:decide");
    const upstreamResult = await this.executeTask({
      confirm: input.confirm,
      ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
      correlationId: auditCorrelationId,
      processInstanceId: input.processInstanceId,
      taskId: input.taskId,
      requestId: input.requestId,
      result: input.action === "approve" ? "agree" : "refuse",
      ...(input.remark === undefined ? {} : { remark: input.remark }),
    });
    let current: Awaited<ReturnType<ApprovalService["getProcessInstanceDetail"]>> | undefined;
    try {
      current = await this.getProcessInstanceDetail(input.processInstanceId);
    } catch {
      // The decision has already succeeded or was a dry run. A failed refresh must
      // never turn that outcome into a mutation error that invites a duplicate retry.
    }
    return {
      processInstanceId: input.processInstanceId,
      action: input.action,
      currentStatus: current?.normalized.status?.toUpperCase() ?? "UNKNOWN",
      auditCorrelationId,
      safeNextActions: input.dryRun === true ? ["view", input.action] : ["view"],
      data: {
        taskId: String(input.taskId),
        dryRun: input.dryRun === true,
        upstreamResult,
        postActionRefresh: { ok: current !== undefined },
        ...(current === undefined ? {} : { normalized: current.normalized }),
      },
    };
  }

  async approvalRequest(input: ApprovalRequestInput): Promise<ApprovalRequestEnvelope> {
    const auditCorrelationId = randomUUID();
    this.#assertScope("approval:read");
    if (input.action === "comment") {
      this.#assertScope("approval:create");
      const current = await this.getProcessInstanceDetail(input.processInstanceId);
      const template = approvalRequestTemplateForProcessCode(current.normalized.processCode);
      if (template === undefined) {
        throw new ApprovalMcpError(
          "PROCESS_CODE_NOT_ALLOWED",
          "approval_request can comment only on an instance of an allowlisted request template.",
        );
      }
      const actorUserId = this.#requireCallerUserId();
      if (current.normalized.originatorUserId !== actorUserId) {
        throw new ApprovalMcpError(
          "APPROVAL_COMMENT_FORBIDDEN",
          "approval_request can comment only on an approval initiated by the authenticated applicant.",
        );
      }
      if (input.dryRun === true) {
        return {
          processInstanceId: input.processInstanceId,
          action: "comment",
          template,
          currentStatus: "COMMENTABLE",
          auditCorrelationId,
          safeNextActions: current.normalized.status?.toUpperCase() === "RUNNING"
            ? ["comment", "revoke"]
            : ["comment"],
          data: { dryRun: true, textLength: input.text.length },
        };
      }
      this.#assertConfirmedActor(input.confirm, actorUserId);
      const fingerprint = createHash("sha256").update(stableStringify({
        actorUserId,
        processInstanceId: input.processInstanceId,
        text: input.text,
      })).digest("hex");
      return this.#commentApprovalRequestIdempotently({
        actorUserId,
        auditCorrelationId,
        fingerprint,
        input,
        template,
        instanceStatus: current.normalized.status?.toUpperCase(),
      });
    }
    if (input.action === "revoke") {
      this.#assertScope("approval:create");
      const current = await this.getProcessInstanceDetail(input.processInstanceId);
      const template = approvalRequestTemplateForProcessCode(current.normalized.processCode);
      if (template === undefined) {
        throw new ApprovalMcpError(
          "PROCESS_CODE_NOT_ALLOWED",
          "approval_request can revoke only an instance of an allowlisted request template.",
        );
      }
      const actorUserId = this.#requireCallerUserId();
      const fingerprint = createHash("sha256").update(stableStringify({
        actorUserId,
        processInstanceId: input.processInstanceId,
        remark: input.remark,
      })).digest("hex");
      if (input.dryRun === true) {
        const upstreamResult = await this.revokeProcessInstance({
          processInstanceId: input.processInstanceId,
          requestId: input.requestId,
          confirm: input.confirm,
          dryRun: true,
          ...(input.remark === undefined ? {} : { remark: input.remark }),
        });
        return {
          processInstanceId: input.processInstanceId,
          action: "revoke",
          template,
          currentStatus: "REVOCABLE",
          auditCorrelationId,
          safeNextActions: ["revoke"],
          data: { dryRun: true, upstreamResult },
        };
      }
      const existing = this.#approvalRequestRevocations.get(input.requestId);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new ApprovalMcpError(
            "IDEMPOTENCY_CONFLICT",
            "The requestId was already used with a different approval revocation payload.",
          );
        }
        return existing.promise;
      }
      const revocation = this.#revokeApprovalRequestIdempotently({
        actorUserId,
        auditCorrelationId,
        fingerprint,
        input,
        template,
      }).catch((error: unknown) => {
        if (!(error instanceof ApprovalMcpError) || error.code !== "IDEMPOTENCY_OUTCOME_UNKNOWN") {
          this.#approvalRequestRevocations.delete(input.requestId);
        }
        throw error;
      });
      this.#approvalRequestRevocations.set(input.requestId, { fingerprint, promise: revocation });
      if (this.#approvalRequestRevocations.size > 1000) {
        const oldest = this.#approvalRequestRevocations.keys().next().value as string | undefined;
        if (oldest !== undefined && oldest !== input.requestId) this.#approvalRequestRevocations.delete(oldest);
      }
      return revocation;
    }
    this.#assertScope("approval:create");
    const contract = APPROVAL_REQUEST_CONTRACTS[input.template];
    this.#assertProcessAllowed(contract.processCode);
    const fields = parseApprovalRequestFields(input.template, input.fields);
    const schema = await this.#api.request({
      method: "GET",
      path: "/v1.0/workflow/forms/schemas/processCodes",
      query: { processCode: contract.processCode },
    });
    assertApprovalRequestTemplateSchema(input.template, schema);
    const applicant = await this.#resolveApplicantContext(input.deptId);
    const formComponentValues = buildApprovalFormComponentValues(input.template, fields, applicant);
    const draft = {
      processCode: contract.processCode,
      deptId: applicant.deptId,
      formComponentValues,
    };
    if (input.action === "prepare") {
      const attachments = input.attachments ?? [];
      for (const attachment of attachments) {
        assertAttachmentFieldAllowed(input.template, attachment.field);
        assertUploadFileName(attachment.fileName);
      }
      assertAttachmentBatchSize(attachments);
      if (input.dryRun === true || attachments.length === 0) {
        return {
          action: "prepare",
          template: input.template,
          currentStatus: attachments.length === 0 ? "READY_TO_SUBMIT" : "VALIDATED",
          auditCorrelationId,
          safeNextActions: ["submit"],
          data: { dryRun: input.dryRun === true, draft, uploadInstructions: [] },
        };
      }
      if (input.confirm !== true) {
        throw new ApprovalMcpError(
          "CONFIRMATION_REQUIRED",
          "Preparing DingTalk attachment upload slots requires explicit confirmation.",
        );
      }
      const uploadInstructions = await this.#prepareApprovalUploads(attachments);
      return {
        action: "prepare",
        template: input.template,
        currentStatus: "READY_FOR_UPLOAD",
        auditCorrelationId,
        safeNextActions: ["submit"],
        data: {
          dryRun: false,
          draft,
          uploadInstructions,
          clientInstruction:
            "The Agent client must PUT each file directly to uploadUrl using the exact returned headers, without sending file bytes to this MCP server or following upload redirects. After every PUT succeeds, call approval_request action=submit with the matching field, fileName, fileSize, uploadKey, and spaceId.",
        },
      };
    }
    if (input.action === "submit" && input.dryRun === true) {
      return {
        action: "submit",
        template: input.template,
        currentStatus: "VALIDATED",
        auditCorrelationId,
        safeNextActions: ["submit"],
        data: { dryRun: true, draft },
      };
    }
    if (input.action === "submit") {
      const uploads = input.uploads ?? [];
      for (const upload of uploads) {
        assertAttachmentFieldAllowed(input.template, upload.field);
        assertUploadFileName(upload.fileName);
      }
      assertAttachmentBatchSize(uploads);
      const actorUserId = this.#requireCallerUserId();
      this.#assertConfirmedActor(input.confirm, actorUserId);
      if (input.requestId.trim() === "") {
        throw new ApprovalMcpError("IDEMPOTENCY_KEY_REQUIRED", "Submitting an approval requires a stable requestId UUID.");
      }
      const fingerprintInput = {
        actorUserId,
        template: input.template,
        deptId: applicant.deptId,
        fields,
        uploads,
      };
      const fingerprint = createHash("sha256").update(stableStringify(fingerprintInput)).digest("hex");
      const existing = this.#approvalRequestSubmissions.get(input.requestId);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new ApprovalMcpError(
            "IDEMPOTENCY_CONFLICT",
            "The requestId was already used with a different approval request payload.",
          );
        }
        return existing.promise;
      }
      const submission = this.#audited(
        {
          action: "start",
          actorUserId,
          correlationId: auditCorrelationId,
          processCode: contract.processCode,
          requestId: input.requestId,
        },
        () => this.#submitApprovalRequestIdempotently({
          requestId: input.requestId,
          fingerprint,
          template: input.template,
          deptId: applicant.deptId,
          processCode: contract.processCode,
          originatorUserId: actorUserId,
          fields,
          applicant,
          uploads,
          auditCorrelationId,
        }),
      ).catch((error: unknown) => {
        if (!(error instanceof ApprovalMcpError) || error.code !== "IDEMPOTENCY_OUTCOME_UNKNOWN") {
          this.#approvalRequestSubmissions.delete(input.requestId);
        }
        throw error;
      });
      this.#approvalRequestSubmissions.set(input.requestId, { fingerprint, promise: submission });
      if (this.#approvalRequestSubmissions.size > 1000) {
        const oldest = this.#approvalRequestSubmissions.keys().next().value as string | undefined;
        if (oldest !== undefined && oldest !== input.requestId) this.#approvalRequestSubmissions.delete(oldest);
      }
      return submission;
    }
    throw new ApprovalMcpError("CONFIGURATION_ERROR", "The requested approval_request action is not configured yet.");
  }

  async queryProcessInstanceIds(input: Record<string, unknown>): Promise<unknown> {
    const processCode = text(input.processCode);
    this.#assertOptionalProcessAllowed(processCode);
    return this.#api.request({
      method: "POST",
      path: "/v1.0/workflow/processes/instanceIds/query",
      body: input,
    });
  }

  async getProcessInstanceRecords(processInstanceId: string): Promise<unknown[]> {
    const detail = await this.getProcessInstanceDetail(processInstanceId);
    return detail.normalized.operationRecords;
  }

  async listPendingTasks(processInstanceId: string): Promise<unknown[]> {
    const detail = await this.getProcessInstanceDetail(processInstanceId);
    return detail.normalized.tasks.filter((task) => {
      const status = text(asRecord(task)?.status)?.toUpperCase();
      return status === undefined || ACTIVE_TASK_STATUSES.has(status);
    });
  }

  async listUserVisibleProcesses(input: {
    userId: string;
    nextToken?: number | undefined;
    maxResults?: number | undefined;
  }): Promise<unknown> {
    return this.#api.request({
      method: "GET",
      path: "/v1.0/workflow/processes/userVisibilities/templates",
      query: withoutUndefined({
        userId: input.userId,
        nextToken: input.nextToken,
        maxResults: input.maxResults,
      }),
    });
  }

  async getProcessSchema(processCode: string): Promise<unknown> {
    this.#assertProcessAllowed(processCode);
    return this.#api.request({
      method: "GET",
      path: "/v1.0/workflow/forms/schemas/processCodes",
      query: { processCode },
    });
  }

  async forecastProcess(input: Record<string, unknown>): Promise<unknown> {
    const processCode = text(input.processCode);
    this.#assertOptionalProcessAllowed(processCode);
    return this.#api.request({
      method: "POST",
      path: "/v1.0/workflow/processes/forecast",
      body: input,
    });
  }

  async startProcessInstance(input: StartProcessInstanceInput): Promise<unknown> {
    const actorUserId = this.#resolveCaller(input.originatorUserId);
    this.#assertActorAllowed(actorUserId);
    this.#assertProcessAllowed(input.processCode);
    if (input.dryRun === true) {
      return {
        dryRun: true,
        action: "start",
        processCode: input.processCode,
        formComponentCount: input.formComponentValues.length,
        requestIdPresent: input.requestId.trim() !== "",
      };
    }
    return this.#audited(
      {
        action: "start",
        actorUserId,
        processCode: input.processCode,
        requestId: input.requestId,
      },
      async () => {
        this.#assertConfirmedActor(input.confirm, actorUserId);
        if (input.requestId.trim() === "") {
          throw new ApprovalMcpError(
            "IDEMPOTENCY_KEY_REQUIRED",
            "Starting an approval requires a stable requestId UUID.",
          );
        }
        const body = { ...omit(input, ["confirm", "dryRun", "requestId"]), originatorUserId: actorUserId };
        const fingerprint = createHash("sha256").update(stableStringify(body)).digest("hex");
        const existing = this.#startRequests.get(input.requestId);
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            throw new ApprovalMcpError(
              "IDEMPOTENCY_CONFLICT",
              "The requestId was already used with a different approval creation payload.",
            );
          }
          return existing.promise;
        }

        const request = this.#createIdempotently(input.requestId, fingerprint, body).catch((error: unknown) => {
          if (!(error instanceof ApprovalMcpError) || error.code !== "IDEMPOTENCY_OUTCOME_UNKNOWN") {
            this.#startRequests.delete(input.requestId);
          }
          throw error;
        });
        this.#startRequests.set(input.requestId, { fingerprint, promise: request });
        if (this.#startRequests.size > 1000) {
          const oldest = this.#startRequests.keys().next().value as string | undefined;
          if (oldest !== undefined && oldest !== input.requestId) this.#startRequests.delete(oldest);
        }
        return request;
      }
    );
  }

  async executeTask(input: ExecuteTaskInput): Promise<unknown> {
    const actorUserId = this.#resolveCaller(input.actionerUserId);
    this.#assertActorAllowed(actorUserId);
    const remark = input.remark?.trim();
    if (input.result === "refuse" && (remark === undefined || remark === "")) {
      throw new ApprovalMcpError("INVALID_INPUT", "Rejecting an approval requires a non-empty business reason.");
    }
    if (input.dryRun === true) {
      await this.#assertTaskActionable(input.processInstanceId, input.taskId, actorUserId);
      return {
        dryRun: true,
        action: input.result === "agree" ? "approve" : "reject",
        processInstanceId: input.processInstanceId,
        taskId: String(input.taskId),
        requestIdPresent: input.requestId.trim() !== "",
      };
    }
    return this.#audited(
      {
        action: input.result === "agree" ? "approve" : "reject",
        actorUserId,
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        processInstanceId: input.processInstanceId,
        taskId: String(input.taskId),
        requestId: input.requestId,
      },
      async () => {
        this.#assertConfirmedActor(input.confirm, actorUserId);
        if (input.requestId.trim() === "") {
          throw new ApprovalMcpError(
            "IDEMPOTENCY_KEY_REQUIRED",
            "An approval decision requires a stable requestId UUID.",
          );
        }
        const body = {
          ...omit(input, ["confirm", "dryRun", "correlationId", "actionerUserId", "requestId", "remark"]),
          ...(remark === undefined || remark === "" ? {} : { remark }),
          actionerUserId: actorUserId,
        };
        const fingerprint = createHash("sha256").update(stableStringify(body)).digest("hex");
        const existing = this.#decisionRequests.get(input.requestId);
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            throw new ApprovalMcpError(
              "IDEMPOTENCY_CONFLICT",
              "The requestId was already used with a different approval decision payload.",
            );
          }
          return existing.promise;
        }
        const request = this.#executeTaskIdempotently(
          input.requestId,
          fingerprint,
          input.processInstanceId,
          input.taskId,
          actorUserId,
          body,
        ).catch((error: unknown) => {
          if (!(error instanceof ApprovalMcpError) || error.code !== "IDEMPOTENCY_OUTCOME_UNKNOWN") {
            this.#decisionRequests.delete(input.requestId);
          }
          throw error;
        });
        this.#decisionRequests.set(input.requestId, { fingerprint, promise: request });
        if (this.#decisionRequests.size > 1000) {
          const oldest = this.#decisionRequests.keys().next().value as string | undefined;
          if (oldest !== undefined && oldest !== input.requestId) this.#decisionRequests.delete(oldest);
        }
        return request;
      },
    );
  }

  async revokeProcessInstance(input: RevokeProcessInstanceInput): Promise<unknown> {
    const actorUserId = this.#resolveCaller(input.operatingUserId);
    this.#assertActorAllowed(actorUserId);
    if (input.dryRun === true) {
      await this.#assertRevocable(input.processInstanceId, actorUserId);
      return { dryRun: true, action: "revoke", processInstanceId: input.processInstanceId };
    }
    return this.#audited(
      {
        action: "revoke",
        actorUserId,
        processInstanceId: input.processInstanceId,
        ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      },
      async () => {
        this.#assertConfirmedActor(input.confirm, actorUserId);
        await this.#assertRevocable(input.processInstanceId, actorUserId);
        return this.#api.request({
          method: "POST",
          path: "/v1.0/workflow/processInstances/terminate",
          body: {
            ...omit(input, ["confirm", "dryRun", "operatingUserId", "requestId"]),
            operatingUserId: actorUserId,
            isSystem: false,
          },
        });
      },
    );
  }

  async listApprovalAttachments(processInstanceId: string): Promise<ReturnType<typeof extractApprovalAttachments>> {
    const detail = await this.getProcessInstanceDetail(processInstanceId);
    return extractApprovalAttachments(detail.raw);
  }

  async getAttachmentDownloadUrl(
    processInstanceId: string,
    fileId: string,
    spaceId: string | undefined,
    options: { fileName?: string; fileType?: string; withCommentAttachment?: boolean } = {},
  ): Promise<{
    fileId?: string;
    spaceId?: string;
    downloadUri: string;
  }> {
    const directFileIdentity =
      options.fileName !== undefined &&
      options.fileName !== "" &&
      options.fileType !== undefined &&
      options.fileType !== ""
        ? { fileName: options.fileName, fileType: options.fileType }
        : undefined;
    if (!options.withCommentAttachment) {
      const callerUserId = this.#requireCallerUserId();
      // Client uploads can report a spaceId even though authDownload rejects
      // that space. DingTalk accepts their fileName + fileType identity here.
      if (directFileIdentity === undefined) {
        if (spaceId !== undefined && spaceId !== "") {
          await this.#api.request({
            method: "POST",
            path: "/v1.0/workflow/processInstances/spaces/files/authDownload",
            body: {
              userId: callerUserId,
              fileInfos: [{ fileId, spaceId }],
            },
          });
        } else {
          throw new ApprovalMcpError(
            "INVALID_INPUT",
            "A form attachment without spaceId requires fileName and fileType.",
          );
        }
      }
    } else {
      this.#requireCallerUserId();
    }
    const payload = await this.#api.request({
      method: "POST",
      path: "/v1.0/workflow/processInstances/spaces/files/urls/download",
      body: {
        processInstanceId,
        fileId,
        ...(options.withCommentAttachment
          ? {
              withCommentAttatchment: true,
            }
          : directFileIdentity !== undefined
            ? directFileIdentity
          : {}),
      },
    });
    const result = asRecord(unwrapResult(payload));
    const downloadUri = text(result?.downloadUri);
    if (downloadUri === undefined) {
      throw new ApprovalMcpError("INVALID_RESPONSE", "DingTalk did not return an attachment download URI.");
    }
    const returnedSpaceId = text(result?.spaceId);
    return {
      fileId: text(result?.fileId) ?? fileId,
      ...(returnedSpaceId === undefined ? {} : { spaceId: returnedSpaceId }),
      downloadUri,
    };
  }

  async #prepareSelectedAttachmentDownloads(
    processInstanceId: string,
    attachments: ReturnType<typeof extractApprovalAttachments>,
    attachmentIds: string[],
    maxAttachments: number,
  ): Promise<ApprovalAttachmentDownloadResult[]> {
    const uniqueIds = [...new Set(attachmentIds)];
    if (uniqueIds.length > maxAttachments) {
      throw new ApprovalMcpError(
        "INVALID_INPUT",
        `This call requests ${uniqueIds.length} attachments but maxAttachments is ${maxAttachments}.`,
      );
    }
    const results: ApprovalAttachmentDownloadResult[] = [];
    for (const fileId of uniqueIds) {
      const attachment = attachments.find((candidate) => candidate.fileId === fileId);
      if (attachment === undefined) {
        results.push({
          ok: false,
          fileId,
          error: {
            code: "ATTACHMENT_NOT_FOUND",
            message: "The requested fileId is not present in this approval instance.",
            retryable: false,
          },
        });
        continue;
      }
      if (attachment.fileName === undefined || attachment.fileName === "") {
        results.push({
          ok: false,
          fileId,
          source: attachment.source,
          error: {
            code: "INVALID_RESPONSE",
            message: "The approval attachment has no usable fileName.",
            retryable: false,
          },
        });
        continue;
      }
      try {
        const info = await this.getAttachmentDownloadUrl(
          processInstanceId,
          fileId,
          attachment.spaceId,
          {
            fileName: attachment.fileName,
            ...(attachment.fileType === undefined ? {} : { fileType: attachment.fileType }),
            withCommentAttachment:
              attachment.source === "operation" || attachment.source === "operation-image",
          },
        );
        results.push({
          ok: true,
          fileId,
          source: attachment.source,
          fileName: attachment.fileName,
          download: this.#attachmentLinkPolicy.createClientDownload(
            info.downloadUri,
            attachment.fileName,
            attachment.fileSize,
          ),
        });
      } catch (error) {
        const known = error instanceof ApprovalMcpError;
        results.push({
          ok: false,
          fileId,
          source: attachment.source,
          fileName: attachment.fileName,
          error: {
            code: known ? error.code : "INTERNAL_ERROR",
            message: known ? error.message : "Preparing the approval attachment link failed unexpectedly.",
            retryable: known ? error.retryable : false,
          },
        });
      }
    }
    return results;
  }

  getCapabilities(): Record<string, unknown> {
    return {
      application: "MWE审批MCP",
      source: "static_configuration",
      tools: {
        detail: true,
        queryInstanceIds: true,
        formSchema: true,
        forecast: true,
        start: this.#writesEnabled(),
        approveReject: this.#writesEnabled(),
        revoke: this.#writesEnabled(),
        listAttachmentMetadata: true,
        combinedDetailAndAttachmentLinks: true,
        returnFormAttachmentLinks: this.#callerUserId !== undefined,
        returnCommentAttachmentLinks: this.#callerUserId !== undefined,
        serverDownloadsAttachments: false,
        serverParsesAttachments: false,
        serverPerformsOcr: false,
        requestTemplates: ["expense_reimbursement", "payment_request"],
        requestTemplateAllowlistExact: true,
        commentOnOwnRequest: this.#writesEnabled(),
        saveToDingTalkDraftBox: false,
        uploadAttachments:
          this.#agentId !== undefined && this.#callerUserId !== undefined && this.#callerUnionId !== undefined,
        uploadTransport: "agent_direct_to_dingtalk",
        eventStream: false,
      },
      writeGuard: {
        enabled: this.#writesEnabled(),
        requiresConfirm: true,
        callerIdentityBound: this.#callerUserId !== undefined,
        allowedActorCount: this.#writeUserIds.size,
      },
      processCodeAllowlistEnabled: this.#allowedProcessCodes.size > 0,
    };
  }

  #assertConfirmedActor(confirm: boolean, actorUserId: string): void {
    if (!confirm) {
      throw new ApprovalMcpError("CONFIRMATION_REQUIRED", "This approval mutation requires explicit confirmation.");
    }
    this.#assertActorAllowed(actorUserId);
  }

  #assertScope(scope: McpScope): void {
    if (this.#callerScopes !== undefined && !this.#callerScopes.has(scope)) {
      throw new ApprovalMcpError("INSUFFICIENT_SCOPE", `The authenticated MCP token requires ${scope}.`);
    }
  }

  #assertCallerCanView(instance: ReturnType<typeof normalizeProcessInstance>): void {
    if (this.#callerScopes === undefined) return;
    const callerUserId = this.#requireCallerUserId();
    const related =
      instance.originatorUserId === callerUserId ||
      instance.tasks.some((task) => {
        const value = asRecord(task);
        return text(value?.userId ?? value?.actionerUserId) === callerUserId;
      }) ||
      instance.operationRecords.some((operation) => {
        const value = asRecord(operation);
        return text(value?.userId ?? value?.actionerUserId ?? value?.operatorUserId) === callerUserId;
      });
    if (!related) {
      throw new ApprovalMcpError(
        "APPROVAL_VIEW_FORBIDDEN",
        "The authenticated DingTalk user is not a verifiable participant in this approval instance.",
      );
    }
  }

  #assertActorAllowed(actorUserId: string): void {
    if (!this.#writeUserIds.has(actorUserId)) {
      throw new ApprovalMcpError(
        "WRITE_ACTOR_NOT_ALLOWED",
        "The DingTalk userId is not authorized for approval mutations by this MCP server.",
      );
    }
  }

  async #assertTaskActionable(
    processInstanceId: string,
    taskId: string | number,
    actorUserId: string,
  ): Promise<void> {
    const current = await this.getProcessInstanceDetail(processInstanceId);
    this.#assertOptionalProcessAllowed(current.normalized.processCode);
    const task = current.normalized.tasks
      .map(asRecord)
      .find((candidate) => text(candidate?.taskId) === String(taskId));
    const taskStatus = text(task?.status)?.toUpperCase();
    if (task === undefined || taskStatus === undefined || !ACTIVE_TASK_STATUSES.has(taskStatus)) {
      throw new ApprovalMcpError(
        "TASK_NOT_ACTIONABLE",
        "The approval task is missing or no longer in an actionable state.",
      );
    }
    const currentActor = text(task.userId ?? task.actionerUserId);
    if (currentActor !== actorUserId) {
      throw new ApprovalMcpError(
        "TASK_ACTOR_MISMATCH",
        "The current approval task does not belong to the server-bound DingTalk caller.",
      );
    }
  }

  async #assertRevocable(processInstanceId: string, actorUserId: string): Promise<void> {
    const current = await this.getProcessInstanceDetail(processInstanceId);
    this.#assertOptionalProcessAllowed(current.normalized.processCode);
    const status = current.normalized.status?.toUpperCase();
    const originatorMatches = current.normalized.originatorUserId === actorUserId;
    if (status !== "RUNNING" || !originatorMatches) {
      throw new ApprovalMcpError(
        "INSTANCE_NOT_REVOCABLE",
        "The approval instance is not running or the operator is not its originator.",
      );
    }
  }

  #resolveCaller(requestedUserId: string | undefined): string {
    const callerUserId = this.#requireCallerUserId();
    if (requestedUserId !== undefined && requestedUserId !== callerUserId) {
      throw new ApprovalMcpError(
        "CALLER_IDENTITY_MISMATCH",
        "The requested approval actor does not match this server credential's bound DingTalk caller.",
      );
    }
    return callerUserId;
  }

  #requireCallerUserId(): string {
    if (this.#callerUserId === undefined || this.#callerUserId === "") {
      throw new ApprovalMcpError(
        "CALLER_IDENTITY_NOT_CONFIGURED",
        "Approval mutations and comment-attachment downloads require an authenticated caller identity.",
      );
    }
    return this.#callerUserId;
  }

  async #resolveApplicantContext(deptId?: number): Promise<{
    deptId: number;
    applicantName: string;
    departmentName: string;
  }> {
    const callerUserId = this.#requireCallerUserId();
    if (this.#api.getUserProfile === undefined || this.#api.getDepartmentProfile === undefined) {
      throw new ApprovalMcpError(
        "CONFIGURATION_ERROR",
        "The DingTalk directory adapter required for approval requests is unavailable.",
      );
    }
    const user = await this.#api.getUserProfile(callerUserId);
    const departmentIds = [...new Set(user.departmentIds)];
    const resolvedDeptId = departmentIds.length === 1
      ? departmentIds[0]
      : deptId !== undefined && departmentIds.includes(deptId)
        ? deptId
        : undefined;
    if (resolvedDeptId === undefined) {
      const departments = await Promise.all(departmentIds.map(async (candidateDeptId) => {
        const department = await this.#api.getDepartmentProfile?.(candidateDeptId);
        if (department === undefined) {
          throw new ApprovalMcpError(
            "CONFIGURATION_ERROR",
            "The DingTalk directory adapter required for approval requests is unavailable.",
          );
        }
        return { deptId: candidateDeptId, name: department.name };
      }));
      throw new ApprovalMcpError(
        "DEPARTMENT_SELECTION_REQUIRED",
        "The authenticated DingTalk applicant belongs to multiple departments; retry with one returned deptId.",
        { details: { departments } },
      );
    }
    const department = await this.#api.getDepartmentProfile(resolvedDeptId);
    return { deptId: resolvedDeptId, applicantName: user.name, departmentName: department.name };
  }

  async #prepareApprovalUploads(
    attachments: Array<{ field: ApprovalAttachmentField; fileName: string; fileSize: number }>,
  ): Promise<Array<Record<string, unknown>>> {
    const { spaceId, unionId } = await this.#resolveApprovalAttachmentSpace();
    const instructions: Array<Record<string, unknown>> = [];
    for (const attachment of attachments) {
      const payload = await this.#api.request({
        method: "POST",
        path: `/v1.0/storage/spaces/${encodeURIComponent(spaceId)}/files/uploadInfos/query`,
        query: { unionId },
        body: {
          protocol: "HEADER_SIGNATURE",
          multipart: false,
          option: {
            storageDriver: "DINGTALK",
            preCheckParam: {
              size: attachment.fileSize,
              parentId: "0",
              name: attachment.fileName,
            },
            preferIntranet: false,
          },
        },
      });
      const record = asRecord(payload);
      const signature = asRecord(record?.headerSignatureInfo);
      const urls = array(signature?.resourceUrls);
      const uploadUrl = text(urls[0]);
      const uploadKey = text(record?.uploadKey);
      const headers = stringRecord(signature?.headers);
      const expiresInSeconds = positiveInteger(signature?.expirationSeconds);
      if (uploadUrl === undefined || uploadKey === undefined || headers === undefined || expiresInSeconds === undefined) {
        throw new ApprovalMcpError("INVALID_RESPONSE", "DingTalk returned incomplete attachment upload information.");
      }
      this.#assertUploadUrlAllowed(uploadUrl);
      instructions.push({
        ...attachment,
        uploadKey,
        spaceId,
        method: "PUT",
        uploadUrl,
        headers,
        expiresInSeconds,
      });
    }
    return instructions;
  }

  async #submitApprovalRequestIdempotently(input: {
    requestId: string;
    fingerprint: string;
    template: ApprovalRequestTemplate;
    deptId: number;
    processCode: string;
    originatorUserId: string;
    fields: ApprovalRequestFields;
    applicant: ApplicantFormContext;
    uploads: Array<{
      field: ApprovalAttachmentField;
      fileName: string;
      fileSize: number;
      uploadKey: string;
      spaceId: string | number;
    }>;
    auditCorrelationId: string;
  }): Promise<ApprovalRequestEnvelope> {
    const ledgerKey = `approval-request:${input.originatorUserId}:${input.requestId}`;
    const reservation = await this.#idempotencyLedger.reserve(ledgerKey, input.fingerprint);
    if (!reservation.created) {
      if (reservation.entry.fingerprint !== input.fingerprint) {
        throw new ApprovalMcpError(
          "IDEMPOTENCY_CONFLICT",
          "The requestId was already used with a different approval request payload.",
        );
      }
      if (reservation.entry.status === "succeeded") {
        return reservation.entry.result as ApprovalRequestEnvelope;
      }
      throw new ApprovalMcpError(
        "IDEMPOTENCY_OUTCOME_UNKNOWN",
        "A previous approval submission may have committed attachments or reached DingTalk.",
      );
    }
    let mutationStarted = false;
    try {
      const committedAttachments: Array<ApprovalAttachmentFormValue & { field: ApprovalAttachmentField }> = [];
      if (input.uploads.length > 0) {
        const currentSpace = await this.#resolveApprovalAttachmentSpace();
        for (const upload of input.uploads) {
          if (scalarText(upload.spaceId) !== currentSpace.spaceId) {
            throw new ApprovalMcpError(
              "INVALID_INPUT",
              "The uploaded attachment spaceId does not belong to the authenticated applicant's approval space.",
            );
          }
          mutationStarted = true;
          const payload = await this.#api.request({
            method: "POST",
            path: `/v1.0/storage/spaces/${encodeURIComponent(currentSpace.spaceId)}/files/commit`,
            query: { unionId: currentSpace.unionId },
            body: {
              uploadKey: upload.uploadKey,
              name: upload.fileName,
              parentId: "0",
              option: { size: upload.fileSize, conflictStrategy: "AUTO_RENAME" },
            },
          });
          committedAttachments.push(normalizeCommittedAttachment(upload, currentSpace.spaceId, payload));
        }
      }
      const byField: Partial<Record<ApprovalAttachmentField, ApprovalAttachmentFormValue[]>> = {};
      for (const attachment of committedAttachments) {
        const list = byField[attachment.field] ?? [];
        list.push({
          fileId: attachment.fileId,
          fileName: attachment.fileName,
          fileSize: attachment.fileSize,
          fileType: attachment.fileType,
          spaceId: attachment.spaceId,
        });
        byField[attachment.field] = list;
      }
      const formComponentValues = buildApprovalFormComponentValues(
        input.template,
        input.fields,
        input.applicant,
        byField,
      );
      mutationStarted = true;
      const upstreamResult = await this.#api.request({
        method: "POST",
        path: "/v1.0/workflow/processInstances",
        body: {
          processCode: input.processCode,
          originatorUserId: input.originatorUserId,
          deptId: input.deptId,
          formComponentValues,
        },
      });
      const returned = asRecord(unwrapResult(upstreamResult));
      const processInstanceId = text(returned?.instanceId ?? returned?.processInstanceId);
      if (processInstanceId === undefined) {
        throw new ApprovalMcpError("INVALID_RESPONSE", "DingTalk did not return the created approval instance ID.");
      }
      const result: ApprovalRequestEnvelope = {
        processInstanceId,
        action: "submit",
        template: input.template,
        currentStatus: "SUBMITTED",
        auditCorrelationId: input.auditCorrelationId,
        safeNextActions: ["comment", "revoke"],
        data: { dryRun: false, upstreamResult, committedAttachments },
      };
      await this.#idempotencyLedger.put(ledgerKey, {
        fingerprint: input.fingerprint,
        status: "succeeded",
        result,
        updatedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      if (!mutationStarted && isKnownPreWriteRejection(error)) {
        await this.#idempotencyLedger.delete(ledgerKey);
        throw error;
      }
      try {
        await this.#idempotencyLedger.put(ledgerKey, {
          fingerprint: input.fingerprint,
          status: "uncertain",
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // The pending reservation still prevents an unsafe automatic replay.
      }
      throw new ApprovalMcpError(
        "IDEMPOTENCY_OUTCOME_UNKNOWN",
        "The approval submission result is uncertain; inspect DingTalk before using a new requestId.",
        { cause: error },
      );
    }
  }

  async #revokeApprovalRequestIdempotently(input: {
    actorUserId: string;
    auditCorrelationId: string;
    fingerprint: string;
    input: Extract<ApprovalRequestInput, { action: "revoke" }>;
    template: ApprovalRequestTemplate;
  }): Promise<ApprovalRequestEnvelope> {
    const ledgerKey = `approval-request-revoke:${input.actorUserId}:${input.input.requestId}`;
    const reservation = await this.#idempotencyLedger.reserve(ledgerKey, input.fingerprint);
    if (!reservation.created) {
      if (reservation.entry.fingerprint !== input.fingerprint) {
        throw new ApprovalMcpError(
          "IDEMPOTENCY_CONFLICT",
          "The requestId was already used with a different approval revocation payload.",
        );
      }
      if (reservation.entry.status === "succeeded") {
        return reservation.entry.result as ApprovalRequestEnvelope;
      }
      throw new ApprovalMcpError(
        "IDEMPOTENCY_OUTCOME_UNKNOWN",
        "A previous approval revocation may have reached DingTalk; inspect the instance before retrying.",
      );
    }
    try {
      const upstreamResult = await this.revokeProcessInstance({
        processInstanceId: input.input.processInstanceId,
        requestId: input.input.requestId,
        confirm: input.input.confirm,
        ...(input.input.remark === undefined ? {} : { remark: input.input.remark }),
      });
      const result: ApprovalRequestEnvelope = {
        processInstanceId: input.input.processInstanceId,
        action: "revoke",
        template: input.template,
        currentStatus: "REVOKED",
        auditCorrelationId: input.auditCorrelationId,
        safeNextActions: [],
        data: { dryRun: false, upstreamResult },
      };
      await this.#idempotencyLedger.put(ledgerKey, {
        fingerprint: input.fingerprint,
        status: "succeeded",
        result,
        updatedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      if (isKnownPreWriteRejection(error)) {
        await this.#idempotencyLedger.delete(ledgerKey);
        throw error;
      }
      try {
        await this.#idempotencyLedger.put(ledgerKey, {
          fingerprint: input.fingerprint,
          status: "uncertain",
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // The pending reservation still prevents an unsafe automatic replay.
      }
      throw new ApprovalMcpError(
        "IDEMPOTENCY_OUTCOME_UNKNOWN",
        "The approval revocation result is uncertain; inspect DingTalk before using a new requestId.",
        { cause: error },
      );
    }
  }

  async #commentApprovalRequestIdempotently(input: {
    actorUserId: string;
    auditCorrelationId: string;
    fingerprint: string;
    input: Extract<ApprovalRequestInput, { action: "comment" }>;
    template: ApprovalRequestTemplate;
    instanceStatus?: string | undefined;
  }): Promise<ApprovalRequestEnvelope> {
    const ledgerKey = `approval-request-comment:${input.actorUserId}:${input.input.requestId}`;
    const reservation = await this.#idempotencyLedger.reserve(ledgerKey, input.fingerprint);
    if (!reservation.created) {
      if (reservation.entry.fingerprint !== input.fingerprint) {
        throw new ApprovalMcpError(
          "IDEMPOTENCY_CONFLICT",
          "The requestId was already used with a different approval comment payload.",
        );
      }
      if (reservation.entry.status === "succeeded") {
        return reservation.entry.result as ApprovalRequestEnvelope;
      }
      throw new ApprovalMcpError(
        "IDEMPOTENCY_OUTCOME_UNKNOWN",
        "A previous approval comment may have reached DingTalk; inspect the instance before retrying.",
      );
    }
    try {
      const upstreamResult = await this.#audited(
        {
          action: "comment",
          actorUserId: input.actorUserId,
          correlationId: input.auditCorrelationId,
          processInstanceId: input.input.processInstanceId,
          requestId: input.input.requestId,
        },
        () => this.#api.request({
          method: "POST",
          path: "/v1.0/workflow/processInstances/comments",
          body: {
            processInstanceId: input.input.processInstanceId,
            text: input.input.text,
            commentUserId: input.actorUserId,
          },
        }),
      );
      const upstream = asRecord(upstreamResult);
      if (upstream?.result !== true || upstream.success !== true) {
        throw new ApprovalMcpError(
          "INVALID_RESPONSE",
          "DingTalk did not confirm that the approval comment was added.",
        );
      }
      let postActionRefresh = { ok: false, commentObserved: false };
      try {
        const refreshed = await this.getProcessInstanceDetail(input.input.processInstanceId);
        const commentObserved = refreshed.normalized.operationRecords.some((record) => {
          const operation = asRecord(record);
          return text(operation?.type)?.toUpperCase() === "ADD_REMARK" &&
            text(operation?.userId) === input.actorUserId &&
            text(operation?.remark) === input.input.text;
        });
        postActionRefresh = { ok: true, commentObserved };
      } catch {
        // The comment has already succeeded. A failed or eventually-consistent refresh
        // must not turn it into a retryable mutation error that duplicates the comment.
      }
      const result: ApprovalRequestEnvelope = {
        processInstanceId: input.input.processInstanceId,
        action: "comment",
        template: input.template,
        currentStatus: "COMMENTED",
        auditCorrelationId: input.auditCorrelationId,
        safeNextActions: input.instanceStatus === "RUNNING" ? ["comment", "revoke"] : ["comment"],
        data: { dryRun: false, upstreamResult, postActionRefresh },
      };
      await this.#idempotencyLedger.put(ledgerKey, {
        fingerprint: input.fingerprint,
        status: "succeeded",
        result,
        updatedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      try {
        await this.#idempotencyLedger.put(ledgerKey, {
          fingerprint: input.fingerprint,
          status: "uncertain",
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // The pending reservation still prevents an unsafe automatic replay.
      }
      throw new ApprovalMcpError(
        "IDEMPOTENCY_OUTCOME_UNKNOWN",
        "The approval comment result is uncertain; inspect DingTalk before using a new requestId.",
        { cause: error },
      );
    }
  }

  async #resolveApprovalAttachmentSpace(): Promise<{ spaceId: string; unionId: string }> {
    if (this.#agentId === undefined) {
      throw new ApprovalMcpError(
        "CONFIGURATION_ERROR",
        "DINGTALK_AGENT_ID is required to prepare approval attachment uploads.",
      );
    }
    const callerUserId = this.#requireCallerUserId();
    const unionId = this.#requireCallerUnionId();
    const spacePayload = await this.#api.request({
      method: "POST",
      path: "/v1.0/workflow/processInstances/spaces/infos/query",
      body: { userId: callerUserId, agentId: this.#agentId },
    });
    const spaceId = scalarText(asRecord(unwrapResult(spacePayload))?.spaceId);
    if (spaceId === undefined) {
      throw new ApprovalMcpError("INVALID_RESPONSE", "DingTalk did not return an approval attachment spaceId.");
    }
    return { spaceId, unionId };
  }

  #requireCallerUnionId(): string {
    if (this.#callerUnionId === undefined || this.#callerUnionId === "") {
      throw new ApprovalMcpError(
        "CALLER_IDENTITY_NOT_CONFIGURED",
        "Approval attachment uploads require the authenticated DingTalk unionId.",
      );
    }
    return this.#callerUnionId;
  }

  #assertUploadUrlAllowed(value: string): void {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new ApprovalMcpError("ATTACHMENT_URL_REJECTED", "DingTalk returned an invalid attachment upload URL.");
    }
    const hostname = url.hostname.toLowerCase();
    const allowed =
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      [...this.#uploadHostSuffixes].some((suffix) => {
        const normalized = suffix.startsWith(".") ? suffix : `.${suffix}`;
        return hostname === normalized.slice(1) || hostname.endsWith(normalized);
      });
    if (!allowed) {
      throw new ApprovalMcpError(
        "ATTACHMENT_URL_REJECTED",
        "The approval attachment upload URL is outside the configured HTTPS allowlist.",
      );
    }
  }

  #writesEnabled(): boolean {
    return this.#callerUserId !== undefined && this.#writeUserIds.has(this.#callerUserId);
  }

  #assertProcessAllowed(processCode: string): void {
    if (this.#allowedProcessCodes.size > 0 && !this.#allowedProcessCodes.has(processCode)) {
      throw new ApprovalMcpError(
        "PROCESS_CODE_NOT_ALLOWED",
        "The approval processCode is outside the configured allowlist.",
      );
    }
  }

  #assertOptionalProcessAllowed(processCode: string | undefined): void {
    if (this.#allowedProcessCodes.size === 0) return;
    if (processCode === undefined) {
      throw new ApprovalMcpError(
        "PROCESS_CODE_NOT_ALLOWED",
        "The approval processCode is required while the process allowlist is enabled.",
      );
    }
    this.#assertProcessAllowed(processCode);
  }

  async #createIdempotently(
    requestId: string,
    fingerprint: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const reservation = await this.#idempotencyLedger.reserve(requestId, fingerprint);
    if (!reservation.created) {
      const previous = reservation.entry;
      if (previous.fingerprint !== fingerprint) {
        throw new ApprovalMcpError(
          "IDEMPOTENCY_CONFLICT",
          "The requestId was already used with a different approval creation payload.",
        );
      }
      if (previous.status === "succeeded") return previous.result;
      throw new ApprovalMcpError(
        "IDEMPOTENCY_OUTCOME_UNKNOWN",
        "A previous creation attempt may have reached DingTalk; inspect instances before retrying with a new requestId.",
      );
    }

    try {
      const result = await this.#api.request({
        method: "POST",
        path: "/v1.0/workflow/processInstances",
        body,
      });
      await this.#idempotencyLedger.put(requestId, {
        fingerprint,
        status: "succeeded",
        result,
        updatedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      if (error instanceof ApprovalMcpError && error.code === "DINGTALK_API_ERROR" && !error.retryable) {
        await this.#idempotencyLedger.delete(requestId);
        throw error;
      }
      try {
        await this.#idempotencyLedger.put(requestId, {
          fingerprint,
          status: "uncertain",
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // The previously persisted pending entry still prevents an automatic replay.
      }
      throw new ApprovalMcpError(
        "IDEMPOTENCY_OUTCOME_UNKNOWN",
        "The creation result is uncertain; inspect DingTalk before deciding whether to submit again.",
        {
          cause: error,
          ...(error instanceof ApprovalMcpError && typeof error.details?.requestId === "string"
            ? { details: { requestId: error.details.requestId } }
            : {}),
        },
      );
    }
  }

  async #executeTaskIdempotently(
    requestId: string,
    fingerprint: string,
    processInstanceId: string,
    taskId: string | number,
    actorUserId: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const ledgerKey = `approval-task:${requestId}`;
    const reservation = await this.#idempotencyLedger.reserve(ledgerKey, fingerprint);
    if (!reservation.created) {
      const previous = reservation.entry;
      if (previous.fingerprint !== fingerprint) {
        throw new ApprovalMcpError(
          "IDEMPOTENCY_CONFLICT",
          "The requestId was already used with a different approval decision payload.",
        );
      }
      if (previous.status === "succeeded") return previous.result;
      throw new ApprovalMcpError(
        "IDEMPOTENCY_OUTCOME_UNKNOWN",
        "A previous approval decision may have reached DingTalk; refresh the approval before any new decision.",
      );
    }

    try {
      await this.#assertTaskActionable(processInstanceId, taskId, actorUserId);
      const result = await this.#api.request({
        method: "POST",
        path: "/v1.0/workflow/processInstances/execute",
        body,
      });
      await this.#idempotencyLedger.put(ledgerKey, {
        fingerprint,
        status: "succeeded",
        result,
        updatedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      if (isKnownPreWriteRejection(error)) {
        await this.#idempotencyLedger.delete(ledgerKey);
        throw error;
      }
      try {
        await this.#idempotencyLedger.put(ledgerKey, {
          fingerprint,
          status: "uncertain",
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // The pending reservation still prevents an unsafe automatic replay.
      }
      throw new ApprovalMcpError(
        "IDEMPOTENCY_OUTCOME_UNKNOWN",
        "The approval decision result is uncertain; refresh the approval before any new decision.",
        { cause: error },
      );
    }
  }

  async #audited<T>(context: ApprovalAuditContext, operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation();
      const returned = asRecord(unwrapResult(result));
      const returnedInstanceId = text(returned?.instanceId ?? returned?.processInstanceId);
      const upstreamRequestId = getDingTalkRequestId(result);
      await this.#recordAudit({
        ...context,
        timestamp: new Date().toISOString(),
        outcome: "succeeded",
        ...(returnedInstanceId === undefined ? {} : { returnedInstanceId }),
        ...(upstreamRequestId === undefined ? {} : { upstreamRequestId }),
      });
      return result;
    } catch (error) {
      const known = error instanceof ApprovalMcpError;
      const upstreamRequestId = known && typeof error.details?.requestId === "string" ? error.details.requestId : undefined;
      await this.#recordAudit({
        ...context,
        timestamp: new Date().toISOString(),
        outcome:
          known && error.code === "IDEMPOTENCY_OUTCOME_UNKNOWN"
            ? "uncertain"
            : known && error.code !== "DINGTALK_API_ERROR"
              ? "rejected"
              : "failed",
        ...(known ? { errorCode: error.code } : {}),
        ...(upstreamRequestId === undefined ? {} : { upstreamRequestId }),
      });
      throw error;
    }
  }

  async #recordAudit(event: Parameters<ApprovalAuditSink["record"]>[0]): Promise<void> {
    try {
      await this.#audit.record(event);
    } catch {
      // Audit output must never expose secrets or turn a successful DingTalk mutation into a retry.
    }
  }
}

function omit<T extends object, K extends keyof T>(input: T, keys: readonly K[]): Omit<T, K> {
  const excluded = new Set<PropertyKey>(keys);
  return Object.fromEntries(Object.entries(input).filter(([key, value]) => !excluded.has(key) && value !== undefined)) as Omit<
    T,
    K
  >;
}

function isKnownPreWriteRejection(error: unknown): boolean {
  if (!(error instanceof ApprovalMcpError)) return false;
  if (error.code === "DINGTALK_API_ERROR") return !error.retryable;
  return PRE_WRITE_REJECTION_CODES.has(error.code);
}

const PRE_WRITE_REJECTION_CODES = new Set<ApprovalMcpErrorCode>([
  "APPROVAL_COMMENT_FORBIDDEN",
  "CALLER_IDENTITY_MISMATCH",
  "CALLER_IDENTITY_NOT_CONFIGURED",
  "CONFIRMATION_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_KEY_REQUIRED",
  "INSTANCE_NOT_REVOCABLE",
  "INVALID_INPUT",
  "PROCESS_CODE_NOT_ALLOWED",
  "TASK_ACTOR_MISMATCH",
  "TASK_NOT_ACTIONABLE",
  "WRITE_ACTOR_NOT_ALLOWED",
]);

function withoutUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 3600
    ? value
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (record === undefined || Object.keys(record).length > 32) return undefined;
  const entries: Array<[string, string]> = [];
  for (const [key, item] of Object.entries(record)) {
    if (key.length === 0 || key.length > 200 || typeof item !== "string" || item.length > 8192) return undefined;
    entries.push([key, item]);
  }
  return Object.fromEntries(entries);
}

function assertUploadFileName(fileName: string): void {
  if (fileName !== fileName.trim() || fileName.endsWith(".") || /[\u0000-\u001f\\/:*"<>|]/u.test(fileName)) {
    throw new ApprovalMcpError("INVALID_INPUT", "The attachment fileName is not accepted by DingTalk storage.");
  }
}

function assertAttachmentBatchSize(
  attachments: Array<{ fileSize: number }>,
): void {
  const total = attachments.reduce((sum, attachment) => sum + attachment.fileSize, 0);
  if (total > 50 * 1024 * 1024) {
    throw new ApprovalMcpError("INVALID_INPUT", "The combined attachment size exceeds the 50 MiB request limit.");
  }
}

function normalizeCommittedAttachment(
  upload: {
    field: ApprovalAttachmentField;
    fileName: string;
    fileSize: number;
  },
  expectedSpaceId: string,
  payload: unknown,
): ApprovalAttachmentFormValue & { field: ApprovalAttachmentField } {
  const root = asRecord(unwrapResult(payload));
  const dentry = asRecord(root?.dentry) ?? root;
  const fileId = scalarText(dentry?.id ?? dentry?.fileId ?? dentry?.dentryUuid ?? dentry?.uuid);
  const fileName = text(dentry?.name ?? dentry?.fileName) ?? upload.fileName;
  const fileSizeValue = dentry?.size ?? dentry?.fileSize;
  const fileSize = typeof fileSizeValue === "number" && Number.isSafeInteger(fileSizeValue) && fileSizeValue >= 0
    ? fileSizeValue
    : upload.fileSize;
  const returnedSpaceId = scalarText(dentry?.spaceId) ?? expectedSpaceId;
  const fileType = text(dentry?.extension ?? dentry?.fileType) ?? extensionOf(fileName);
  if (fileId === undefined || returnedSpaceId !== expectedSpaceId || fileType === "") {
    throw new ApprovalMcpError("INVALID_RESPONSE", "DingTalk returned incomplete committed attachment metadata.");
  }
  return { field: upload.field, fileId, fileName, fileSize, fileType, spaceId: expectedSpaceId };
}

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf(".");
  return index <= 0 || index === fileName.length - 1 ? "" : fileName.slice(index + 1).toLowerCase();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
