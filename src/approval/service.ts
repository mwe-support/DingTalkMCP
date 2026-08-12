import { ApprovalMcpError } from "../core/errors.js";
import type { DingTalkApiClient } from "../dingtalk/client.js";
import { AttachmentDownloader, extractApprovalAttachments } from "./attachments.js";
import { array, asRecord, normalizeProcessInstance, text, unwrapResult } from "./normalize.js";

type ApiPort = Pick<DingTalkApiClient, "request">;

export interface StartProcessInstanceInput {
  confirm: boolean;
  requestId: string;
  processCode: string;
  originatorUserId: string;
  deptId: number;
  formComponentValues: unknown[];
  approvers?: unknown[] | undefined;
  ccList?: string[] | undefined;
  ccPosition?: string | undefined;
  targetSelectActioners?: unknown[] | undefined;
}

export interface ExecuteTaskInput {
  confirm: boolean;
  processInstanceId: string;
  taskId: string | number;
  actionerUserId: string;
  result: "agree" | "refuse";
  remark?: string | undefined;
  file?: unknown;
}

export interface RevokeProcessInstanceInput {
  confirm: boolean;
  processInstanceId: string;
  operatingUserId: string;
  isSystem?: boolean | undefined;
  remark?: string | undefined;
}

interface ApprovalServiceOptions {
  api: ApiPort;
  downloader?: AttachmentDownloader;
  writeUserIds?: Iterable<string>;
  allowedProcessCodes?: Iterable<string>;
}

export class ApprovalService {
  readonly #api: ApiPort;
  readonly #downloader: AttachmentDownloader;
  readonly #writeUserIds: Set<string>;
  readonly #allowedProcessCodes: Set<string>;
  readonly #startRequests = new Map<string, { fingerprint: string; promise: Promise<unknown> }>();

  constructor(options: ApprovalServiceOptions) {
    this.#api = options.api;
    this.#downloader = options.downloader ?? new AttachmentDownloader();
    this.#writeUserIds = new Set(options.writeUserIds ?? []);
    this.#allowedProcessCodes = new Set(options.allowedProcessCodes ?? []);
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

  async queryProcessInstanceIds(input: Record<string, unknown>): Promise<unknown> {
    const processCode = text(input.processCode);
    if (processCode !== undefined) this.#assertProcessAllowed(processCode);
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
      return status === undefined || ["NEW", "PENDING", "RUNNING", "TODO"].includes(status);
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
    if (processCode !== undefined) this.#assertProcessAllowed(processCode);
    return this.#api.request({
      method: "POST",
      path: "/v1.0/workflow/processes/forecast",
      body: input,
    });
  }

  async startProcessInstance(input: StartProcessInstanceInput): Promise<unknown> {
    this.#assertConfirmedActor(input.confirm, input.originatorUserId);
    this.#assertProcessAllowed(input.processCode);
    const body = omit(input, ["confirm", "requestId"]);
    const fingerprint = JSON.stringify(body);
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

    const request = this.#api
      .request({
        method: "POST",
        path: "/v1.0/workflow/processInstances",
        body,
      })
      .catch((error: unknown) => {
        this.#startRequests.delete(input.requestId);
        throw error;
      });
    this.#startRequests.set(input.requestId, { fingerprint, promise: request });
    if (this.#startRequests.size > 1000) {
      const oldest = this.#startRequests.keys().next().value as string | undefined;
      if (oldest !== undefined && oldest !== input.requestId) this.#startRequests.delete(oldest);
    }
    return request;
  }

  async executeTask(input: ExecuteTaskInput): Promise<unknown> {
    this.#assertConfirmedActor(input.confirm, input.actionerUserId);
    const current = await this.getProcessInstanceDetail(input.processInstanceId);
    const task = current.normalized.tasks.map(asRecord).find((candidate) => text(candidate?.taskId) === String(input.taskId));
    const taskStatus = text(task?.status)?.toUpperCase();
    if (task === undefined || taskStatus === undefined || !["NEW", "PENDING", "RUNNING", "TODO"].includes(taskStatus)) {
      throw new ApprovalMcpError(
        "TASK_NOT_ACTIONABLE",
        "The approval task is missing or no longer in an actionable state.",
      );
    }
    const currentActor = text(task.userId ?? task.actionerUserId);
    if (currentActor !== input.actionerUserId) {
      throw new ApprovalMcpError(
        "TASK_ACTOR_MISMATCH",
        "The current approval task does not belong to the requested actionerUserId.",
      );
    }
    return this.#api.request({
      method: "POST",
      path: "/v1.0/workflow/processInstances/execute",
      body: omit(input, ["confirm"]),
    });
  }

  async revokeProcessInstance(input: RevokeProcessInstanceInput): Promise<unknown> {
    this.#assertConfirmedActor(input.confirm, input.operatingUserId);
    const current = await this.getProcessInstanceDetail(input.processInstanceId);
    const status = current.normalized.status?.toUpperCase();
    const isSystem = input.isSystem ?? false;
    const originatorMatches = current.normalized.originatorUserId === input.operatingUserId;
    if (status !== "RUNNING" || (!isSystem && !originatorMatches)) {
      throw new ApprovalMcpError(
        "INSTANCE_NOT_REVOCABLE",
        "The approval instance is not running or the operator is not its originator.",
      );
    }
    return this.#api.request({
      method: "POST",
      path: "/v1.0/workflow/processInstances/terminate",
      body: omit(input, ["confirm"]),
    });
  }

  async listApprovalAttachments(processInstanceId: string): Promise<ReturnType<typeof extractApprovalAttachments>> {
    const detail = await this.getProcessInstanceDetail(processInstanceId);
    return extractApprovalAttachments(detail.raw);
  }

  async getAttachmentDownloadUrl(processInstanceId: string, fileId: string): Promise<{
    fileId?: string;
    spaceId?: string;
    downloadUri: string;
  }> {
    const payload = await this.#api.request({
      method: "POST",
      path: "/v1.0/workflow/processInstances/spaces/files/urls/download",
      body: { processInstanceId, fileId },
    });
    const result = asRecord(unwrapResult(payload));
    const downloadUri = text(result?.downloadUri);
    if (downloadUri === undefined) {
      throw new ApprovalMcpError("INVALID_RESPONSE", "DingTalk did not return an attachment download URI.");
    }
    const spaceId = text(result?.spaceId);
    return {
      fileId: text(result?.fileId) ?? fileId,
      ...(spaceId === undefined ? {} : { spaceId }),
      downloadUri,
    };
  }

  async downloadApprovalAttachment(input: {
    processInstanceId: string;
    fileId: string;
    fileName: string;
  }): Promise<Awaited<ReturnType<AttachmentDownloader["downloadToBase64"]>>> {
    const info = await this.getAttachmentDownloadUrl(input.processInstanceId, input.fileId);
    return this.#downloader.downloadToBase64(info.downloadUri, input.fileName);
  }

  getCapabilities(): Record<string, unknown> {
    return {
      application: "MWE审批MCP",
      tools: {
        detail: true,
        queryInstanceIds: true,
        formSchema: true,
        forecast: true,
        start: this.#writeUserIds.size > 0,
        approveReject: this.#writeUserIds.size > 0,
        revoke: this.#writeUserIds.size > 0,
        listAttachmentMetadata: true,
        downloadFormAttachments: true,
        downloadCommentAttachments: false,
        uploadAttachments: false,
        eventStream: false,
      },
      writeGuard: {
        enabled: this.#writeUserIds.size > 0,
        requiresConfirm: true,
        allowedActorCount: this.#writeUserIds.size,
      },
      processCodeAllowlistEnabled: this.#allowedProcessCodes.size > 0,
    };
  }

  #assertConfirmedActor(confirm: boolean, actorUserId: string): void {
    if (!confirm) {
      throw new ApprovalMcpError("CONFIRMATION_REQUIRED", "This approval mutation requires explicit confirmation.");
    }
    if (!this.#writeUserIds.has(actorUserId)) {
      throw new ApprovalMcpError(
        "WRITE_ACTOR_NOT_ALLOWED",
        "The DingTalk userId is not authorized for approval mutations by this MCP server.",
      );
    }
  }

  #assertProcessAllowed(processCode: string): void {
    if (this.#allowedProcessCodes.size > 0 && !this.#allowedProcessCodes.has(processCode)) {
      throw new ApprovalMcpError(
        "PROCESS_CODE_NOT_ALLOWED",
        "The approval processCode is outside the configured allowlist.",
      );
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

function withoutUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}
