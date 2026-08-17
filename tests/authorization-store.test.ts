import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { afterEach, describe, expect, it } from "vitest";

import { DirectoryAuthorizationStore } from "../src/auth/authorization-store.js";

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
    const record = {
      familyId: "family-1",
      clientId: "client-1",
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
    await expect(first.consumeRefreshToken("raw-refresh-1")).resolves.toMatchObject({ status: "active" });
    await first.putRefreshToken("raw-refresh-2", { ...record, scopes: [...record.scopes] });

    const restarted = new DirectoryAuthorizationStore(root, { now: () => 1_800_000_000 });
    await expect(restarted.consumeRefreshToken("raw-refresh-1")).resolves.toEqual({ status: "replayed" });
    await expect(restarted.consumeRefreshToken("raw-refresh-2")).resolves.toEqual({ status: "missing" });
    const serialized = await readFile(join(root, "authorization-state.json"), "utf8");
    expect(serialized).not.toContain("raw-refresh-1");
    expect(serialized).not.toContain("raw-refresh-2");
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
    now += 50;
    await expect(store.getClient(client.client_id)).resolves.toMatchObject({ client_id: client.client_id });
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
