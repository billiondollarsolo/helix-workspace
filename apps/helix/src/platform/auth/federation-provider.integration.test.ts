import { createHash, randomUUID, randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { APIError } from "better-auth/api";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { tenantAwarePostgresSql } from "../tenancy/postgres-roles.js";
import { createCredentialUserForActor } from "../signup/verification.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { bootstrapWorkspaceOwner } from "./bootstrap-owner.js";
import { createBetterAuthRuntime } from "./better-auth.js";
import { FederationApplications } from "./federation-applications.js";

describe.skipIf(skipUnlessLiveDatabase("federation human OIDC provider"))(
  "federation human OIDC provider",
  () => {
    it("issues a PKCE-bound org/client identity using maintained signing keys and denies revoked assignments", async () => {
      const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "");
      const sql = tenantAwarePostgresSql(postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? ""));
      const federation = new FederationApplications(sql);
      const origin = "http://localhost:46991";
      const orgId = randomUUID(),
        appId = randomUUID(),
        email = `owner@${orgId}.test`;
      let assuranceDenied = false;
      const runtime = createBetterAuthRuntime({
        databaseUrl: process.env.HELIX_RLS_APP_DATABASE_URL ?? "",
        secret: "federation-fixture-secret-with-at-least-32-characters",
        baseUrl: origin,
        secureCookies: false,
        federationIdentity: {
          checkSession: async () => {
            if (assuranceDenied)
              throw new APIError("FORBIDDEN", { message: "Complete Workspace MFA first." });
            return false;
          },
          claims: (user, metadata) => federation.claims(user, metadata),
          userInfo: (user, claims) => federation.claims(user, claims),
        },
      });
      let userId = "";
      try {
        await admin`insert into orgs(id,slug,display_name,status) values(${orgId},${orgId},'Federation fixture','active')`;
        const owner = await bootstrapWorkspaceOwner(sql, { orgId, email, publicBaseUrl: origin });
        if (owner.status !== "invited") throw new Error("Fixture owner missing");
        await withTenantPostgresContext(sql, { orgId }, async (tx) => {
          const user = await createCredentialUserForActor(tx, {
            orgId,
            email,
            passwordHash: await hashPassword("federation fixture password"),
          });
          if (user === null) throw new Error("Fixture identity missing");
          userId = user.betterAuthUserId;
          await tx`insert into federation_applications(org_id,id,public_origin,installation_id,tenant_id,created_by_actor_id,pairing_digest,proof_digest,pairing_expires_at)
          values(${orgId},${appId},'https://bot.example',${randomUUID()},${randomUUID()},${owner.actorId},${randomUUID()},${randomUUID()},now()+interval '10 minutes')`;
          await tx`insert into federation_app_assignments(org_id,application_id,actor_id,role) values(${orgId},${appId},${owner.actorId},'member')`;
        });
        const clients = runtime.federationClients;
        if (clients === undefined) throw new Error("Provider disabled");
        const call = (path: string, init?: RequestInit) =>
          runtime.auth.handler(new Request(origin + "/api/auth/" + path, init));
        const login = await call("sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({ email, password: "federation fixture password" }),
        });
        expect(login.status, await login.clone().text()).toBe(200);
        const cookie = login.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        const client = await clients.create(
          { orgId, appId, origin: "https://bot.example" },
          new Headers({ cookie }),
        );
        await admin`update federation_applications set oidc_client_id=${client.clientId},status='active' where org_id=${orgId} and id=${appId}`;
        const metadata = await clients.discovery();
        expect(metadata.issuer).toBe(origin + "/v1/api/auth");
        expect(metadata.authorization_endpoint).toBe(origin + "/v1/api/auth/oauth2/authorize");
        expect(metadata.code_challenge_methods_supported).toContain("S256");
        const verifier = randomBytes(32).toString("base64url");
        const query = new URLSearchParams({
          client_id: client.clientId,
          response_type: "code",
          redirect_uri: "https://bot.example/v1/auth/sso/callback",
          scope: "openid profile email offline_access",
          state: "fixture-state",
          nonce: "fixture-nonce",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
        });
        assuranceDenied = true;
        const blocked = await call("oauth2/authorize?" + query.toString(), { headers: { cookie } });
        expect(blocked.status).toBe(403);
        expect(blocked.headers.get("location")).toBeNull();
        assuranceDenied = false;
        const authorize = await call("oauth2/authorize?" + query.toString(), {
          headers: { cookie },
        });
        expect(authorize.status, await authorize.clone().text()).toBe(302);
        const callback = new URL(authorize.headers.get("location") ?? "https://missing.invalid");
        const code = callback.searchParams.get("code");
        expect(code).toBeTruthy();
        const exchange = (codeValue: string, proof = verifier) =>
          call("oauth2/token", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
            },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              client_id: client.clientId,
              redirect_uri: "https://bot.example/v1/auth/sso/callback",
              code: codeValue,
              code_verifier: proof,
            }),
          });
        const token = await exchange(code ?? "");
        expect(token.status, await token.clone().text()).toBe(200);
        const payload = (await token.json()) as {
          id_token: string;
          access_token: string;
          refresh_token: string;
        };
        const claims = JSON.parse(
          Buffer.from(payload.id_token.split(".")[1] ?? "", "base64url").toString(),
        ) as Record<string, unknown>;
        expect(claims).toMatchObject({
          sub: userId,
          iss: metadata.issuer,
          aud: client.clientId,
          nonce: "fixture-nonce",
          helix_org_id: orgId,
          helix_app_id: appId,
          email_verified: true,
        });
        const refresh = (refreshToken: string) =>
          call("oauth2/token", {
            method: "POST",
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
            },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: refreshToken,
              client_id: client.clientId,
            }),
          });
        const refreshed = await refresh(payload.refresh_token);
        expect(refreshed.status, await refreshed.clone().text()).toBe(200);
        const renewed = (await refreshed.json()) as { refresh_token: string };
        const jwksResponse = await runtime.auth.handler(new Request(String(metadata.jwks_uri)));
        expect(jwksResponse.status).toBe(200);
        expect(JSON.stringify(await jwksResponse.json())).not.toContain('"d":');
        expect((await exchange(code ?? "")).ok).toBe(false);
        const unauthorized = await call("oauth2/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"] }),
        });
        expect(unauthorized.ok).toBe(false);
        await admin`delete from federation_app_assignments where org_id=${orgId} and application_id=${appId}`;
        expect((await refresh(renewed.refresh_token)).ok).toBe(false);
        await expect(
          federation.claims(userId, {
            helix_org_id: orgId,
            helix_app_id: appId,
            helix_client_id: client.clientId,
          }),
        ).rejects.toThrow();
        await expect(
          federation.claims(userId, {
            helix_org_id: randomUUID(),
            helix_app_id: appId,
            helix_client_id: client.clientId,
          }),
        ).rejects.toThrow();
        await clients.disable(client.clientId);
        expect(
          (await call("oauth2/authorize?" + query.toString(), { headers: { cookie } })).headers.get(
            "location",
          ) ?? "",
        ).not.toContain("code=");
        await admin`delete from "oauthClient" where "clientId"=${client.clientId}`;
      } finally {
        await runtime.pool.end();
        await admin`delete from federation_applications where org_id=${orgId}`;
        if (userId) await admin`delete from installation_admin_bootstrap where org_id=${orgId}`;
        await admin`delete from "user" where email=${email}`;
        await cleanupTestTenants(admin, [orgId]);
        await Promise.all([admin.end(), sql.end()]);
      }
    });
  },
);
