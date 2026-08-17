import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

import {
  assertRefreshSuccessor,
  type AuthorizationCodeRecord,
  type AuthorizationStore,
  type AuthorizationTransaction,
  type RefreshRotateResult,
  type RefreshTokenRecord,
  type RefreshTokenSuccessor,
  DEFAULT_DYNAMIC_CLIENT_TTL_SECONDS,
  validateDynamicClientRegistration,
} from "./mcp-authorization.js";

interface StoredSpentRefresh {
  familyId: string;
  expiresAt: number;
}

interface StoredClient {
  client: OAuthClientInformationFull;
  expiresAt: number;
}

interface AuthorizationState {
  schemaVersion: 1;
  refreshTokenUpgradeVersion?: number;
  clients: Record<string, StoredClient>;
  transactions: Record<string, AuthorizationTransaction>;
  authorizationCodes: Record<string, AuthorizationCodeRecord>;
  refreshTokens: Record<string, RefreshTokenRecord>;
  spentRefreshTokens: Record<string, StoredSpentRefresh>;
  revokedFamilies: Record<string, number>;
}

export interface DirectoryAuthorizationStoreOptions {
  now?: () => number;
  maximumClients?: number;
  clientTtlSeconds?: number;
  refreshTokenUpgradeTtlSeconds?: number;
}

export const MAX_AUTHORIZATION_STATE_BYTES = 4 * 1024 * 1024;
const REFRESH_TOKEN_UPGRADE_VERSION = 1;

export class DirectoryAuthorizationStore implements AuthorizationStore {
  readonly #root: string;
  readonly #statePath: string;
  readonly #now: () => number;
  readonly #maximumClients: number;
  readonly #clientTtlSeconds: number;
  readonly #refreshTokenUpgradeTtlSeconds: number | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(root: string, options: DirectoryAuthorizationStoreOptions = {}) {
    this.#root = resolve(root);
    this.#statePath = resolve(this.#root, "authorization-state.json");
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.#maximumClients = options.maximumClients ?? 1000;
    this.#clientTtlSeconds = options.clientTtlSeconds ?? DEFAULT_DYNAMIC_CLIENT_TTL_SECONDS;
    this.#refreshTokenUpgradeTtlSeconds = options.refreshTokenUpgradeTtlSeconds;
  }

  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.#update((state) => clone(state.clients[clientId]?.client));
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    const full = client as OAuthClientInformationFull;
    return this.#update((state) => {
      validateDynamicClientRegistration(full);
      if (Object.keys(state.clients).length >= this.#maximumClients && state.clients[full.client_id] === undefined) {
        throw new InvalidClientMetadataError("The dynamic client registration limit has been reached.");
      }
      state.clients[full.client_id] = {
        client: clone(full),
        expiresAt: this.#now() + this.#clientTtlSeconds,
      };
      return clone(full);
    });
  }

  prune(): Promise<void> {
    return this.#update(() => undefined);
  }

  touchClient(clientId: string): Promise<void> {
    return this.#update((state) => {
      const stored = state.clients[clientId];
      if (stored === undefined) throw new InvalidClientMetadataError("The OAuth client registration has expired.");
      stored.expiresAt = this.#now() + this.#clientTtlSeconds;
    });
  }

  putTransaction(stateToken: string, transaction: AuthorizationTransaction): Promise<void> {
    return this.#update((state) => {
      state.transactions[hash(stateToken)] = clone(transaction);
    });
  }

  consumeTransaction(stateToken: string): Promise<AuthorizationTransaction | undefined> {
    return this.#update((state) => {
      const key = hash(stateToken);
      const value = state.transactions[key];
      delete state.transactions[key];
      return clone(value);
    });
  }

  putAuthorizationCode(code: string, record: AuthorizationCodeRecord): Promise<void> {
    return this.#update((state) => {
      state.authorizationCodes[hash(code)] = clone(record);
    });
  }

  getAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    return this.#update((state) => clone(state.authorizationCodes[hash(code)]));
  }

  consumeAuthorizationCode(code: string): Promise<AuthorizationCodeRecord | undefined> {
    return this.#update((state) => {
      const key = hash(code);
      const value = state.authorizationCodes[key];
      delete state.authorizationCodes[key];
      return clone(value);
    });
  }

  putRefreshToken(token: string, record: RefreshTokenRecord): Promise<void> {
    return this.#update((state) => {
      state.refreshTokens[hash(token)] = clone(record);
    });
  }

  rotateRefreshToken<T>(
    token: string,
    successorFactory: (record: RefreshTokenRecord) => Promise<RefreshTokenSuccessor<T>>,
  ): Promise<RefreshRotateResult<T>> {
    return this.#update(async (state) => {
      const key = hash(token);
      const record = state.refreshTokens[key];
      if (record !== undefined) {
        if (state.revokedFamilies[record.familyId] !== undefined) return { status: "missing" };
        const successor = await successorFactory(clone(record));
        assertRefreshSuccessor(token, record, successor);
        const client = state.clients[record.clientId];
        if (client === undefined) throw new InvalidClientMetadataError("The OAuth client registration has expired.");
        delete state.refreshTokens[key];
        for (const [spentKey, spent] of Object.entries(state.spentRefreshTokens)) {
          if (spent.familyId === record.familyId) delete state.spentRefreshTokens[spentKey];
        }
        state.spentRefreshTokens[key] = {
          familyId: record.familyId,
          expiresAt: successor.record.expiresAt,
        };
        state.refreshTokens[hash(successor.token)] = clone(successor.record);
        client.expiresAt = this.#now() + this.#clientTtlSeconds;
        return { status: "rotated", result: successor.result };
      }
      const spent = state.spentRefreshTokens[key];
      if (spent !== undefined) {
        state.revokedFamilies[spent.familyId] = spent.expiresAt;
        return { status: "replayed" };
      }
      return { status: "missing" };
    });
  }

  revokeRefreshToken(token: string): Promise<void> {
    return this.#update((state) => {
      const key = hash(token);
      const active = state.refreshTokens[key];
      const spent = state.spentRefreshTokens[key];
      const familyId = active?.familyId ?? spent?.familyId;
      const expiresAt = active?.expiresAt ?? spent?.expiresAt;
      if (familyId !== undefined && expiresAt !== undefined) state.revokedFamilies[familyId] = expiresAt;
    });
  }

  #update<T>(operation: (state: AuthorizationState) => T | Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const state = await this.#read();
      const now = this.#now();
      upgradeLegacyRefreshTokens(state, now, this.#refreshTokenUpgradeTtlSeconds);
      pruneExpired(state, now);
      const result = await operation(state);
      await this.#write(state);
      return result;
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #read(): Promise<AuthorizationState> {
    try {
      const file = await stat(this.#statePath);
      if (file.size > MAX_AUTHORIZATION_STATE_BYTES) {
        throw new Error("Authorization state file exceeds the configured size limit.");
      }
      const parsed = JSON.parse(await readFile(this.#statePath, "utf8")) as unknown;
      if (!isAuthorizationState(parsed)) throw new Error("Authorization state file has an invalid schema.");
      return parsed;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return emptyState();
      throw error;
    }
  }

  async #write(state: AuthorizationState): Promise<void> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const temporaryPath = resolve(this.#root, `.authorization-state-${randomUUID()}.tmp`);
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized, "utf8") > MAX_AUTHORIZATION_STATE_BYTES) {
      throw new Error("Authorization state exceeds the configured size limit.");
    }
    await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, this.#statePath);
  }
}

function emptyState(): AuthorizationState {
  return {
    schemaVersion: 1,
    clients: {},
    transactions: {},
    authorizationCodes: {},
    refreshTokens: {},
    spentRefreshTokens: {},
    revokedFamilies: {},
  };
}

function pruneExpired(state: AuthorizationState, now: number): void {
  pruneRecord(state.clients, (record) => record.expiresAt < now);
  pruneRecord(state.transactions, (record) => record.expiresAt < now);
  pruneRecord(state.authorizationCodes, (record) => record.expiresAt < now);
  pruneRecord(state.refreshTokens, (record) => record.expiresAt < now);
  pruneRecord(state.spentRefreshTokens, (record) => record.expiresAt < now);
  pruneRecord(state.revokedFamilies, (expiresAt) => expiresAt < now);
}

function upgradeLegacyRefreshTokens(
  state: AuthorizationState,
  now: number,
  refreshTokenTtlSeconds: number | undefined,
): void {
  if (
    refreshTokenTtlSeconds === undefined ||
    (state.refreshTokenUpgradeVersion ?? 0) >= REFRESH_TOKEN_UPGRADE_VERSION
  ) {
    return;
  }
  const familyExpiries = new Map<string, number>();
  for (const record of Object.values(state.refreshTokens)) {
    if (record.expiresAt < now) continue;
    record.expiresAt = Math.max(record.expiresAt, now + refreshTokenTtlSeconds);
    familyExpiries.set(record.familyId, Math.max(familyExpiries.get(record.familyId) ?? 0, record.expiresAt));
  }
  for (const spent of Object.values(state.spentRefreshTokens)) {
    const familyExpiry = familyExpiries.get(spent.familyId);
    if (familyExpiry !== undefined && spent.expiresAt < familyExpiry) spent.expiresAt = familyExpiry;
  }
  for (const [familyId, familyExpiry] of familyExpiries) {
    const revokedUntil = state.revokedFamilies[familyId];
    if (revokedUntil !== undefined && revokedUntil < familyExpiry) {
      state.revokedFamilies[familyId] = familyExpiry;
    }
  }
  state.refreshTokenUpgradeVersion = REFRESH_TOKEN_UPGRADE_VERSION;
}

export interface AuthorizationStoreSweep {
  close(): void;
}

export async function startAuthorizationStoreSweep(
  store: Pick<AuthorizationStore, "prune">,
  options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
): Promise<AuthorizationStoreSweep> {
  const intervalMs = options.intervalMs ?? 15 * 60 * 1000;
  if (!Number.isInteger(intervalMs) || intervalMs < 1) throw new Error("intervalMs must be a positive integer.");
  await store.prune();
  const timer = setInterval(() => void store.prune().catch((error: unknown) => options.onError?.(error)), intervalMs);
  timer.unref();
  return { close: () => clearInterval(timer) };
}

function pruneRecord<T>(record: Record<string, T>, expired: (value: T) => boolean): void {
  for (const [key, value] of Object.entries(record)) {
    if (expired(value)) delete record[key];
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clone<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function isAuthorizationState(value: unknown): value is AuthorizationState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Partial<AuthorizationState>;
  return state.schemaVersion === 1 &&
    (state.refreshTokenUpgradeVersion === undefined || Number.isInteger(state.refreshTokenUpgradeVersion)) &&
    isRecord(state.clients) &&
    isRecord(state.transactions) &&
    isRecord(state.authorizationCodes) &&
    isRecord(state.refreshTokens) &&
    isRecord(state.spentRefreshTokens) &&
    isRecord(state.revokedFamilies);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
