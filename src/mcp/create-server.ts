import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

import type { ApprovalService } from "../approval/service.js";
import {
  expenseReimbursementFieldsSchema,
  paymentRequestFieldsSchema,
} from "../approval/request-templates.js";
import { ApprovalMcpError, errorPayload } from "../core/errors.js";
import {
  DEFAULT_AUDIT_WRITE_TIMEOUT_MS,
  type AuditInvocationContext,
  runAuditWriteWithinTimeout,
  type ToolInvocationAuditEventBase,
  type ToolInvocationAuditOutcome,
  type ToolInvocationAuditSink,
} from "../core/audit-log.js";
import { APPROVAL_MCP_VERSION } from "../version.js";

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

const jsonRecord = z.record(z.string(), z.unknown());
const processInstanceId = z.string().min(1).describe("DingTalk approval processInstanceId");
const userId = z.string().min(1).describe("DingTalk userId; write operations must match the server allowlist");
const taskId = z.union([z.string().min(1), z.number().int().nonnegative()]);
const decisionRequestId = z.string().uuid().describe("Stable UUID used to prevent duplicate approval decisions");
const approvalTaskViewMetadataSchema = z
  .object({
    action: z.literal("view"),
    processInstanceId,
    attachmentAction: z.literal("list").optional(),
  })
  .strict();
const approvalTaskViewDownloadSchema = z
  .object({
    action: z.literal("view"),
    processInstanceId,
    attachmentAction: z.literal("download"),
    attachmentIds: z.array(z.string().min(1)).min(1).max(10),
    maxAttachments: z.number().int().min(1).max(5).optional(),
  })
  .strict();
const approvalTaskDecisionShape = {
  processInstanceId,
  taskId,
  requestId: decisionRequestId,
  confirm: z.boolean(),
  dryRun: z.boolean().optional(),
} as const;
const approvalTaskApproveSchema = z
  .object({
    action: z.literal("approve"),
    ...approvalTaskDecisionShape,
    remark: z.string().max(1024).optional(),
  })
  .strict();
const approvalTaskRejectSchema = z
  .object({
    action: z.literal("reject"),
    ...approvalTaskDecisionShape,
    remark: z.string().trim().min(1).max(1024),
  })
  .strict();
const approvalTaskSchema = z.union([
  approvalTaskViewMetadataSchema,
  approvalTaskViewDownloadSchema,
  approvalTaskApproveSchema,
  approvalTaskRejectSchema,
]);
const approvalRequestAttachmentBaseSchema = z
  .object({
    fileName: z.string().trim().min(1).max(255),
    fileSize: z.number().int().positive().max(20 * 1024 * 1024),
  })
  .strict();
const expenseAttachmentSchema = approvalRequestAttachmentBaseSchema
  .extend({ field: z.enum(["invoice", "other"]) })
  .strict();
const paymentAttachmentSchema = approvalRequestAttachmentBaseSchema
  .extend({ field: z.literal("attachment") })
  .strict();
const expenseUploadSchema = expenseAttachmentSchema
  .extend({
    uploadKey: z.string().min(1),
    spaceId: z.union([z.string().min(1), z.number().int().nonnegative()]),
  })
  .strict();
const paymentUploadSchema = paymentAttachmentSchema
  .extend({
    uploadKey: z.string().min(1),
    spaceId: z.union([z.string().min(1), z.number().int().nonnegative()]),
  })
  .strict();
const approvalRequestExpensePrepareSchema = z
  .object({
    action: z.literal("prepare"),
    template: z.literal("expense_reimbursement"),
    deptId: z.number().int().positive(),
    fields: expenseReimbursementFieldsSchema,
    attachments: z.array(expenseAttachmentSchema).max(10).optional(),
    confirm: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();
const approvalRequestPaymentPrepareSchema = z
  .object({
    action: z.literal("prepare"),
    template: z.literal("payment_request"),
    deptId: z.number().int().positive(),
    fields: paymentRequestFieldsSchema,
    attachments: z.array(paymentAttachmentSchema).max(10).optional(),
    confirm: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();
const approvalRequestExpenseSubmitSchema = z
  .object({
    action: z.literal("submit"),
    template: z.literal("expense_reimbursement"),
    deptId: z.number().int().positive(),
    fields: expenseReimbursementFieldsSchema,
    uploads: z.array(expenseUploadSchema).max(10).optional(),
    confirm: z.boolean(),
    dryRun: z.boolean().optional(),
    requestId: z.string().uuid(),
  })
  .strict();
const approvalRequestPaymentSubmitSchema = z
  .object({
    action: z.literal("submit"),
    template: z.literal("payment_request"),
    deptId: z.number().int().positive(),
    fields: paymentRequestFieldsSchema,
    uploads: z.array(paymentUploadSchema).max(10).optional(),
    confirm: z.boolean(),
    dryRun: z.boolean().optional(),
    requestId: z.string().uuid(),
  })
  .strict();
const approvalRequestRevokeSchema = z
  .object({
    action: z.literal("revoke"),
    processInstanceId,
    confirm: z.boolean(),
    dryRun: z.boolean().optional(),
    remark: z.string().max(1024).optional(),
  })
  .strict();
const approvalRequestSchema = z.union([
  approvalRequestExpensePrepareSchema,
  approvalRequestPaymentPrepareSchema,
  approvalRequestExpenseSubmitSchema,
  approvalRequestPaymentSubmitSchema,
  approvalRequestRevokeSchema,
]);

export interface ApprovalMcpServerOptions {
  includeCompatibilityTools?: boolean;
  toolAudit?: ToolInvocationAuditSink;
  auditContext?: AuditInvocationContext;
  auditWriteTimeoutMs?: number;
  auditSubjectHash?: string;
}

export interface ApprovalMcpConnectable {
  connect(transport: Transport): Promise<void>;
  close(): Promise<void>;
}

export function createApprovalMcpServer(
  service: ApprovalService,
  options: ApprovalMcpServerOptions = {},
): ApprovalMcpConnectable {
  if (options.includeCompatibilityTools !== true) {
    return createPublicApprovalMcpServer(service, options);
  }
  const server = new McpServer({
    name: "mwe-dingtalk-approval-mcp",
    version: APPROVAL_MCP_VERSION,
  });

  server.registerTool(
    "approval_task",
    {
      title: "View or decide an approval task",
      description:
        "One approver-facing tool for reading an approval instance and deciding its active task. For attachments, use action=view with attachmentAction=download to receive short-lived links; the Agent client must download and identify or OCR files itself. The MCP server never downloads, parses, or OCRs attachment content. Use action=view before approve or reject.",
      inputSchema: approvalTaskSchema,
      annotations: writeAnnotations,
    },
    async (input) => safely(() => service.approvalTask(input)),
  );

  server.registerTool(
    "get_approval_capabilities",
    {
      title: "Get approval MCP capabilities",
      description: "Return locally configured approval capabilities and safety gates without exposing secrets.",
      inputSchema: {},
      annotations: readAnnotations,
    },
    async () => success(service.getCapabilities()),
  );

  server.registerTool(
    "get_processInstance_detail",
    {
      title: "Get approval instance detail",
      description:
        "Read one DingTalk OA approval instance. Returns a tolerant normalized view and the complete raw OpenAPI payload.",
      inputSchema: { processInstanceId },
      annotations: readAnnotations,
    },
    async ({ processInstanceId: id }) => safely(() => service.getProcessInstanceDetail(id)),
  );

  server.registerTool(
    "get_approval_instance",
    {
      title: "Get approval instance with attachments",
      description:
        "Read one DingTalk OA approval instance, normalize all form/operation attachments and images, and optionally return validated temporary download links for selected fileIds. The Agent client must download and identify or OCR files itself; the MCP server never downloads attachment content.",
      inputSchema: {
        processInstanceId,
        attachmentAction: z
          .enum(["list", "download"])
          .optional()
          .describe("list (default) returns metadata; download also returns temporary links for selected attachmentIds"),
        attachmentIds: z
          .array(z.string().min(1))
          .max(10)
          .optional()
          .describe("fileIds from this instance to prepare when attachmentAction=download"),
        maxAttachments: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Maximum temporary links prepared in one call; default 3, hard limit 5"),
      },
      annotations: readAnnotations,
    },
    async (input) =>
      safely(() => {
        if (input.attachmentAction === "download" && (input.attachmentIds === undefined || input.attachmentIds.length === 0)) {
          throw new ApprovalMcpError(
            "INVALID_INPUT",
            "attachmentIds must contain at least one fileId when attachmentAction=download.",
          );
        }
        return service.getApprovalInstance({
          processInstanceId: input.processInstanceId,
          ...(input.attachmentAction === undefined ? {} : { attachmentAction: input.attachmentAction }),
          ...(input.attachmentIds === undefined ? {} : { attachmentIds: input.attachmentIds }),
          ...(input.maxAttachments === undefined ? {} : { maxAttachments: input.maxAttachments }),
        });
      }),
  );

  server.registerTool(
    "query_process_instance_ids",
    {
      title: "Query approval instance IDs",
      description:
        "Query enterprise approval instance IDs through the documented workflow endpoint. Pass the official request body unchanged.",
      inputSchema: { request: jsonRecord.describe("Official ListProcessInstanceIds request body") },
      annotations: readAnnotations,
    },
    async ({ request }) => safely(() => service.queryProcessInstanceIds(request)),
  );

  server.registerTool(
    "get_processInstance_records",
    {
      title: "Get approval operation records",
      description: "Read operation records from the authoritative approval instance detail response.",
      inputSchema: { processInstanceId },
      annotations: readAnnotations,
    },
    async ({ processInstanceId: id }) => safely(() => service.getProcessInstanceRecords(id)),
  );

  server.registerTool(
    "list_pending_tasks",
    {
      title: "List pending tasks in an approval instance",
      description: "List active task records from one approval instance; this does not emulate a hidden personal inbox API.",
      inputSchema: { processInstanceId },
      annotations: readAnnotations,
    },
    async ({ processInstanceId: id }) => safely(() => service.listPendingTasks(id)),
  );

  server.registerTool(
    "list_user_visible_process",
    {
      title: "List user-visible approval templates",
      description: "List OA approval templates visible to a DingTalk user.",
      inputSchema: {
        userId,
        nextToken: z.number().int().nonnegative().optional(),
        maxResults: z.number().int().positive().max(100).optional(),
      },
      annotations: readAnnotations,
    },
    async (input) => safely(() => service.listUserVisibleProcesses(input)),
  );

  server.registerTool(
    "get_process_schema",
    {
      title: "Get approval form schema",
      description: "Read the standard OA form schema for a processCode.",
      inputSchema: { processCode: z.string().min(1) },
      annotations: readAnnotations,
    },
    async ({ processCode }) => safely(() => service.getProcessSchema(processCode)),
  );

  server.registerTool(
    "forecast_process",
    {
      title: "Forecast approval routing",
      description:
        "Forecast the approval route and target-select nodes before creation. Pass the official ProcessForecast request body.",
      inputSchema: {
        request: jsonRecord.describe("Official ProcessForecast request body").optional(),
        ProcessForecastPopRequest: jsonRecord
          .describe("DWS-compatible ProcessForecastPopRequest body wrapper")
          .optional(),
      },
      annotations: readAnnotations,
    },
    async (input) => safely(() => service.forecastProcess(requireOneRequest(input, "ProcessForecastPopRequest"))),
  );

  server.registerTool(
    "start_process_instance",
    {
      title: "Start an approval instance",
      description:
        "Create a real DingTalk OA approval instance for the server-bound caller. Requires explicit confirmation, preserves the OA backend route, and never accepts caller identity or approver overrides.",
      inputSchema: {
        confirm: z.boolean().describe("Set true only after the user explicitly confirms creation"),
        dryRun: z.boolean().optional().describe("Validate and preview without creating an approval"),
        requestId: z.string().uuid().optional().describe("Client-generated UUID used for persistent idempotency"),
        processCode: z.string().min(1),
        deptId: z.number().int(),
        formComponentValues: z.array(jsonRecord),
        ccList: z.array(z.string().min(1)).optional(),
        ccPosition: z.enum(["START", "FINISH", "START_FINISH"]).optional(),
        targetSelectActioners: z.array(jsonRecord).optional(),
        bizDetailPageUrl: z.url().optional(),
        microappAgentId: z.number().int().optional(),
      },
      annotations: writeAnnotations,
    },
    async (input) => safely(() => service.startProcessInstance(normalizeStartInput(input))),
  );

  const executeSchema = {
    confirm: z.boolean().optional().describe("Set true only after the user explicitly confirms this approval decision"),
    dryRun: z.boolean().optional().describe("Refresh and validate the task without executing a decision"),
    processInstanceId,
    taskId: z.union([z.string().min(1), z.number().int().nonnegative()]),
    requestId: decisionRequestId,
    actionerUserId: userId.optional().describe("Optional compatibility field; must match the server-bound caller"),
    remark: z.string().max(1024).optional(),
    file: jsonRecord.optional(),
  };

  server.registerTool(
    "approve_processInstance",
    {
      title: "Approve an approval task",
      description: "Agree to a real pending DingTalk OA task. Fails closed unless the actor is locally authorized.",
      inputSchema: executeSchema,
      annotations: writeAnnotations,
    },
    async (input) =>
      safely(() =>
        service.executeTask({
          ...input,
          confirm: input.confirm ?? false,
          ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
          result: "agree",
        }),
      ),
  );

  server.registerTool(
    "reject_processInstance",
    {
      title: "Reject an approval task",
      description: "Refuse a real pending DingTalk OA task. Fails closed unless the actor is locally authorized.",
      inputSchema: executeSchema,
      annotations: writeAnnotations,
    },
    async (input) =>
      safely(() =>
        service.executeTask({
          ...input,
          confirm: input.confirm ?? false,
          ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
          result: "refuse",
        }),
      ),
  );

  server.registerTool(
    "revoke_processInstance",
    {
      title: "Revoke an approval instance",
      description:
        "Revoke a running DingTalk OA instance. The template must permit revocation and the operator must be locally authorized.",
      inputSchema: {
        confirm: z.boolean().optional().describe("Set true only after the user explicitly confirms revocation"),
        dryRun: z.boolean().optional().describe("Refresh and validate revocability without terminating the instance"),
        processInstanceId,
        operatingUserId: userId.optional().describe("Optional compatibility field; must match the server-bound caller"),
        remark: z.string().max(1024).optional(),
      },
      annotations: writeAnnotations,
    },
    async (input) =>
      safely(() =>
        service.revokeProcessInstance({
          ...input,
          confirm: input.confirm ?? false,
          ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
        }),
      ),
  );

  server.registerTool(
    "list_approval_attachments",
    {
      title: "List approval attachments",
      description:
        "Normalize attachment controls, operation/comment attachments, and images from a tolerant approval detail payload.",
      inputSchema: { processInstanceId },
      annotations: readAnnotations,
    },
    async ({ processInstanceId: id }) => safely(() => service.listApprovalAttachments(id)),
  );

  return server;
}

function createPublicApprovalMcpServer(
  service: ApprovalService,
  options: ApprovalMcpServerOptions,
): Server {
  const server = new Server(
    { name: "mwe-dingtalk-approval-mcp", version: APPROVAL_MCP_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: "approval_task",
        title: "View or decide an approval task",
        description:
          "One approver-facing tool for reading an approval instance and deciding its active task. For attachments, use action=view with attachmentAction=download to receive short-lived links; the Agent client must download and identify or OCR files itself. The MCP server never downloads, parses, or OCRs attachment content. Use action=view before approve or reject.",
        inputSchema: { ...z.toJSONSchema(approvalTaskSchema), type: "object" },
        annotations: writeAnnotations,
      },
      {
        name: "approval_request",
        title: "Prepare, submit, or revoke an approval request",
        description:
          "One applicant-facing tool for the exact allowed templates: expense reimbursement and payment request. Overtime and all other templates are denied. It never accepts approver, CC, flow-node, processCode, or applicant identity overrides. Attachment bytes must be uploaded directly by the Agent client to the returned DingTalk upload URL; the MCP server never receives, parses, or OCRs file content.",
        inputSchema: { ...z.toJSONSchema(approvalRequestSchema), type: "object" },
        annotations: writeAnnotations,
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    auditedPublicToolCall(options, request.params.name, request.params.arguments, async () => {
      if (request.params.name !== "approval_task") {
        if (request.params.name !== "approval_request") {
          throw new ApprovalMcpError("INVALID_INPUT", "The requested MCP tool is not published.");
        }
        const parsed = await approvalRequestSchema.safeParseAsync(request.params.arguments);
        if (!parsed.success) {
          throw new ApprovalMcpError("INVALID_INPUT", "approval_request arguments do not match the action contract.");
        }
        return service.approvalRequest(parsed.data);
      }
      const parsed = await approvalTaskSchema.safeParseAsync(request.params.arguments);
      if (!parsed.success) {
        throw new ApprovalMcpError("INVALID_INPUT", "approval_task arguments do not match the action contract.");
      }
      return service.approvalTask(parsed.data);
    }),
  );
  return server;
}

async function auditedPublicToolCall(
  options: ApprovalMcpServerOptions,
  requestedToolName: string,
  rawArguments: Record<string, unknown> | undefined,
  operation: () => Promise<unknown>,
) {
  if (options.toolAudit === undefined) return safely(operation);
  const invocationId = randomUUID();
  const startedAt = performance.now();
  const action = boundedAction(rawArguments);
  const publishedTool = requestedToolName === "approval_task" || requestedToolName === "approval_request";
  const base: ToolInvocationAuditEventBase = {
    timestamp: new Date().toISOString(),
    invocationId,
    transport: "streamable_http",
    toolName: publishedTool ? requestedToolName : "unknown",
    ...(options.auditSubjectHash === undefined ? {} : { subjectHash: options.auditSubjectHash }),
    ...(action === undefined ? {} : { action }),
  };
  const timeoutMs = options.auditWriteTimeoutMs ?? DEFAULT_AUDIT_WRITE_TIMEOUT_MS;
  try {
    await runAuditWriteWithinTimeout(
      () => options.toolAudit?.record({ ...base, phase: "started" }),
      timeoutMs,
    );
  } catch {
    return safely(() => {
      throw new ApprovalMcpError(
        "AUDIT_LOG_UNAVAILABLE",
        "Structured audit logging is unavailable; the approval tool was not executed.",
      );
    });
  }
  const invocationState = options.auditContext?.createState();
  const invoke = () => safely(operation);
  const result = invocationState === undefined || options.auditContext === undefined
    ? await invoke()
    : await options.auditContext.run(invocationState, invoke);
  const resultErrorCode = toolResultErrorCode(result);
  const errorCode = publishedTool ? resultErrorCode : "UNKNOWN_TOOL";
  const outcome = publishedTool ? toolAuditOutcome(errorCode) : "unknown_tool";
  try {
    await runAuditWriteWithinTimeout(
      () => options.toolAudit?.record({
        ...base,
        timestamp: new Date().toISOString(),
        phase: "completed",
        outcome,
        httpStatus: 200,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        auditStatus: invocationState?.approvalAuditFailed === true ? "partial" : "complete",
        ...(errorCode === undefined ? {} : { errorCode }),
      }),
      timeoutMs,
    );
  } catch {
    return markAuditPartial(result);
  }
  return result;
}

function boundedAction(
  rawArguments: Record<string, unknown> | undefined,
): "view" | "approve" | "reject" | "prepare" | "submit" | "revoke" | undefined {
  const action = rawArguments?.action;
  return action === "view" ||
    action === "approve" ||
    action === "reject" ||
    action === "prepare" ||
    action === "submit" ||
    action === "revoke"
    ? action
    : undefined;
}

function markAuditPartial<T extends Awaited<ReturnType<typeof safely>>>(result: T): T {
  const structuredContent = isRecord(result.structuredContent) ? { ...result.structuredContent, auditStatus: "partial" } : { auditStatus: "partial" };
  return {
    ...result,
    structuredContent,
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
  } as T;
}

function toolResultErrorCode(result: Awaited<ReturnType<typeof safely>>): string | undefined {
  if (!("isError" in result) || result.isError !== true) return undefined;
  const payload = isRecord(result.structuredContent) ? result.structuredContent : undefined;
  const error = isRecord(payload?.error) ? payload.error : undefined;
  return typeof error?.code === "string" ? error.code : "TOOL_INPUT_OR_EXECUTION_ERROR";
}

function toolAuditOutcome(errorCode: string | undefined): ToolInvocationAuditOutcome {
  if (errorCode === undefined) return "succeeded";
  if (errorCode === "IDEMPOTENCY_OUTCOME_UNKNOWN") return "uncertain";
  return TOOL_FAILURE_CODES.has(errorCode) ? "failed" : "rejected";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const TOOL_FAILURE_CODES = new Set([
  "AUDIT_LOG_UNAVAILABLE",
  "CONFIGURATION_ERROR",
  "DINGTALK_AUTH_ERROR",
  "DINGTALK_API_ERROR",
  "IDEMPOTENCY_LEDGER_ERROR",
  "INTERNAL_ERROR",
  "INVALID_RESPONSE",
]);

function requireOneRequest(
  input: {
    request?: Record<string, unknown> | undefined;
    ProcessForecastPopRequest?: Record<string, unknown> | undefined;
  },
  wrapper: "ProcessForecastPopRequest",
): Record<string, unknown> {
  const request = input.request ?? input[wrapper];
  if (request === undefined) {
    throw new ApprovalMcpError("INVALID_INPUT", `Provide request or ${wrapper}.`);
  }
  return request;
}

function normalizeStartInput(input: {
  confirm: boolean;
  dryRun?: boolean | undefined;
  requestId?: string | undefined;
  processCode: string;
  deptId: number;
  formComponentValues: Record<string, unknown>[];
  ccList?: string[] | undefined;
  ccPosition?: "START" | "FINISH" | "START_FINISH" | undefined;
  targetSelectActioners?: Record<string, unknown>[] | undefined;
  bizDetailPageUrl?: string | undefined;
  microappAgentId?: number | undefined;
}) {
  const request = withoutUndefined({
    processCode: input.processCode,
    deptId: input.deptId,
    formComponentValues: input.formComponentValues,
    ccList: input.ccList,
    ccPosition: input.ccPosition,
    targetSelectActioners: input.targetSelectActioners,
    bizDetailPageUrl: input.bizDetailPageUrl,
    microappAgentId: input.microappAgentId,
  });
  const processCode = requiredString(request.processCode, "processCode");
  const deptId = optionalInteger(request.deptId, "deptId");
  const formComponentValues = requiredArray(request.formComponentValues, "formComponentValues");
  return {
    ...request,
    confirm: input.confirm,
    ...(input.dryRun === undefined ? {} : { dryRun: input.dryRun }),
    requestId: input.requestId ?? "",
    processCode,
    ...(deptId === undefined ? {} : { deptId }),
    formComponentValues,
    ...(Array.isArray(request.ccList) ? { ccList: request.ccList.filter((value): value is string => typeof value === "string") } : {}),
    ...(typeof request.ccPosition === "string" ? { ccPosition: request.ccPosition } : {}),
    ...(Array.isArray(request.targetSelectActioners)
      ? { targetSelectActioners: request.targetSelectActioners }
      : {}),
  } as Parameters<ApprovalService["startProcessInstance"]>[0];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApprovalMcpError("INVALID_INPUT", `${field} is required.`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ApprovalMcpError("INVALID_INPUT", `${field} must be an integer.`);
  }
  return value;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : requiredInteger(value, field);
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new ApprovalMcpError("INVALID_INPUT", `${field} must be an array.`);
  return value;
}

function withoutUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

async function safely(operation: () => unknown | Promise<unknown>) {
  try {
    return success(await operation());
  } catch (error) {
    const payload = errorPayload(error);
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }
}

function success(value: unknown) {
  const payload = { result: value };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}
