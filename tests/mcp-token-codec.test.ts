import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { JoseMcpTokenCodec } from "../src/auth/jwt-codec.js";

const issuer = "https://dingtalk.mwexk.com/";
const resource = "https://dingtalk.mwexk.com/mcp";

describe("JoseMcpTokenCodec", () => {
  it("issues a short-lived resource token and restores only verified identity claims", async () => {
    const { codec } = await fixture(1_800_000_000);
    const token = await codec.issue({
      principal: {
        subject: "union-1",
        tenantId: "corp-1",
        userId: "user-1",
        authenticatedAt: 1_799_999_900,
      },
      clientId: "client-1",
      scopes: ["approval:read", "approval:decide"],
    });

    const verified = await codec.verifyAccessToken(token);

    expect(verified).toMatchObject({
      token,
      clientId: "client-1",
      scopes: ["approval:read", "approval:decide"],
      expiresAt: 1_800_000_600,
      resource: new URL(resource),
      extra: {
        subject: "union-1",
        tenantId: "corp-1",
        userId: "user-1",
        authenticatedAt: 1_799_999_900,
      },
    });
  });

  it("rejects a token issued for another MCP resource", async () => {
    const { codec: issuingCodec, privateKeyPem } = await fixture(1_800_000_000, "https://other.example/mcp");
    const token = await issuingCodec.issue({
      principal: {
        subject: "union-1",
        tenantId: "corp-1",
        userId: "user-1",
        authenticatedAt: 1_799_999_900,
      },
      clientId: "client-1",
      scopes: ["approval:read"],
    });
    const { codec: verifyingCodec } = await fixture(1_800_000_000, resource, privateKeyPem);

    await expect(verifyingCodec.verifyAccessToken(token)).rejects.toThrow("Invalid MCP access token");
  });
});

async function fixture(
  nowSeconds: number,
  audience = resource,
  privateKeyPem?: string,
): Promise<{ codec: JoseMcpTokenCodec; privateKeyPem: string }> {
  const pem = privateKeyPem ?? createPrivateKeyPem();
  return {
    privateKeyPem: pem,
    codec: await JoseMcpTokenCodec.create({
      privateKeyPem: pem,
      keyId: "test-key-1",
      issuer,
      audience,
      accessTokenTtlSeconds: 600,
      now: () => nowSeconds,
    }),
  };
}

function createPrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}
