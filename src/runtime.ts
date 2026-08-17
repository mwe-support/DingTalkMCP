import { ApprovalService } from "./approval/service.js";
import { AttachmentLinkPolicy } from "./approval/attachments.js";
import { DirectoryApprovalInboxIndex } from "./approval/pending-index.js";
import type { ApprovalMcpConfig } from "./config.js";
import { JsonLineAuditSink, type ApprovalAuditSink } from "./core/audit.js";
import { DirectoryIdempotencyLedger } from "./core/idempotency.js";
import { DingTalkApiClient } from "./dingtalk/client.js";
import { DingTalkTokenProvider } from "./dingtalk/token-provider.js";

export interface ApprovalRuntimeOptions {
  audit?: ApprovalAuditSink;
  inboxCursorSecret?: string;
}

export function createApprovalService(config: ApprovalMcpConfig, options: ApprovalRuntimeOptions = {}): ApprovalService {
  return createApprovalRuntime(config, options).service;
}

export function createApprovalRuntime(
  config: ApprovalMcpConfig,
  options: ApprovalRuntimeOptions = {},
): { service: ApprovalService; api: DingTalkApiClient; inboxIndex: DirectoryApprovalInboxIndex } {
  const tokenProvider = new DingTalkTokenProvider({
    appKey: config.clientId,
    appSecret: config.clientSecret,
    baseUrl: config.apiBaseUrl,
  });
  const api = new DingTalkApiClient({
    tokenProvider,
    baseUrl: config.apiBaseUrl,
  });
  const attachmentLinkPolicy = new AttachmentLinkPolicy({
    allowedHostSuffixes: config.downloadHostSuffixes,
  });
  const inboxIndex = new DirectoryApprovalInboxIndex(config.approvalInboxPath);
  const service = new ApprovalService({
    api,
    attachmentLinkPolicy,
    ...(config.agentId === undefined ? {} : { agentId: config.agentId }),
    uploadHostSuffixes: config.uploadHostSuffixes,
    allowedProcessCodes: config.allowedProcessCodes,
    inboxProcessCodes: config.inboxProcessCodes,
    ...(options.inboxCursorSecret === undefined ? {} : { inboxCursorSecret: options.inboxCursorSecret }),
    corpId: config.auth.corpId,
    audit: options.audit ?? new JsonLineAuditSink(),
    idempotencyLedger: new DirectoryIdempotencyLedger(config.idempotencyLedgerPath),
    inboxIndex,
  });
  return { service, api, inboxIndex };
}
