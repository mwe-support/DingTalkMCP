import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AttachmentDownloader, extractApprovalAttachments } from "../src/approval/attachments.js";

describe("extractApprovalAttachments", () => {
  it("normalizes form, comment, and image attachments without assuming one upstream shape", () => {
    const detail = {
      formComponentValues: [
        {
          name: "报销附件",
          componentType: "DDAttachment",
          value: JSON.stringify([
            {
              fileId: "file-form",
              spaceId: "space-1",
              fileName: "invoice.pdf",
              fileType: "pdf",
              fileSize: 1024,
            },
          ]),
        },
        {
          name: "现场照片",
          componentType: "DDPhotoField",
          value: JSON.stringify(["https://static.dingtalk.com/form-image.png"]),
        },
      ],
      operationRecords: [
        {
          operationType: "EXECUTE_TASK_NORMAL",
          attachments: [{ fileId: "file-comment", fileName: "comment.txt", fileSize: "12" }],
          images: ["https://static.dingtalk.com/image-1.png"],
          ccUserIds: ["u1", { unexpected: true }],
        },
      ],
    };

    expect(extractApprovalAttachments(detail)).toEqual([
      expect.objectContaining({ source: "form", fileId: "file-form", fileName: "invoice.pdf" }),
      expect.objectContaining({
        source: "form-image",
        componentName: "现场照片",
        url: "https://static.dingtalk.com/form-image.png",
      }),
      expect.objectContaining({ source: "operation", fileId: "file-comment", fileSize: 12 }),
      expect.objectContaining({ source: "operation-image", url: "https://static.dingtalk.com/image-1.png" }),
    ]);
  });
});

describe("AttachmentDownloader", () => {
  it("returns bounded base64 content and a sha256 digest for an allowed HTTPS URL", async () => {
    const bytes = new TextEncoder().encode("approval attachment");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(bytes, {
        status: 200,
        headers: { "content-type": "text/plain", "content-length": String(bytes.byteLength) },
      }),
    );
    const downloader = new AttachmentDownloader({
      fetch: fetchMock,
      maxBytes: 1024,
      allowedHostSuffixes: [".dingtalk.com"],
    });

    await expect(
      downloader.downloadToBase64("https://files.dingtalk.com/temp/opaque", "note.txt"),
    ).resolves.toEqual({
      fileName: "note.txt",
      mimeType: "text/plain",
      size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      contentBase64: Buffer.from(bytes).toString("base64"),
      redaction: {
        policy: "credentials-v1",
        evaluated: true,
        applied: false,
        replacements: 0,
      },
    });
  });

  it("rejects MIME types outside the approval attachment allowlist", async () => {
    const downloader = new AttachmentDownloader({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(new Uint8Array([0x4d, 0x5a]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      ),
      allowedHostSuffixes: [".dingtalk.com"],
    });

    await expect(
      downloader.downloadToBase64("https://files.dingtalk.com/malware", "invoice.exe"),
    ).rejects.toMatchObject({ code: "ATTACHMENT_TYPE_NOT_ALLOWED" });
  });

  it("redacts credential-like values in UTF-8 text attachments before returning Base64", async () => {
    const source = new TextEncoder().encode("project=alpha\napp_secret = super-sensitive-value\nowner=mwe");
    const redacted = "project=alpha\napp_secret = [REDACTED]\nowner=mwe";
    const downloader = new AttachmentDownloader({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(source, { status: 200, headers: { "content-type": "text/plain" } }),
      ),
      allowedHostSuffixes: [".dingtalk.com"],
    });

    await expect(
      downloader.downloadToBase64("https://files.dingtalk.com/sensitive", "notes.txt"),
    ).resolves.toMatchObject({
      contentBase64: Buffer.from(redacted).toString("base64"),
      redaction: {
        policy: "credentials-v1",
        evaluated: true,
        applied: true,
        replacements: 1,
      },
    });
  });

  it("redacts credential fields in JSON attachments while preserving valid JSON", async () => {
    const source = '{"api_key":"secret-value","nested":{"owner":"mwe","access_token":"token-value"}}';
    const expected = '{"api_key":"[REDACTED]","nested":{"owner":"mwe","access_token":"[REDACTED]"}}';
    const downloader = new AttachmentDownloader({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(source, { status: 200, headers: { "content-type": "application/json" } }),
      ),
      allowedHostSuffixes: [".dingtalk.com"],
    });

    const downloaded = await downloader.downloadToBase64(
      "https://files.dingtalk.com/sensitive-json",
      "credentials.json",
    );

    expect(JSON.parse(Buffer.from(downloaded.contentBase64, "base64").toString("utf8"))).toEqual(JSON.parse(expected));
    expect(downloaded.redaction).toEqual({
      policy: "credentials-v1",
      evaluated: true,
      applied: true,
      replacements: 2,
    });
  });

  it("reapplies the byte limit after text redaction expands the returned content", async () => {
    const source = new TextEncoder().encode("api_key=x");
    const downloader = new AttachmentDownloader({
      fetch: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(source, {
          status: 200,
          headers: { "content-type": "text/plain", "content-length": String(source.byteLength) },
        }),
      ),
      maxBytes: source.byteLength,
      allowedHostSuffixes: [".dingtalk.com"],
    });

    await expect(
      downloader.downloadToBase64("https://files.dingtalk.com/expanded", "notes.txt"),
    ).rejects.toMatchObject({ code: "ATTACHMENT_TOO_LARGE" });
  });

  it("rejects non-HTTPS, unapproved hosts, and oversized bodies before exposing content", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const downloader = new AttachmentDownloader({
      fetch: fetchMock,
      maxBytes: 4,
      allowedHostSuffixes: [".dingtalk.com"],
    });

    await expect(downloader.downloadToBase64("http://files.dingtalk.com/a", "a.txt")).rejects.toMatchObject({
      code: "ATTACHMENT_URL_REJECTED",
    });
    await expect(downloader.downloadToBase64("https://evil.example/a", "a.txt")).rejects.toMatchObject({
      code: "ATTACHMENT_URL_REJECTED",
    });
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(
      new Response("12345", { status: 200, headers: { "content-length": "5" } }),
    );
    await expect(downloader.downloadToBase64("https://files.dingtalk.com/a", "a.txt")).rejects.toMatchObject({
      code: "ATTACHMENT_TOO_LARGE",
    });
  });
});
