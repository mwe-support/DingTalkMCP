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

type ApiPort = Pick<DingTalkApiClient, "request">;

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
  operatingUserId?: string | undefined;
  remark?: string | undefined;
}

interface ApprovalServiceOptions {
  api: ApiPort;
  attachmentLinkPolicy?: AttachmentLinkPolicy;
  writeUserIds?: Iterable<string>;
  callerUserId?: string;
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
  readonly #callerScopes: Set<McpScope> | undefined;
  readonly #allowedProcessCodes: Set<string>;
  readonly #audit: ApprovalAuditSink;
  readonly #idempotencyLedger: IdempotencyLedger;
  readonly #startRequests = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();
  readonly #decisionRequests = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();

  constructor(options: ApprovalServiceOptions) {
    this.#api = options.api;
    this.#attachmentLinkPolicy = options.attachmentLinkPolicy ?? new AttachmentLinkPolicy();
    this.#writeUserIds = new Set(options.writeUserIds ?? []);
    this.#callerUserId = options.callerUserId;
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
      callerScopes: caller.scopes,
      writeUserIds: caller.scopes.includes("approval:decide") ? [caller.userId] : [],
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
      },
      async () => {
        this.#assertConfirmedActor(input.confirm, actorUserId);
        await this.#assertRevocable(input.processInstanceId, actorUserId);
        return this.#api.request({
          method: "POST",
          path: "/v1.0/workflow/processInstances/terminate",
          body: {
            ...omit(input, ["confirm", "dryRun", "operatingUserId"]),
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
        uploadAttachments: false,
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
  "CALLER_IDENTITY_MISMATCH",
  "CALLER_IDENTITY_NOT_CONFIGURED",
  "CONFIRMATION_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_KEY_REQUIRED",
  "INVALID_INPUT",
  "PROCESS_CODE_NOT_ALLOWED",
  "TASK_ACTOR_MISMATCH",
  "TASK_NOT_ACTIONABLE",
  "WRITE_ACTOR_NOT_ALLOWED",
]);

function withoutUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
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
