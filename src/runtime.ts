import { ApprovalService } from "./approval/service.js";
import { AttachmentLinkPolicy } from "./approval/attachments.js";
import type { ApprovalMcpConfig } from "./config.js";
import { JsonLineAuditSink, type ApprovalAuditSink } from "./core/audit.js";
import { DirectoryIdempotencyLedger } from "./core/idempotency.js";
import { DingTalkApiClient } from "./dingtalk/client.js";
import { DingTalkTokenProvider } from "./dingtalk/token-provider.js";

export interface ApprovalRuntimeOptions {
  audit?: ApprovalAuditSink;
}

export function createApprovalService(config: ApprovalMcpConfig, options: ApprovalRuntimeOptions = {}): ApprovalService {
  return createApprovalRuntime(config, options).service;
}

export function createApprovalRuntime(
  config: ApprovalMcpConfig,
  options: ApprovalRuntimeOptions = {},
): { service: ApprovalService; api: DingTalkApiClient } {
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
  const service = new ApprovalService({
    api,
    attachmentLinkPolicy,
    allowedProcessCodes: config.allowedProcessCodes,
    audit: options.audit ?? new JsonLineAuditSink(),
    idempotencyLedger: new DirectoryIdempotencyLedger(config.idempotencyLedgerPath),
  });
  return { service, api };
}
