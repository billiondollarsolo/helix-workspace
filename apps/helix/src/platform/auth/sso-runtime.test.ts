import { generateKeyPairSync } from "node:crypto";
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { createRecordingSql as sharedRecordingSql } from "../../test-support/recording-sql.js";
import { resolveTenantOidcPrivateKey, resolveTenantOidcUser } from "./sso-runtime.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const configId = "33333333-3333-4333-8333-333333333333";
const providerId = `helix-oidc-${orgId}-${configId}`;

describe("tenant OIDC runtime boundary", () => {
  it("links only a pre-provisioned active tenant member", async () => {
    const sql = fakeSql([{ user_id: "better-auth-user" }]);
    await expect(resolveTenantOidcUser(sql, oidcInput())).resolves.toEqual({
      action: "link",
      userId: "better-auth-user",
      profile: "preserve",
    });
  });

  it("fails closed for malformed, cross-tenant, or unprovisioned identities", async () => {
    const query = vi.fn();
    await expect(
      resolveTenantOidcUser(query as unknown as postgres.Sql, {
        ...oidcInput(),
        providerId: "helix-oidc-invalid",
      }),
    ).resolves.toMatchObject({ action: "reject" });
    await expect(resolveTenantOidcUser(fakeSql([]), oidcInput())).resolves.toMatchObject({
      action: "reject",
      code: "SSO_IDENTITY_NOT_PROVISIONED",
    });
  });

  it("resolves only the exact tenant-bound private key handle", async () => {
    const read = vi.fn().mockResolvedValue({
      privateKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
      kid: "current",
      algorithm: "RS256",
    });
    await expect(
      resolveTenantOidcPrivateKey(
        fakeSql([{ handle: "oidc-key" }]),
        { read },
        {
          providerId,
          keyId: "oidc-key",
          issuer: "https://idp.example.com",
        },
      ),
    ).resolves.toMatchObject({ kid: "current", algorithm: "RS256" });
    expect(read).toHaveBeenCalledWith({ orgId, scope: "idp", handle: "oidc-key" });
    await expect(
      resolveTenantOidcPrivateKey(
        fakeSql([]),
        { read },
        {
          providerId,
          keyId: "other-key",
          issuer: "https://idp.example.com",
        },
      ),
    ).rejects.toThrow("binding is invalid");
  });
});

function oidcInput() {
  return {
    protocol: "oidc" as const,
    providerId,
    accountKey: { issuer: "https://idp.example.com", accountId: "subject-1" },
    providerUser: { email: "member@acme.example", emailVerified: true, name: "Member" },
    providerClaims: { sub: "subject-1" },
    verifiedIdTokenClaims: { iss: "https://idp.example.com", sub: "subject-1" },
    providerReference: {
      providerId,
      source: { type: "persisted" as const, recordId: configId },
      authenticationConfigurationFingerprint: "fingerprint",
    },
  };
}
const fakeSql = (rows: readonly Record<string, string>[]) => sharedRecordingSql(() => rows).sql;
