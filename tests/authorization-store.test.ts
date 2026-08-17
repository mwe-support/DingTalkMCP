import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, it } from "vitest";

import { DirectoryAuthorizationStore } from "../src/auth/authorization-store.js";
import { InMemoryAuthorizationStore } from "../src/auth/mcp-authorization.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DirectoryAuthorizationStore", () => {
  it("persists public client registrations and consumes OAuth state once across restarts", async () => {
    const root = await temporaryRoot();
    const first = new DirectoryAuthorizationStore(root, { now: () => 1_800_000_000 });
    const client = publicClient();
    await first.registerClient(client);
    await first.putTransaction("state-secret", {
      clientId: client.client_id,
      redirectUri: client.redirect_uris[0]!,
      codeChallenge: "challenge",
      resource: "https://dingtalk.mwexk.com/mcp",
      scopes: ["approval:read"],
      expiresAt: 1_800_000_300,
    });

    const restarted = new DirectoryAuthorizationStore(root, { now: () => 1_800_000_000 });
    await expect(restarted.getClient(client.client_id)).resolves.toMatchObject({ client_id: client.client_id });
    await expect(restarted.consumeTransaction("state-secret")).resolves.toMatchObject({ clientId: client.client_id });
    await expect(restarted.consumeTransaction("state-secret")).resolves.toBeUndefined();
    expect(await readFile(join(root, "authorization-state.json"), "utf8")).not.toContain("state-secret");
  });

  it("persists refresh rotation replay revocation without storing raw tokens", async () => {
    const root = await temporaryRoot();
    const first = new DirectoryAuthorizationStore(root, { now: () => 1_800_000_000 });
    const client = publicClient();
    await first.registerClient(client);
    const record = {
      familyId: "family-1",
      clientId: client.client_id,
      resource: "https://dingtalk.mwexk.com/mcp",
      scopes: ["approval:read"] as const,
      principal: {
        subject: "union-1",
        tenantId: "corp-1",
        userId: "user-1",
        authenticatedAt: 1_800_000_000,
      },
      expiresAt: 1_800_028_800,
    };
    await first.putRefreshToken("raw-refresh-1", { ...record, scopes: [...record.scopes] });
    await expect(first.rotateRefreshToken("raw-refresh-1", async (current) => ({
      token: "raw-refresh-2",
      record: { ...current, expiresAt: 1_800_028_900 },
      result: true,
    }))).resolves.toEqual({ status: "rotated", result: true });

    const restarted = new DirectoryAuthorizationStore(root, { now: () => 1_800_000_000 });
    await expect(restarted.rotateRefreshToken("raw-refresh-1", async () => {
      throw new Error("replay must not rotate");
    })).resolves.toEqual({ status: "replayed" });
    await expect(restarted.rotateRefreshToken("raw-refresh-2", async () => {
      throw new Error("revoked family must not rotate");
    })).resolves.toEqual({ status: "missing" });
    const serialized = await readFile(join(root, "authorization-state.json"), "utf8");
    expect(serialized).not.toContain("raw-refresh-1");
    expect(serialized).not.toContain("raw-refresh-2");
  });

  it("upgrades an unexpired legacy refresh token once across a deployment restart", async () => {
    const root = await temporaryRoot();
    let now = 1_800_000_000;
    const legacy = new DirectoryAuthorizationStore(root, { now: () => now });
    const client = publicClient();
    await legacy.registerClient(client);
    await legacy.putRefreshToken("legacy-refresh", {
      familyId: "legacy-family",
      clientId: client.client_id,
      resource: "https://dingtalk.mwexk.com/mcp",
      scopes: ["approval:read"],
      principal: {
        subject: "union-1",
        tenantId: "corp-1",
        userId: "user-1",
        authenticatedAt: now,
      },
      expiresAt: now + 100,
    });

    const upgraded = new DirectoryAuthorizationStore(root, {
      now: () => now,
      refreshTokenUpgradeTtlSeconds: 600,
    });
    await upgraded.prune();
    now += 101;
    await expect(upgraded.rotateRefreshToken("legacy-refresh", async (record) => ({
      token: "upgraded-refresh",
      record: { ...record, expiresAt: now + 600 },
      result: record.expiresAt,
    }))).resolves.toEqual({ status: "rotated", result: 1_800_000_600 });

    const serialized = JSON.parse(await readFile(join(root, "authorization-state.json"), "utf8")) as {
      refreshTokenUpgradeVersion?: number;
    };
    expect(serialized.refreshTokenUpgradeVersion).toBe(1);
  });

  it("rotates refresh tokens atomically with one bounded replay tombstone per family", async () => {
    const root = await temporaryRoot();
    const now = 1_800_000_000;
    const store = new DirectoryAuthorizationStore(root, { now: () => now });
    const client = publicClient();
    await store.registerClient(client);
    const baseRecord = {
      familyId: "bounded-family",
      clientId: client.client_id,
      resource: "https://dingtalk.mwexk.com/mcp",
      scopes: ["approval:read"] as const,
      principal: {
        subject: "union-1",
        tenantId: "corp-1",
        userId: "user-1",
        authenticatedAt: now,
      },
    };
    let currentToken = "bounded-refresh-0";
    await store.putRefreshToken(currentToken, {
      ...baseRecord,
      scopes: [...baseRecord.scopes],
      expiresAt: now + 600,
    });
    let previousToken = currentToken;
    for (let generation = 1; generation <= 200; generation += 1) {
      const nextToken = `bounded-refresh-${generation}`;
      const rotated = await store.rotateRefreshToken(currentToken, async (record) => ({
        token: nextToken,
        record: { ...record, expiresAt: now + 600 + generation },
        result: generation,
      }));
      expect(rotated).toEqual({ status: "rotated", result: generation });
      previousToken = currentToken;
      currentToken = nextToken;
    }

    const serialized = JSON.parse(await readFile(join(root, "authorization-state.json"), "utf8")) as {
      refreshTokens: Record<string, unknown>;
      spentRefreshTokens: Record<string, unknown>;
    };
    expect(Object.keys(serialized.refreshTokens)).toHaveLength(1);
    expect(Object.keys(serialized.spentRefreshTokens)).toHaveLength(1);
    await expect(store.rotateRefreshToken(previousToken, async () => {
      throw new Error("replayed tokens must not invoke the successor factory");
    })).resolves.toEqual({ status: "replayed" });
    await expect(store.rotateRefreshToken(currentToken, async () => {
      throw new Error("revoked families must not invoke the successor factory");
    })).resolves.toEqual({ status: "missing" });
  });

  it("keeps the current refresh token usable when successor creation fails", async () => {
    const root = await temporaryRoot();
    const now = 1_800_000_000;
    const store = new DirectoryAuthorizationStore(root, { now: () => now });
    const client = publicClient();
    await store.registerClient(client);
    await store.putRefreshToken("recoverable-refresh", {
      familyId: "recoverable-family",
      clientId: client.client_id,
      resource: "https://dingtalk.mwexk.com/mcp",
      scopes: ["approval:read"],
      principal: {
        subject: "union-1",
        tenantId: "corp-1",
        userId: "user-1",
        authenticatedAt: now,
      },
      expiresAt: now + 600,
    });

    await expect(store.rotateRefreshToken("recoverable-refresh", async () => {
      throw new Error("token signing failed");
    })).rejects.toThrow("token signing failed");
    await expect(store.rotateRefreshToken("recoverable-refresh", async (record) => ({
      token: "recovered-successor",
      record,
      result: true,
    }))).resolves.toEqual({ status: "rotated", result: true });
  });

  it("expires dynamically registered clients and removes them during pruning", async () => {
    const root = await temporaryRoot();
    let now = 1_800_000_000;
    const store = new DirectoryAuthorizationStore(root, {
      now: () => now,
      clientTtlSeconds: 60,
    });
    const client = publicClient();
    await store.registerClient(client);
    now += 61;

    await store.prune();

    await expect(store.getClient(client.client_id)).resolves.toBeUndefined();
  });

  it("does not renew a public client merely because its clientId was looked up", async () => {
    const root = await temporaryRoot();
    let now = 1_800_000_000;
    const store = new DirectoryAuthorizationStore(root, {
      now: () => now,
      clientTtlSeconds: 60,
    });
    const client = publicClient();
    await store.registerClient(client);

    now += 50;
    await expect(store.getClient(client.client_id)).resolves.toMatchObject({ client_id: client.client_id });
    now += 11;
    await expect(store.getClient(client.client_id)).resolves.toBeUndefined();
  });

  it("keeps an actively used public client registered with a sliding expiration", async () => {
    const root = await temporaryRoot();
    let now = 1_800_000_000;
    const store = new DirectoryAuthorizationStore(root, {
      now: () => now,
      clientTtlSeconds: 60,
    });
    const client = publicClient();
    await store.registerClient(client);

    now += 50;
    await expect(store.getClient(client.client_id)).resolves.toMatchObject({ client_id: client.client_id });
    await store.touchClient(client.client_id);
    now += 50;
    await expect(store.getClient(client.client_id)).resolves.toMatchObject({ client_id: client.client_id });
    await store.touchClient(client.client_id);
    now += 61;
    await expect(store.getClient(client.client_id)).resolves.toBeUndefined();
  });

  it("rejects oversized client metadata and oversized persisted state", async () => {
    const root = await temporaryRoot();
    const store = new DirectoryAuthorizationStore(root, { now: () => 1_800_000_000 });
    await expect(store.registerClient({ ...publicClient(), client_name: "x".repeat(20_000) })).rejects.toThrow(
      "metadata",
    );

    await writeFile(join(root, "authorization-state.json"), "x".repeat(5 * 1024 * 1024));
    await expect(store.getClient("client-1")).rejects.toThrow("size limit");
  });
});

describe("InMemoryAuthorizationStore", () => {
  it("rejects an expired refresh token before invoking the successor factory", async () => {
    let now = 1_800_000_000;
    const store = new InMemoryAuthorizationStore({ now: () => now });
    const client = publicClient();
    await store.registerClient(client);
    await store.putRefreshToken("expired-refresh", {
      familyId: "expired-family",
      clientId: client.client_id,
      resource: "https://dingtalk.mwexk.com/mcp",
      scopes: ["approval:read"],
      principal: {
        subject: "union-1",
        tenantId: "corp-1",
        userId: "user-1",
        authenticatedAt: now,
      },
      expiresAt: now + 1,
    });
    now += 2;

    await expect(store.rotateRefreshToken("expired-refresh", async () => {
      throw new Error("expired token must not invoke the successor factory");
    })).resolves.toEqual({ status: "missing" });
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mwe-approval-auth-"));
  roots.push(root);
  return root;
}

function publicClient(): OAuthClientInformationFull {
  return {
    client_id: "client-1",
    client_id_issued_at: 1_800_000_000,
    redirect_uris: ["http://127.0.0.1/callback"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}
