import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { ApprovalService } from "../approval/service.js";
import { errorPayload } from "../core/errors.js";

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
    version: "0.1.0",
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
      inputSchema: { request: jsonRecord.describe("Official ProcessForecast request body") },
      annotations: readAnnotations,
    },
    async ({ request }) => safely(() => service.forecastProcess(request)),
  );

  server.registerTool(
    "start_process_instance",
    {
      title: "Start an approval instance",
      description:
        "Create a real DingTalk OA approval instance. Requires explicit confirmation, an allowed originator userId, and a UUID RequestId.",
      inputSchema: {
        confirm: z.literal(true).describe("Must be true after the user explicitly confirms creation"),
        requestId: z.string().uuid().describe("Client-generated UUID used for idempotency"),
        processCode: z.string().min(1),
        originatorUserId: userId,
        deptId: z.number().int(),
        formComponentValues: z.array(jsonRecord),
        approvers: z.array(jsonRecord).optional(),
        ccList: z.array(z.string().min(1)).optional(),
        ccPosition: z.enum(["START", "FINISH", "START_FINISH"]).optional(),
        targetSelectActioners: z.array(jsonRecord).optional(),
      },
      annotations: writeAnnotations,
    },
    async (input) => safely(() => service.startProcessInstance(input)),
  );

  const executeSchema = {
    confirm: z.literal(true).describe("Must be true after the user explicitly confirms this approval decision"),
    processInstanceId,
    taskId: z.union([z.string().min(1), z.number().int().nonnegative()]),
    actionerUserId: userId,
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
    async (input) => safely(() => service.executeTask({ ...input, result: "agree" })),
  );

  server.registerTool(
    "reject_processInstance",
    {
      title: "Reject an approval task",
      description: "Refuse a real pending DingTalk OA task. Fails closed unless the actor is locally authorized.",
      inputSchema: executeSchema,
      annotations: writeAnnotations,
    },
    async (input) => safely(() => service.executeTask({ ...input, result: "refuse" })),
  );

  server.registerTool(
    "revoke_processInstance",
    {
      title: "Revoke an approval instance",
      description:
        "Revoke a running DingTalk OA instance. The template must permit revocation and the operator must be locally authorized.",
      inputSchema: {
        confirm: z.literal(true).describe("Must be true after the user explicitly confirms revocation"),
        processInstanceId,
        operatingUserId: userId,
        isSystem: z.boolean().optional(),
        remark: z.string().max(1024).optional(),
      },
      annotations: writeAnnotations,
    },
    async (input) => safely(() => service.revokeProcessInstance(input)),
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
        fileName: z.string().min(1).max(255),
      },
      annotations: readAnnotations,
    },
    async (input) => safely(() => service.downloadApprovalAttachment(input)),
  );

  return server;
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
