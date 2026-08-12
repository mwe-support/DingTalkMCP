import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ApprovalMcpError } from "./errors.js";

export type IdempotencyStatus = "pending" | "succeeded" | "uncertain";

export interface IdempotencyEntry {
  fingerprint: string;
  status: IdempotencyStatus;
  updatedAt: string;
  result?: unknown;
}

export interface IdempotencyLedger {
  reserve(
    key: string,
    fingerprint: string,
  ): Promise<{ created: true } | { created: false; entry: IdempotencyEntry }>;
  get(key: string): Promise<IdempotencyEntry | undefined>;
  put(key: string, entry: IdempotencyEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemoryIdempotencyLedger implements IdempotencyLedger {
  readonly #entries = new Map<string, IdempotencyEntry>();

  async reserve(
    key: string,
    fingerprint: string,
  ): Promise<{ created: true } | { created: false; entry: IdempotencyEntry }> {
    const existing = this.#entries.get(key);
    if (existing !== undefined) return { created: false, entry: existing };
    this.#entries.set(key, {
      fingerprint,
      status: "pending",
      updatedAt: new Date().toISOString(),
    });
    return { created: true };
  }

  async get(key: string): Promise<IdempotencyEntry | undefined> {
    return this.#entries.get(key);
  }

  async put(key: string, entry: IdempotencyEntry): Promise<void> {
    this.#entries.set(key, entry);
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }
}

/**
 * Cross-process idempotency ledger backed by one hashed directory per requestId.
 * mkdir is the atomic reservation: a crash leaves a pending directory, which is
 * intentionally treated as outcome-unknown rather than reclaimed and replayed.
 */
export class DirectoryIdempotencyLedger implements IdempotencyLedger {
  readonly #root: string;

  constructor(root: string) {
    this.#root = root;
  }

  async reserve(
    key: string,
    fingerprint: string,
  ): Promise<{ created: true } | { created: false; entry: IdempotencyEntry }> {
    await mkdir(this.#root, { recursive: true });
    const directory = this.#directory(key);
    try {
      await mkdir(directory);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw ledgerError("Unable to reserve the approval idempotency key.", error);
      }
      const existing = await this.#readExisting(directory, 1_000);
      return { created: false, entry: existing };
    }

    const pending: IdempotencyEntry = {
      fingerprint,
      status: "pending",
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.#writeStatus(directory, pending);
      return { created: true };
    } catch (error) {
      // Preserve the reservation directory. A missing/corrupt entry fails closed.
      throw ledgerError("Unable to persist the approval idempotency reservation.", error);
    }
  }

  async get(key: string): Promise<IdempotencyEntry | undefined> {
    const directory = this.#directory(key);
    try {
      return await this.#readExisting(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  async put(key: string, entry: IdempotencyEntry): Promise<void> {
    const directory = this.#directory(key);
    try {
      await this.#readExisting(directory);
      await this.#writeStatus(directory, entry);
    } catch (error) {
      if (error instanceof ApprovalMcpError) throw error;
      throw ledgerError("Unable to update the approval idempotency outcome.", error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await rm(this.#directory(key), { recursive: true, force: true });
    } catch (error) {
      throw ledgerError("Unable to clear a rejected approval idempotency reservation.", error);
    }
  }

  #directory(key: string): string {
    return join(this.#root, createHash("sha256").update(key).digest("hex"));
  }

  async #readExisting(directory: string, initializationWaitMs = 0): Promise<IdempotencyEntry> {
    const deadline = Date.now() + initializationWaitMs;
    while (true) {
      for (const status of ["succeeded", "uncertain", "pending"] as const) {
        try {
          const value = JSON.parse(await readFile(join(directory, `${status}.json`), "utf8")) as unknown;
          if (!isEntry(value) || value.status !== status) {
            throw new Error(`Invalid ${status} entry.`);
          }
          return value;
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") continue;
          throw ledgerError("Approval idempotency data is corrupt; fail closed.", error);
        }
      }
      if (Date.now() >= deadline) break;
      await delay(10);
    }
    throw ledgerError(
      "Approval idempotency reservation has no outcome; fail closed because a previous process may have crashed.",
      new Error("Missing status entry."),
    );
  }

  async #writeStatus(directory: string, entry: IdempotencyEntry): Promise<void> {
    const finalPath = join(directory, `${entry.status}.json`);
    const temporaryPath = join(directory, `${entry.status}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, finalPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function isEntry(value: unknown): value is IdempotencyEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.fingerprint === "string" &&
    /^[a-f0-9]{64}$/u.test(value.fingerprint) &&
    typeof value.updatedAt === "string" &&
    (value.status === "pending" || value.status === "succeeded" || value.status === "uncertain")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function ledgerError(message: string, cause: unknown): ApprovalMcpError {
  return new ApprovalMcpError("IDEMPOTENCY_LEDGER_ERROR", message, { cause, retryable: false });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
