import { ApprovalMcpError } from "../core/errors.js";
import { array, asRecord, text } from "./normalize.js";

export type ApprovalAttachmentSource = "form" | "form-image" | "operation" | "operation-image";

export interface ApprovalAttachment {
  source: ApprovalAttachmentSource;
  componentName?: string;
  fileId?: string;
  spaceId?: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
  url?: string;
}

interface AttachmentLinkPolicyOptions {
  allowedHostSuffixes?: string[];
}

export interface AttachmentClientDownload {
  downloadUrl: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
  temporary: true;
  agentActionRequired: "download_and_identify";
}

const OFFICIAL_HTTPS_UPGRADE_HOST_SUFFIXES = [".aliyuncs.com"] as const;

export class AttachmentLinkPolicy {
  readonly #allowedHostSuffixes: string[];

  constructor(options: AttachmentLinkPolicyOptions = {}) {
    this.#allowedHostSuffixes = normalizeAllowedHostSuffixes(options.allowedHostSuffixes);
  }

  createClientDownload(downloadUrl: string, fileName: string, fileSize?: number): AttachmentClientDownload {
    const safeUrl = validateAttachmentUrl(downloadUrl, this.#allowedHostSuffixes);
    const safeFileName = sanitizeFileName(fileName);
    const extension = /\.[a-z0-9]+$/iu.exec(safeFileName)?.[0]?.toLowerCase();
    const mimeType = extension === undefined ? undefined : MIME_BY_EXTENSION[extension];
    return {
      downloadUrl: safeUrl.toString(),
      fileName: safeFileName,
      ...(mimeType === undefined ? {} : { mimeType }),
      ...(fileSize === undefined ? {} : { fileSize }),
      temporary: true,
      agentActionRequired: "download_and_identify",
    };
  }
}

export function extractApprovalAttachments(detail: unknown): ApprovalAttachment[] {
  const root = asRecord(detail) ?? {};
  const output: ApprovalAttachment[] = [];

  for (const component of array(root.formComponentValues)) {
    const componentRecord = asRecord(component);
    if (componentRecord === undefined) continue;
    const componentName = text(componentRecord.name);
    const componentType = text(componentRecord.componentType)?.toUpperCase();
    for (const candidate of [componentRecord.value, componentRecord.extValue]) {
      for (const item of attachmentObjects(candidate)) {
        output.push(toAttachment(item, "form", componentName));
      }
      if (componentType?.includes("PHOTO") || componentType?.includes("IMAGE")) {
        for (const url of urlStrings(parseMaybeJson(candidate))) {
          output.push({
            source: "form-image",
            ...(componentName === undefined ? {} : { componentName }),
            url,
          });
        }
      }
    }
  }

  for (const operation of array(root.operationRecords)) {
    const operationRecord = asRecord(operation);
    if (operationRecord === undefined) continue;
    for (const candidate of array(operationRecord.attachments)) {
      const attachment = asRecord(candidate);
      if (attachment !== undefined && isAttachmentObject(attachment)) {
        output.push(toAttachment(attachment, "operation"));
      }
    }
    for (const candidate of array(operationRecord.images)) {
      if (typeof candidate === "string" && isHttpUrl(candidate)) {
        output.push({ source: "operation-image", url: candidate });
        continue;
      }
      const image = asRecord(candidate);
      if (image !== undefined) {
        const url = text(image.url ?? image.downloadUrl);
        if (isAttachmentObject(image) || (url !== undefined && isHttpUrl(url))) {
          output.push(toAttachment(image, "operation-image"));
        }
      }
    }
  }

  const seen = new Set<string>();
  return output.filter((attachment) => {
    const key = [attachment.source, attachment.fileId, attachment.url, attachment.fileName].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeAllowedHostSuffixes(values?: string[]): string[] {
  return (values ?? [".dingtalk.com", ".alicdn.com", ".aliyuncs.com"]).map((value) => value.toLowerCase());
}

function validateAttachmentUrl(input: string, allowedHostSuffixes: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch (error) {
    throw new ApprovalMcpError("ATTACHMENT_URL_REJECTED", "The approval attachment URL is invalid.", {
      cause: error,
    });
  }
  const host = url.hostname.toLowerCase();
  const allowed = allowedHostSuffixes.some((suffix) =>
    suffix.startsWith(".") ? host.endsWith(suffix) : host === suffix || host.endsWith(`.${suffix}`),
  );
  if (!allowed || url.username !== "" || url.password !== "") {
    throw new ApprovalMcpError(
      "ATTACHMENT_URL_REJECTED",
      "The approval attachment URL is outside the configured HTTPS allowlist.",
      { details: { host } },
    );
  }
  if (
    url.protocol === "http:" &&
    OFFICIAL_HTTPS_UPGRADE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    url.protocol = "https:";
  }
  if (url.protocol !== "https:") {
    throw new ApprovalMcpError(
      "ATTACHMENT_URL_REJECTED",
      "The approval attachment URL is outside the configured HTTPS allowlist.",
      { details: { host } },
    );
  }
  return url;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rtf": "application/rtf",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
};

function attachmentObjects(value: unknown): Record<string, unknown>[] {
  const parsed = parseMaybeJson(value);
  const found: Record<string, unknown>[] = [];
  visit(parsed, (candidate) => {
    if (isAttachmentObject(candidate)) found.push(candidate);
  });
  return found;
}

function visit(value: unknown, visitor: (value: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, visitor);
    return;
  }
  const record = asRecord(value);
  if (record === undefined) return;
  visitor(record);
  for (const item of Object.values(record)) visit(item, visitor);
}

function urlStrings(value: unknown): string[] {
  if (typeof value === "string") return isHttpUrl(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(urlStrings);
  const record = asRecord(value);
  return record === undefined ? [] : Object.values(record).flatMap(urlStrings);
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function isAttachmentObject(value: Record<string, unknown>): boolean {
  return text(value.fileId ?? value.file_id) !== undefined;
}

function toAttachment(
  value: Record<string, unknown>,
  source: ApprovalAttachmentSource,
  componentName?: string,
): ApprovalAttachment {
  const url = text(value.url ?? value.downloadUrl ?? value.downloadUri);
  const size = numeric(value.fileSize ?? value.size);
  const fileId = text(value.fileId ?? value.file_id);
  const spaceId = text(value.spaceId ?? value.space_id);
  const fileName = text(value.fileName ?? value.name);
  const fileType = text(value.fileType ?? value.type);
  return {
    source,
    ...(componentName === undefined ? {} : { componentName }),
    ...(fileId === undefined ? {} : { fileId }),
    ...(spaceId === undefined ? {} : { spaceId }),
    ...(fileName === undefined ? {} : { fileName }),
    ...(fileType === undefined ? {} : { fileType }),
    ...(size === undefined ? {} : { fileSize: size }),
    ...(url === undefined ? {} : { url }),
  };
}

function sanitizeFileName(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "_").replace(/[. ]+$/u, "").slice(0, 180);
  return sanitized || "attachment.bin";
}

function numeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("https://") || value.startsWith("http://");
}
