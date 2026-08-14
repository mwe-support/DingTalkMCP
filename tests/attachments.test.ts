import { describe, expect, it } from "vitest";

import { AttachmentLinkPolicy, extractApprovalAttachments } from "../src/approval/attachments.js";

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

describe("AttachmentLinkPolicy", () => {
  it("returns a validated temporary link for the Agent client without downloading the file", () => {
    const policy = new AttachmentLinkPolicy({ allowedHostSuffixes: [".aliyuncs.com"] });

    expect(
      policy.createClientDownload(
        "http://lippi-space-zjk.oss-cn-zhangjiakou.aliyuncs.com/opaque?signature=short-lived",
        "审批附件.pdf",
        2048,
      ),
    ).toEqual({
      downloadUrl: "https://lippi-space-zjk.oss-cn-zhangjiakou.aliyuncs.com/opaque?signature=short-lived",
      fileName: "审批附件.pdf",
      mimeType: "application/pdf",
      fileSize: 2048,
      temporary: true,
      agentActionRequired: "download_and_identify",
    });
  });

  it("rejects credentials, unapproved hosts, and non-upgradable HTTP links", () => {
    const policy = new AttachmentLinkPolicy({ allowedHostSuffixes: [".dingtalk.com"] });

    for (const url of [
      "https://evil.example/attachment.pdf",
      "https://user:password@files.dingtalk.com/attachment.pdf",
      "http://files.dingtalk.com/attachment.pdf",
    ]) {
      expect(() => policy.createClientDownload(url, "审批附件.pdf")).toThrowError(
        expect.objectContaining({ code: "ATTACHMENT_URL_REJECTED" }),
      );
    }
  });
});
