import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DirectoryIdempotencyLedger } from "../src/core/idempotency.js";

const temporaryDirectories: string[] = [];
const fingerprint = "a".repeat(64);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("DirectoryIdempotencyLedger", () => {
  it("persists a creation outcome without storing the request payload", async () => {
    const root = join(process.cwd(), "tests", "idempotency-ledger-test");
    temporaryDirectories.push(root);
    const first = new DirectoryIdempotencyLedger(root);
    await expect(first.reserve("request-1", fingerprint)).resolves.toEqual({ created: true });
    await first.put("request-1", {
      fingerprint,
      status: "succeeded",
      result: { instanceId: "pi-1" },
      updatedAt: "2026-08-12T00:00:00.000Z",
    });

    await expect(new DirectoryIdempotencyLedger(root).get("request-1")).resolves.toMatchObject({
      status: "succeeded",
      result: { instanceId: "pi-1" },
    });
    const entryDirectory = join(root, createHash("sha256").update("request-1").digest("hex"));
    expect(await readFile(join(entryDirectory, "succeeded.json"), "utf8")).not.toContain("formComponentValues");
  });

  it("atomically reserves one request across independent ledger instances", async () => {
    const root = join(process.cwd(), "tests", "idempotency-ledger-concurrent");
    temporaryDirectories.push(root);
    const [left, right] = await Promise.all([
      new DirectoryIdempotencyLedger(root).reserve("request-1", fingerprint),
      new DirectoryIdempotencyLedger(root).reserve("request-1", fingerprint),
    ]);

    expect([left, right].filter((value) => value.created)).toHaveLength(1);
    expect([left, right].filter((value) => !value.created)).toHaveLength(1);
  });

  it("fails closed when a reservation has corrupt or missing status data", async () => {
    const root = join(process.cwd(), "tests", "idempotency-ledger-corrupt");
    temporaryDirectories.push(root);
    const entryDirectory = join(root, createHash("sha256").update("request-1").digest("hex"));
    await mkdir(entryDirectory, { recursive: true });
    await writeFile(join(entryDirectory, "succeeded.json"), JSON.stringify({ status: "succeeded" }), "utf8");

    await expect(new DirectoryIdempotencyLedger(root).reserve("request-1", fingerprint)).rejects.toMatchObject({
      code: "IDEMPOTENCY_LEDGER_ERROR",
    });
  });
});
