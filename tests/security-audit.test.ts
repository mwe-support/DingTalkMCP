import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AuditPseudonymizer, RetainedSecurityAuditSink } from "../src/auth/security-audit.js";
import { DailyJsonLineAuditStore } from "../src/core/audit-log.js";

describe("OAuth security audit", () => {
  it("retains pseudonymous security events without raw DingTalk identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "mwe-security-audit-"));
    const sink = new RetainedSecurityAuditSink(
      new DailyJsonLineAuditStore(root, { now: () => new Date("2026-08-14T00:00:00.000Z") }),
      new AuditPseudonymizer("audit-secret-that-is-not-logged"),
    );

    await sink.record({
      event: "login_succeeded",
      outcome: "succeeded",
      subject: "union-sensitive",
      tenantId: "corp-sensitive",
      clientId: "client-sensitive",
    });

    const serialized = await readFile(`${root}/2026-08-14.jsonl`, "utf8");
    expect(serialized).toContain('"type":"oauth_security"');
    expect(serialized).toContain('"subjectHash"');
    expect(serialized).not.toContain("union-sensitive");
    expect(serialized).not.toContain("corp-sensitive");
    expect(serialized).not.toContain("client-sensitive");
  });
});
