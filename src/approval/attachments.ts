import { createHash } from "node:crypto";

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

export interface DownloadedAttachment {
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  contentBase64: string;
  redaction: {
    policy: "credentials-v1";
    evaluated: boolean;
    applied: boolean;
    replacements: number;
  };
}

interface AttachmentDownloaderOptions {
  fetch?: typeof fetch;
  maxBytes?: number;
  allowedHostSuffixes?: string[];
  timeoutMs?: number;
  maxRedirects?: number;
  allowedMimeTypes?: string[];
}

const DEFAULT_ALLOWED_MIME_TYPES = [
  "application/json",
  "application/msword",
  "application/pdf",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/xml",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/plain",
  "text/xml",
] as const;

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

export class AttachmentDownloader {
  readonly #fetch: typeof fetch;
  readonly #maxBytes: number;
  readonly #allowedHostSuffixes: string[];
  readonly #timeoutMs: number;
  readonly #maxRedirects: number;
  readonly #allowedMimeTypes: Set<string>;

  constructor(options: AttachmentDownloaderOptions = {}) {
    this.#fetch = options.fetch ?? fetch;
    this.#maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.#allowedHostSuffixes = (options.allowedHostSuffixes ?? [
      ".dingtalk.com",
      ".alicdn.com",
      ".aliyuncs.com",
    ]).map((value) => value.toLowerCase());
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxRedirects = options.maxRedirects ?? 3;
    this.#allowedMimeTypes = new Set(
      (options.allowedMimeTypes ?? [...DEFAULT_ALLOWED_MIME_TYPES]).map((value) => value.toLowerCase()),
    );
  }

  async downloadToBase64(downloadUrl: string, fileName: string): Promise<DownloadedAttachment> {
    const response = await this.#fetchValidated(downloadUrl, 0);
    if (!response.ok) {
      throw new ApprovalMcpError("ATTACHMENT_DOWNLOAD_FAILED", "The approval attachment download failed.", {
        details: { status: response.status },
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    const declaredLength = parseLength(response.headers.get("content-length"));
    if (declaredLength !== undefined && declaredLength > this.#maxBytes) {
      throw new ApprovalMcpError("ATTACHMENT_TOO_LARGE", "The approval attachment exceeds the configured limit.", {
        details: { maxBytes: this.#maxBytes, declaredBytes: declaredLength },
      });
    }

    const mimeType = resolveAllowedMimeType(response.headers.get("content-type"), fileName, this.#allowedMimeTypes);
    const sourceBytes = await readBounded(response, this.#maxBytes);
    const { bytes, redaction } = redactCredentialText(sourceBytes, mimeType);
    if (bytes.byteLength > this.#maxBytes) {
      throw new ApprovalMcpError("ATTACHMENT_TOO_LARGE", "The redacted approval attachment exceeds the configured limit.", {
        details: { maxBytes: this.#maxBytes },
      });
    }
    return {
      fileName: sanitizeFileName(fileName),
      mimeType,
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentBase64: Buffer.from(bytes).toString("base64"),
      redaction,
    };
  }

  async #fetchValidated(input: string, redirects: number): Promise<Response> {
    const url = this.#validateUrl(input);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: { accept: "application/octet-stream,*/*" },
      });
    } catch (error) {
      throw new ApprovalMcpError("ATTACHMENT_DOWNLOAD_FAILED", "Unable to reach the approval attachment host.", {
        cause: error,
        retryable: true,
      });
    }

    if (response.status >= 300 && response.status < 400) {
      if (redirects >= this.#maxRedirects) {
        throw new ApprovalMcpError("ATTACHMENT_URL_REJECTED", "Too many attachment download redirects.");
      }
      const location = response.headers.get("location");
      if (location === null) {
        throw new ApprovalMcpError("ATTACHMENT_DOWNLOAD_FAILED", "The attachment redirect did not include a target.");
      }
      return this.#fetchValidated(new URL(location, url).toString(), redirects + 1);
    }

    return response;
  }

  #validateUrl(input: string): URL {
    let url: URL;
    try {
      url = new URL(input);
    } catch (error) {
      throw new ApprovalMcpError("ATTACHMENT_URL_REJECTED", "The approval attachment URL is invalid.", {
        cause: error,
      });
    }
    const host = url.hostname.toLowerCase();
    const allowed = this.#allowedHostSuffixes.some((suffix) =>
      suffix.startsWith(".") ? host.endsWith(suffix) : host === suffix || host.endsWith(`.${suffix}`),
    );
    if (url.protocol !== "https:" || !allowed || url.username !== "" || url.password !== "") {
      throw new ApprovalMcpError(
        "ATTACHMENT_URL_REJECTED",
        "The approval attachment URL is outside the configured HTTPS allowlist.",
        { details: { host } },
      );
    }
    return url;
  }
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

function resolveAllowedMimeType(
  contentType: string | null,
  fileName: string,
  allowedMimeTypes: ReadonlySet<string>,
): string {
  const declared = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const extension = /\.[a-z0-9]+$/iu.exec(fileName)?.[0]?.toLowerCase();
  const inferred = extension === undefined ? undefined : MIME_BY_EXTENSION[extension];
  if (extension !== undefined && inferred === undefined) {
    throw new ApprovalMcpError(
      "ATTACHMENT_TYPE_NOT_ALLOWED",
      "The approval attachment file extension is outside the configured allowlist.",
      { details: { declaredMimeType: declared ?? "missing", fileExtension: extension } },
    );
  }
  if (
    declared !== undefined &&
    declared !== "" &&
    declared !== "application/octet-stream" &&
    inferred !== undefined &&
    declared !== inferred &&
    !(declared === "text/xml" && inferred === "application/xml")
  ) {
    throw new ApprovalMcpError(
      "ATTACHMENT_TYPE_NOT_ALLOWED",
      "The approval attachment MIME type does not match its allowlisted file extension.",
      { details: { declaredMimeType: declared, inferredMimeType: inferred, fileExtension: extension } },
    );
  }
  const mimeType = declared === undefined || declared === "" || declared === "application/octet-stream"
    ? inferred
    : declared;
  if (mimeType === undefined || !allowedMimeTypes.has(mimeType)) {
    throw new ApprovalMcpError(
      "ATTACHMENT_TYPE_NOT_ALLOWED",
      "The approval attachment MIME type is outside the configured allowlist.",
      { details: { declaredMimeType: declared ?? "missing", fileExtension: extension ?? "missing" } },
    );
  }
  return mimeType;
}

function redactCredentialText(
  sourceBytes: Uint8Array,
  mimeType: string,
): { bytes: Uint8Array; redaction: DownloadedAttachment["redaction"] } {
  const textLike = mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "application/xml";
  if (!textLike) {
    return {
      bytes: sourceBytes,
      redaction: { policy: "credentials-v1", evaluated: false, applied: false, replacements: 0 },
    };
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  } catch {
    return {
      bytes: sourceBytes,
      redaction: { policy: "credentials-v1", evaluated: false, applied: false, replacements: 0 },
    };
  }
  if (mimeType === "application/json") {
    try {
      const parsed = JSON.parse(decoded) as unknown;
      const replacements = redactJsonCredentials(parsed);
      if (replacements > 0) {
        return {
          bytes: new TextEncoder().encode(JSON.stringify(parsed)),
          redaction: { policy: "credentials-v1", evaluated: true, applied: true, replacements },
        };
      }
    } catch {
      // Invalid JSON is still scanned as UTF-8 text below.
    }
  }
  let replacements = 0;
  const redacted = decoded.replace(
    /((?:access[_-]?token|api[_-]?key|app[_-]?secret|authorization|client[_-]?secret|password)\s*[:=]\s*)(?:bearer\s+)?([^\s,;]+)/giu,
    (_match, prefix: string) => {
      replacements += 1;
      return `${prefix}[REDACTED]`;
    },
  );
  return {
    bytes: new TextEncoder().encode(redacted),
    redaction: {
      policy: "credentials-v1",
      evaluated: true,
      applied: replacements > 0,
      replacements,
    },
  };
}

const CREDENTIAL_FIELD_NAME = /^(?:access[_-]?token|api[_-]?key|app[_-]?secret|authorization|client[_-]?secret|password)$/iu;

function redactJsonCredentials(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((count, item) => count + redactJsonCredentials(item), 0);
  const record = asRecord(value);
  if (record === undefined) return 0;
  let replacements = 0;
  for (const [key, item] of Object.entries(record)) {
    if (CREDENTIAL_FIELD_NAME.test(key)) {
      if (item !== "[REDACTED]") {
        record[key] = "[REDACTED]";
        replacements += 1;
      }
      continue;
    }
    replacements += redactJsonCredentials(item);
  }
  return replacements;
}

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

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ApprovalMcpError("ATTACHMENT_TOO_LARGE", "The approval attachment exceeds the configured limit.", {
          details: { maxBytes },
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function sanitizeFileName(value: string): string {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "_").replace(/[. ]+$/u, "").slice(0, 180);
  return sanitized || "attachment.bin";
}

function parseLength(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
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
