import type { FastifyRequest } from "fastify";
import { Socket } from "node:net";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toolInvocationPrincipalFromRequest } from "../../api/actor.js";
import { actorHasScope } from "../../api/scopes.js";
import { seedLocalOAuth } from "../../db/seed-local-oauth.js";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { createPostgresMemberScopes } from "./member-scopes.js";
import { OAuthTokenService } from "./oauth.js";
import { PostgresAgentCredentialStore, PostgresOAuthStore } from "./postgres-store.js";

const SKIP = skipUnlessLiveDatabase("CLI client-credential tokens with member profile scopes");
const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const runtimeUrl = process.env.HELIX_RLS_APP_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const ORG = "d2160000-0000-4000-8000-00000000000a";
const PERSON = "d2160000-0000-4000-8000-0000000000a1";
const AGENT = "d2160000-0000-4000-8000-0000000000a2";
const ISSUER = "urn:helix:member-scopes-test";

describe.skipIf(SKIP)("CLI client-credential tokens with member profile scopes", () => {
  const admin = postgres(adminUrl, { max: 1, prepare: false });
  const runtime = tenantAwarePostgresSql(postgres(runtimeUrl, { max: 2, prepare: false }));
  const oauth = new PostgresOAuthStore(runtime, ISSUER);
  const service = new OAuthTokenService({
    clientStore: oauth,
    tokenStore: oauth,
    issuer: ISSUER,
    memberScopes: createPostgresMemberScopes(runtime),
  });
  /** `/oauth/token` and API requests run in the tenant's RLS context. */
  const inTenant = <T>(work: () => Promise<T>): Promise<T> =>
    withTenantPostgresContext(runtime, { orgId: ORG }, work);
  const issue = (clientId: string, scope?: string) =>
    inTenant(() =>
      service.issueClientCredentialsToken({
        grantType: "client_credentials",
        clientId,
        clientSecret: `${clientId}-secret`,
        ...(scope === undefined ? {} : { scope }),
      }),
    );

  beforeAll(async () => {
    await cleanupTestTenants(admin, [ORG]);
    // A person and an agent whose clients carry product scopes but no profile.* scope.
    for (const [actorId, actorType, clientId] of [
      [PERSON, "user", "member-scopes-person"],
      [AGENT, "agent", "member-scopes-agent"],
    ] as const) {
      await seedLocalOAuth(admin, {
        orgId: ORG,
        actorId,
        actorType,
        email: `${clientId}@member-scopes.test`,
        displayName: clientId,
        clientId,
        clientSecret: `${clientId}-secret`,
        scopes: ["mail.read"],
      });
    }
  });

  afterAll(async () => {
    await cleanupTestTenants(admin, [ORG]);
    await admin.end();
    await runtime.end();
  });

  it("lets a person's CLI login carry the profile scopes of the member role", async () => {
    const issued = await issue("member-scopes-person");
    expect(issued.scope.split(" ").sort()).toEqual(["mail.read", "profile.read", "profile.write"]);

    const request = {
      headers: { authorization: `Bearer ${issued.access_token}` },
      query: {},
      raw: { socket: new Socket() },
    } as unknown as FastifyRequest;
    const resolved = await inTenant(() =>
      toolInvocationPrincipalFromRequest(
        request,
        oauth,
        undefined,
        new PostgresAgentCredentialStore(runtime),
      ),
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(actorHasScope(resolved.principal.actor, "profile.read")).toBe(true);
    expect(actorHasScope(resolved.principal.actor, "profile.write")).toBe(true);
  });

  it("does not widen an agent's client", async () => {
    await expect(issue("member-scopes-agent", "profile.read")).rejects.toMatchObject({
      code: "invalid_scope",
    });
    await expect(issue("member-scopes-agent")).resolves.toMatchObject({ scope: "mail.read" });
  });
});
