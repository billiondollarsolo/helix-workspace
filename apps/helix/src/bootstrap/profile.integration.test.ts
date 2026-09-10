import { SYSTEM_TENANT_CONFIG, type Actor } from "@helix/sdk-types";
import fastify, { type FastifyRequest } from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerCanonicalApi } from "./route-scope.js";
import { cleanupTestTenants } from "../test-support/cleanup-tenants.js";
import { PostgresAuditStore } from "../platform/audit/store.js";
import {
  installTenantContextHook,
  installTenantPostgresContextHook,
} from "../platform/tenancy/middleware.js";
import { PostgresOrgStore } from "../platform/tenancy/orgs.js";
import {
  tenantAwarePostgresSql,
  withTenantPostgresContext,
} from "../platform/tenancy/postgres-roles.js";
import {
  createBetterAuthPlatformModule,
  PostgresBetterAuthActorStore,
} from "../platform/auth/better-auth.js";
import { createCsrfToken, isTrustedCookieMutation } from "../platform/auth/browser-security.js";
import { PostgresProfileStore, registerProfileRoutes } from "../platform/auth/profile.js";

const orgId = "b7400000-0000-4000-8000-000000000001";
const foreignOrgId = "b7400000-0000-4000-8000-000000000002";
const memberId = "b7400000-0000-4000-8000-000000000011";
const adminId = "b7400000-0000-4000-8000-000000000012";
const foreignMemberId = "b7400000-0000-4000-8000-000000000013";
const agentId = "b7400000-0000-4000-8000-000000000014";
const memberEmail = "member@profile-regression.invalid";
const adminEmail = "admin@profile-regression.invalid";
const databaseUrl = process.env.DATABASE_URL;
const runtimeUrl = process.env.HELIX_RLS_APP_DATABASE_URL;

describe(
  "profile persistence with runtime PostgreSQL role",
  {
    skip: databaseUrl === undefined || runtimeUrl === undefined,
  },
  () => {
    const app = fastify();
    const csrf = createCsrfToken();
    const headers = {
      cookie: `helix_session=member; helix_csrf=${csrf}`,
      origin: "http://profile.test",
      "x-helix-csrf-token": csrf,
    };
    const adminHeaders = { ...headers, cookie: `helix_session=admin; helix_csrf=${csrf}` };
    let admin: postgres.Sql;
    let sql: postgres.Sql;
    let store: PostgresProfileStore;
    let failAudit = false;
    let resolveActor: (request: FastifyRequest) => Promise<Actor | null>;

    beforeAll(async () => {
      if (databaseUrl === undefined || runtimeUrl === undefined)
        throw new Error("Live DB URLs required");
      admin = postgres(databaseUrl, { max: 2 });
      sql = tenantAwarePostgresSql(postgres(runtimeUrl, { max: 3, prepare: false }));
      await cleanupTestTenants(admin, [orgId, foreignOrgId]);
      await admin`insert into orgs (id, slug, display_name) values
      (${orgId}, 'profile-regression', 'Profiles'), (${foreignOrgId}, 'profile-regression-foreign', 'Foreign profiles')`;
      await admin`insert into actors (id, org_id, type, email, display_name, scopes, metadata) values
      (${memberId}, ${orgId}, 'user', ${memberEmail}, 'Original member', '{}', '{"unrelated":{"keep":true},"profile":{"legacy":"keep"}}'),
      (${adminId}, ${orgId}, 'user', ${adminEmail}, 'Profile admin', '{admin.users}', '{}'),
      (${foreignMemberId}, ${foreignOrgId}, 'user', ${memberEmail}, 'Foreign display name', '{}', '{}'),
      (${agentId}, ${orgId}, 'agent', null, 'Robot', '{}', '{}')`;
      await admin`insert into "user" (id, name, email, "emailVerified") values
      ('profile-member-auth', 'Global identity name', ${memberEmail}, true),
      ('profile-admin-auth', 'Global admin name', ${adminEmail}, true)`;
      const org = await new PostgresOrgStore(admin).findById(orgId);
      if (org === null) throw new Error("Fixture org missing");
      installTenantContextHook(app, {
        resolveTenantContext: async () => ({
          org,
          orgId,
          orgSlug: org.slug,
          orgTier: org.tier,
          orgRegion: org.region,
          effectiveConfig: SYSTEM_TENANT_CONFIG,
        }),
      });
      installTenantPostgresContextHook(app, sql);
      app.addHook("onRequest", async (request, reply) => {
        const csrfToken = request.headers["x-helix-csrf-token"];
        if (
          !isTrustedCookieMutation({
            method: request.method,
            origin: request.headers.origin,
            cookie: request.headers.cookie,
            csrfToken: typeof csrfToken === "string" ? csrfToken : undefined,
            trustedOrigins: new Set(["http://profile.test"]),
          })
        )
          return reply.code(403).send({ code: "csrf_rejected" });
      });
      const platform = createBetterAuthPlatformModule({
        actorStore: new PostgresBetterAuthActorStore(sql),
        defaultOrgId: orgId,
      });
      resolveActor = async (request) => {
        const isAdmin = request.headers.cookie?.startsWith("helix_session=admin;") === true;
        const result = await platform.resolveUserActor(
          {
            id: isAdmin ? "profile-admin-auth" : "profile-member-auth",
            name: isAdmin ? "Global admin name" : "Global identity name",
            email: isAdmin ? adminEmail : memberEmail,
            emailVerified: true,
          },
          orgId,
        );
        return result?.actor ?? null;
      };
      store = new PostgresProfileStore(sql);
      const audit = new PostgresAuditStore(sql);
      await registerCanonicalApi(app, async (api) => {
        registerProfileRoutes(api, {
          store,
          sessionActorResolver: { resolve: resolveActor },
          actorFromRequest: async (request) => {
            const actor = await resolveActor(request);
            if (actor === null) throw new Error("Fixture actor missing");
            return actor;
          },
          auditSink: {
            append: async (record) => {
              const result = await audit.append(record);
              if (failAudit) throw new Error("Audit unavailable");
              return result;
            },
          },
        });
      });
    });

    afterAll(async () => {
      await app.close();
      await sql.end();
      await cleanupTestTenants(admin, [orgId, foreignOrgId]);
      await admin`delete from "user" where id in ('profile-member-auth', 'profile-admin-auth')`;
      await admin`delete from identity_subjects where canonical_email in (${memberEmail}, ${adminEmail})`;
      await admin.end();
    });

    it("persists self edits across fresh login resolution while preserving global identity and another tenant", async () => {
      const changed = await app.inject({
        method: "PATCH",
        url: "/v1/api/profile",
        headers,
        payload: {
          displayName: "  Alex Actual  ",
          pronouns: "they/them",
          jobTitle: "Engineer",
          about: "First line\nSecond line",
        },
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json().profile).toMatchObject({
        actorId: memberId,
        displayName: "Alex Actual",
        pronouns: "they/them",
      });
      // Each new request activates the verified identity again using its stale global name.
      const reloaded = await app.inject({ url: "/v1/api/profile", headers });
      expect(reloaded.json()).toEqual(changed.json());
      const [stored] =
        await admin`select display_name, metadata, scopes from actors where id = ${memberId}`;
      expect(stored).toMatchObject({
        display_name: "Alex Actual",
        scopes: [],
        metadata: {
          unrelated: { keep: true },
          profile: {
            legacy: "keep",
            pronouns: "they/them",
            jobTitle: "Engineer",
            about: "First line\nSecond line",
          },
        },
      });
      expect(await admin`select name from "user" where id = 'profile-member-auth'`).toEqual([
        { name: "Global identity name" },
      ]);
      expect(
        await admin`select display_name from identity_subjects where canonical_email = ${memberEmail}`,
      ).toEqual([{ display_name: "Original member" }]);
      expect(
        await admin`select display_name, metadata from actors where id = ${foreignMemberId}`,
      ).toEqual([{ display_name: "Foreign display name", metadata: {} }]);
      const [audit] =
        await admin`select actor_id, payload from activity where org_id = ${orgId} and verb = 'user.profile.updated' and object_id = ${memberId}`;
      expect(audit).toEqual({
        actor_id: memberId,
        payload: { fields: ["displayName", "pronouns", "jobTitle", "about"], self: true },
      });
    });

    it("lets an administrator update a tenant member, clears individual fields, and preserves other details", async () => {
      const changed = await app.inject({
        method: "PATCH",
        url: `/v1/api/admin/users/${memberId}/profile`,
        headers: adminHeaders,
        payload: { displayName: "Admin corrected name", pronouns: "" },
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(changed.json().profile).toMatchObject({
        displayName: "Admin corrected name",
        pronouns: "",
        jobTitle: "Engineer",
      });
      expect((await app.inject({ url: "/v1/api/profile", headers })).json()).toEqual(
        changed.json(),
      );
      const [audit] =
        await admin`select actor_id, payload from activity where org_id = ${orgId} and verb = 'user.profile.updated' and actor_id = ${adminId}`;
      expect(audit).toEqual({
        actor_id: adminId,
        payload: { fields: ["displayName", "pronouns"], self: false },
      });
    });

    it("denies cross-tenant targets through routes and RLS, and refuses non-human profiles", async () => {
      for (const targetId of [foreignMemberId, agentId]) {
        for (const method of ["GET", "PATCH"] as const) {
          const response = await app.inject({
            method,
            url: `/v1/api/admin/users/${targetId}/profile`,
            headers: adminHeaders,
            ...(method === "PATCH" ? { payload: { displayName: "Must not change" } } : {}),
          });
          expect(response.statusCode, response.body).toBe(404);
        }
      }
      expect(
        await withTenantPostgresContext(sql, { orgId, actorId: adminId }, () =>
          store.get(foreignOrgId, foreignMemberId),
        ),
      ).toBeNull();
      expect(
        await withTenantPostgresContext(sql, { orgId, actorId: adminId }, () =>
          store.update(foreignOrgId, foreignMemberId, { displayName: "RLS must deny" }),
        ),
      ).toBeNull();
      const denied = await app.inject({
        method: "PATCH",
        url: `/v1/api/admin/users/${adminId}/profile`,
        headers,
        payload: { displayName: "Denied" },
      });
      expect(denied.statusCode).toBe(403);
    });

    it("rolls both the profile and audit row back when auditing fails", async () => {
      const before = (await app.inject({ url: "/v1/api/profile", headers })).json();
      const [count] =
        await admin`select count(*)::int as total from activity where org_id = ${orgId}`;
      failAudit = true;
      try {
        const response = await app.inject({
          method: "PATCH",
          url: "/v1/api/profile",
          headers,
          payload: { displayName: "Must roll back" },
        });
        expect(response.statusCode).toBe(500);
      } finally {
        failAudit = false;
      }
      expect((await app.inject({ url: "/v1/api/profile", headers })).json()).toEqual(before);
      expect(
        await admin`select count(*)::int as total from activity where org_id = ${orgId}`,
      ).toEqual([count]);
    });

    it("retains cookie mutation CSRF protection for both update routes", async () => {
      for (const url of ["/v1/api/profile", `/v1/api/admin/users/${memberId}/profile`]) {
        const response = await app.inject({
          method: "PATCH",
          url,
          headers: { cookie: headers.cookie, origin: "http://attacker.test" },
          payload: { displayName: "Denied" },
        });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toEqual({ code: "csrf_rejected" });
      }
    });
  },
);
