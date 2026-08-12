import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { ApprovalService } from "../approval/service.js";
import { ApprovalMcpError, errorPayload } from "../core/errors.js";

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

export function createApprovalMcpServer(service: ApprovalService): McpServer {
  const server = new McpServer({
    name: "mwe-dingtalk-approval-mcp",
    version: "0.2.0",
  });

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
        "Read one DingTalk OA approval instance, normalize all form/operation attachments and images, and optionally return bounded base64 content for selected fileIds in the same call. Use attachmentAction=read only when the user asks to read attachment content; obtain attachmentIds from a metadata call or the same approval context.",
      inputSchema: {
        processInstanceId,
        attachmentAction: z
          .enum(["list", "read"])
          .optional()
          .describe("list (default) returns metadata; read also retrieves selected attachmentIds"),
        attachmentIds: z
          .array(z.string().min(1))
          .max(10)
          .optional()
          .describe("fileIds from this instance to read when attachmentAction=read"),
        maxAttachments: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe("Maximum attachments read in one call; default 3, hard limit 5"),
      },
      annotations: readAnnotations,
    },
    async (input) =>
      safely(() => {
        if (input.attachmentAction === "read" && (input.attachmentIds === undefined || input.attachmentIds.length === 0)) {
          throw new ApprovalMcpError(
            "INVALID_INPUT",
            "attachmentIds must contain at least one fileId when attachmentAction=read.",
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

  server.registerTool(
    "download_approval_attachment",
    {
      title: "Download an approval attachment",
      description:
        "Exchange processInstanceId + fileId for a temporary URL, validate every HTTPS host/redirect, and return bounded base64 with SHA-256.",
      inputSchema: {
        processInstanceId,
        fileId: z.string().min(1),
        spaceId: z
          .string()
          .min(1)
          .optional()
          .describe("Required for form attachments; use the spaceId returned by instance detail"),
        fileName: z.string().min(1).max(255),
        withCommentAttachment: z
          .boolean()
          .optional()
          .describe("Set true for an operation/comment attachment; translated to DingTalk's official request field"),
      },
      annotations: readAnnotations,
    },
    async (input) =>
      safely(() =>
        service.downloadApprovalAttachment({
          processInstanceId: input.processInstanceId,
          fileId: input.fileId,
          ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
          fileName: input.fileName,
          ...(input.withCommentAttachment === undefined
            ? {}
            : { withCommentAttachment: input.withCommentAttachment }),
        }),
      ),
  );

  return server;
}

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
