import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBetterAuthRuntime } from "../../platform/auth/better-auth.js";
import { resolveTenantOidcUser } from "../../platform/auth/sso-runtime.js";

describe.skipIf(process.env.DATABASE_URL === undefined)("Postgres tenant OIDC runtime", () => {
  const sql = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
  const orgId = "f1590000-0000-4000-8000-000000000001";
  const actorId = "f1590000-0000-4000-8000-000000000002";
  const domainId = "f1590000-0000-4000-8000-000000000003";
  const configId = "f1590000-0000-4000-8000-000000000004";
  const userId = "iam14-user";
  const providerId = `helix-oidc-${orgId}-${configId}`;
  let subjectId = "";

  beforeAll(async () => {
    await cleanup();
    await sql`insert into orgs (id, slug, display_name) values (${orgId}, 'iam14-test', 'IAM 14')`;
    await sql`insert into actors (id, org_id, type, email, display_name)
      values (${actorId}, ${orgId}, 'user', 'member@iam14.example', 'IAM 14 Member')`;
    await sql`insert into "user" (id, name, email, "emailVerified")
      values (${userId}, 'IAM 14 Member', 'member@iam14.example', true)`;
    const subjects = await sql<{ readonly id: string }[]>`
      select id from identity_subjects where canonical_email = 'member@iam14.example'
    `;
    subjectId = subjects[0]?.id ?? "";
    await sql`insert into identity_provider_subjects (provider, provider_subject, subject_id)
      values ('better-auth', ${userId}, ${subjectId})`;
    await sql`insert into tenant_idp_configs (
      id, org_id, protocol, is_primary, display_name, config,
      signing_cert_secret_handle, attr_mapping, jit_provisioning, enabled
    ) values (
      ${configId}, ${orgId}, 'oidc', true, 'IAM 14 OIDC',
      '{"issuer":"https://idp.iam14.example","clientId":"helix-iam14"}',
      'iam14-private-key', '{"email":"$.email","displayName":"$.name"}', false, true
    )`;
    await sql`insert into admin_domains (
      id, org_id, domain, verification_host, verification_value,
      verification_expires_at, created_by
    ) values (
      ${domainId}, ${orgId}, 'iam14.example', '_verify.iam14.example', 'iam14',
      now() + interval '1 day', ${actorId}
    )`;
    await sql`select helix_record_domain_verification(${orgId}, ${domainId}, true, ${actorId})`;
    await sql`select helix_set_domain_capabilities(
      ${orgId}, ${domainId}, true, false, false, false, true, null,
      'secondary', null, ${actorId}
    )`;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  it("projects a verified domain with PKCE and no stored credential", async () => {
    const rows = await sql<
      { readonly providerId: string; readonly domain: string; readonly oidcConfig: string }[]
    >`
      select "providerId", domain, "oidcConfig" from "ssoProvider" where id = ${configId}
    `;
    expect(rows[0]).toMatchObject({ providerId, domain: "iam14.example" });
    const config = JSON.parse(rows[0]?.oidcConfig ?? "{}") as Record<string, unknown>;
    expect(config).toMatchObject({
      issuer: "https://idp.iam14.example",
      clientId: "helix-iam14",
      pkce: true,
      tokenEndpointAuthentication: "private_key_jwt",
      privateKeyId: "iam14-private-key",
    });
    expect(rows[0]?.oidcConfig).not.toContain("privateKeyPem");
    expect(rows[0]?.oidcConfig).not.toContain("clientSecret");
  });

  it("links only the active pre-provisioned member in the projected tenant", async () => {
    await expect(resolveTenantOidcUser(sql, oidcInput("member@iam14.example"))).resolves.toEqual({
      action: "link",
      userId,
      profile: "preserve",
    });
    await expect(
      resolveTenantOidcUser(sql, oidcInput("intruder@outside.example")),
    ).resolves.toMatchObject({
      action: "reject",
      code: "SSO_IDENTITY_NOT_PROVISIONED",
    });
  });

  it("starts the maintained OIDC flow with one-time state and PKCE", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        issuer: "https://idp.iam14.example",
        authorization_endpoint: "https://idp.iam14.example/authorize",
        token_endpoint: "https://idp.iam14.example/token",
        jwks_uri: "https://idp.iam14.example/jwks",
        userinfo_endpoint: "https://idp.iam14.example/userinfo",
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["private_key_jwt"],
        code_challenge_methods_supported: ["S256"],
      }),
    );
    const runtime = createBetterAuthRuntime({
      databaseUrl: process.env.DATABASE_URL ?? "",
      secret: "iam14-test-secret-with-at-least-thirty-two-characters",
      baseUrl: "https://auth.helix.test",
      secureCookies: true,
      resolveSsoUser: (input) => resolveTenantOidcUser(sql, input),
      resolveSsoPrivateKey: async () => ({ privateKeyPem: "unused-during-initiation" }),
    });
    try {
      const response = await runtime.auth.handler(
        new Request("https://auth.helix.test/api/auth/sign-in/sso", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://auth.helix.test" },
          body: JSON.stringify({
            email: "member@iam14.example",
            providerType: "oidc",
            requestSignUp: false,
            callbackURL: "https://auth.helix.test/mail",
            errorCallbackURL: "https://auth.helix.test/login",
          }),
        }),
      );
      const responseBody = await response.text();
      expect(response.status, responseBody).toBe(200);
      const payload = JSON.parse(responseBody) as { readonly url?: string };
      const authorization = new URL(payload.url ?? "");
      expect(authorization.origin).toBe("https://idp.iam14.example");
      expect(authorization.searchParams.get("state")).toBeTruthy();
      expect(authorization.searchParams.get("code_challenge")).toBeTruthy();
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
      await runtime.pool.end();
    }
  });

  it("removes and recreates runtime routing when the IdP is disabled", async () => {
    await sql`update tenant_idp_configs set enabled = false where id = ${configId}`;
    expect(await sql`select 1 from "ssoProvider" where id = ${configId}`).toHaveLength(0);
    await sql`update tenant_idp_configs set enabled = true, is_primary = true where id = ${configId}`;
    expect(await sql`select 1 from "ssoProvider" where id = ${configId}`).toHaveLength(1);
  });

  async function cleanup(): Promise<void> {
    await sql`delete from tenant_idp_configs where id = ${configId}`;
    await sql`delete from admin_domain_primary_transitions where org_id = ${orgId}`;
    await sql`delete from admin_domains where id = ${domainId}`;
    await sql`delete from identity_provider_subjects where provider = 'better-auth' and provider_subject = ${userId}`;
    await sql`delete from organization_memberships where org_id = ${orgId}`;
    await sql`delete from actors where id = ${actorId}`;
    await sql`delete from identity_subjects where canonical_email = 'member@iam14.example'`;
    await sql`delete from orgs where id = ${orgId}`;
    await sql`delete from "user" where id = ${userId}`;
  }

  function oidcInput(email: string) {
    return {
      protocol: "oidc" as const,
      providerId,
      accountKey: { issuer: "https://idp.iam14.example", accountId: "subject-1" },
      providerUser: { email, emailVerified: true, name: "IAM 14 Member" },
      providerClaims: { sub: "subject-1", email },
      verifiedIdTokenClaims: { iss: "https://idp.iam14.example", sub: "subject-1" },
      providerReference: {
        providerId,
        source: { type: "persisted" as const, recordId: configId },
        authenticationConfigurationFingerprint: "fingerprint",
      },
    };
  }
});
