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
    });
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
