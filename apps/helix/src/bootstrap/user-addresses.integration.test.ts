import { SYSTEM_TENANT_CONFIG, type Actor } from "@helix/sdk-types";
import fastify from "fastify";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerCanonicalApi } from "./route-scope.js";
import { cleanupTestTenants } from "../test-support/cleanup-tenants.js";
import { PostgresAuditStore } from "../platform/audit/store.js";
import { MailRoutingStore } from "../platform/mail/store-routing.js";
import {
  installTenantContextHook,
  installTenantPostgresContextHook,
} from "../platform/tenancy/middleware.js";
import { PostgresOrgStore } from "../platform/tenancy/orgs.js";
import {
  tenantAwarePostgresSql,
  withTenantPostgresContext,
} from "../platform/tenancy/postgres-roles.js";
import { PostgresBetterAuthActorStore } from "../platform/auth/better-auth.js";
import { registerUserAddressRoutes } from "../platform/auth/user-address-routes.js";
import {
  PostgresUserAddressStore,
  type UserMailAddresses,
} from "../platform/auth/user-addresses.js";

const orgId = "b7500000-0000-4000-8000-000000000010";
const foreignOrgId = "b7500000-0000-4000-8000-000000000020";
const memberId = "b7500000-0000-4000-8000-000000000011";
const otherId = "b7500000-0000-4000-8000-000000000012";
const foreignId = "b7500000-0000-4000-8000-000000000021";
const agentId = "b7500000-0000-4000-8000-000000000013";
const readonlyId = "b7500000-0000-4000-8000-000000000014";
const roleAdminId = "b7500000-0000-4000-8000-000000000015";
const deniedId = "b7500000-0000-4000-8000-000000000016";
const firstDomain = "address-primary.example.test";
const secondDomain = "address-secondary.example.test";
const mailOnlyDomain = "address-mail-only.example.test";
const aliasDomain = "address-brand.example.test";
const firstEmail = `member@${firstDomain}`;
const databaseUrl = process.env.DATABASE_URL;
const runtimeUrl = process.env.HELIX_RLS_APP_DATABASE_URL;

// Real request transaction and restricted runtime role; fixtures live only in Vitest's isolated DB.
describe.skipIf(!databaseUrl || !runtimeUrl)("admin user mailbox address lifecycle", () => {
  let admin: postgres.Sql, sql: postgres.Sql;
  const app = fastify();
  let failAudit = false;
  let current: Actor = { id: otherId, orgId, type: "user", scopes: ["admin.users", "mail.read"] };
  const url = (suffix = "", target = memberId) =>
    `/v1/api/admin/users/${target}/addresses${suffix}`;
  const put = (address: string) =>
    app.inject({ method: "PUT", url: url("/primary"), payload: { address } });

  beforeAll(async () => {
    if (databaseUrl === undefined || runtimeUrl === undefined)
      throw new Error("Live database URLs required");
    admin = postgres(databaseUrl, { max: 2 });
    sql = tenantAwarePostgresSql(postgres(runtimeUrl, { max: 4, prepare: false }));
    await cleanupTestTenants(admin, [orgId, foreignOrgId]);
    await admin`insert into orgs (id, slug, display_name) values (${orgId}, 'user-address-tests', 'Address tests'), (${foreignOrgId}, 'user-address-other', 'Foreign')`;
    await admin`insert into admin_domains (id, org_id, domain, status, verified_at, verification_host, verification_value, verification_expires_at,
      identity_enabled, mail_enabled, aliases_enabled, is_primary)
      values ('b7500000-0000-4000-8000-000000000031', ${orgId}, ${firstDomain}, 'verified', now(), 'fixture', 'fixture', now() + interval '1 day', true, true, true, true),
      ('b7500000-0000-4000-8000-000000000032', ${orgId}, ${secondDomain}, 'verified', now(), 'fixture', 'fixture', now() + interval '1 day', true, true, true, false)`;
    await admin`insert into admin_domains (org_id, domain, status, verified_at, verification_host, verification_value, verification_expires_at,
      identity_enabled, mail_enabled, aliases_enabled, identity_mode, alias_target_domain_id)
      values (${orgId}, ${aliasDomain}, 'verified', now(), 'fixture', 'fixture', now() + interval '1 day', true, true, true, 'alias', 'b7500000-0000-4000-8000-000000000031')`;
    await admin`insert into actors (id, org_id, type, email, display_name, scopes) values
      (${memberId}, ${orgId}, 'user', ${firstEmail}, 'Member', '{mail.read,mail.write}'),
      (${otherId}, ${orgId}, 'user', ${`admin@${firstDomain}`}, 'Admin', '{admin.users,mail.read}'),
      (${foreignId}, ${foreignOrgId}, 'user', ${firstEmail}, 'Same global identity elsewhere', '{}'),
      (${agentId}, ${orgId}, 'agent', ${`machine@${firstDomain}`}, 'Agent', '{}'),
      (${readonlyId}, ${orgId}, 'user', ${`readonly@${firstDomain}`}, 'Read only admin', '{admin.console.read}'),
      (${roleAdminId}, ${orgId}, 'user', ${`role@${firstDomain}`}, 'Role admin', '{}'),
      (${deniedId}, ${orgId}, 'user', ${`denied@${firstDomain}`}, 'Denied admin', '{admin.*}')`;
    await admin`insert into iam_roles (id, org_id, role_key, display_name, kind) values
      ('b7500000-0000-4000-8000-000000000051', ${orgId}, 'address_allow', 'Address administrator', 'custom'),
      ('b7500000-0000-4000-8000-000000000052', ${orgId}, 'address_deny', 'Denied address administration', 'custom')`;
    await admin`insert into iam_role_permissions (org_id, role_id, permission, effect) values
      (${orgId}, 'b7500000-0000-4000-8000-000000000051', 'admin.users', 'allow'),
      (${orgId}, 'b7500000-0000-4000-8000-000000000052', 'admin.users', 'deny')`;
    await admin`insert into iam_role_bindings (org_id, role_id, principal_type, membership_id, scope_type)
      select ${orgId}, case when actor_id = ${roleAdminId} then 'b7500000-0000-4000-8000-000000000051'::uuid else 'b7500000-0000-4000-8000-000000000052'::uuid end,
        'membership', id, 'org' from organization_memberships where actor_id in (${roleAdminId}, ${deniedId})`;
    await admin`insert into "user" (id, name, email, "emailVerified") values ('address-login-user', 'Login name', ${firstEmail}, true)`;
    await admin`select helix_activate_identity_membership('better-auth', 'address-login-user', ${orgId}, ${firstEmail}, 'Login name')`;
    await admin`insert into admin_groups (org_id, name, email, kind, created_by)
      values (${orgId}, 'Address collision group', ${`team@${secondDomain}`}, 'mailing_list', ${otherId})`;
    await admin`insert into admin_domains (org_id, domain, status, verified_at, verification_host, verification_value, verification_expires_at, mail_enabled, aliases_enabled)
      values (${orgId}, ${mailOnlyDomain}, 'verified', now(), 'fixture', 'fixture', now() + interval '1 day', true, true)`;
    await admin`insert into admin_groups (org_id, name, email, kind, created_by)
      values (${orgId}, 'Mail-only group', ${`team@${mailOnlyDomain}`}, 'mailing_list', ${otherId})`;
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
    const audit = new PostgresAuditStore(sql);
    await registerCanonicalApi(app, async (api) => {
      registerUserAddressRoutes(api, {
        store: new PostgresUserAddressStore(sql),
        actorFromRequest: () => current,
        auditSink: {
          append: async (record) => {
            if (failAudit) throw new Error("audit unavailable");
            return audit.append(record);
          },
        },
      });
    });
  });
  afterAll(async () => {
    await app.close();
    await cleanupTestTenants(admin, [orgId, foreignOrgId]);
    await admin`delete from "user" where id = 'address-login-user'`;
    await sql.end();
    await admin.end();
  });

  it("lists verified selected domains and primary/automatic sending identities", async () => {
    const response = await app.inject(url());
    expect(response.statusCode).toBe(200);
    const result = response.json<UserMailAddresses>();
    expect(result.loginEmail).toBe(firstEmail);
    expect(result.eligibleDomains).toContainEqual({
      domain: secondDomain,
      primary: true,
      aliases: true,
    });
    expect(result.eligibleDomains).toContainEqual({
      domain: aliasDomain,
      primary: false,
      aliases: true,
    });
    expect(result.addresses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ address: firstEmail, isPrimary: true, sendAsEnabled: true }),
        expect.objectContaining({
          address: `member@${aliasDomain}`,
          source: "domain_alias",
          sendAsEnabled: true,
        }),
      ]),
    );
  });

  it("creates cross-domain receive-only aliases, changes send authority, and revokes both immediately", async () => {
    const address = `alternate@${secondDomain}`;
    const created = await app.inject({
      method: "POST",
      url: url(),
      payload: { address: ` ALTERNATE@${secondDomain.toUpperCase()} `, sendAsEnabled: false },
    });
    expect(created.statusCode, created.body).toBe(201);
    const alias = created
      .json<UserMailAddresses>()
      .addresses.find((entry) => entry.address === address);
    expect(alias).toMatchObject({ receiveEnabled: true, sendAsEnabled: false, source: "alias" });
    if (alias?.id == null) throw new Error("Fixture alias missing");
    const routing = new MailRoutingStore(sql);
    await withTenantPostgresContext(sql, { orgId, actorId: memberId }, async () => {
      expect(await routing.resolveInboundRecipients(address)).toEqual([
        expect.objectContaining({ actorId: memberId }),
      ]);
      expect(await routing.resolveAuthorizedSender(orgId, memberId, address)).toBeNull();
    });
    const updated = await app.inject({
      method: "PATCH",
      url: url(`/${alias.id}`),
      payload: { receiveEnabled: false, sendAsEnabled: true },
    });
    expect(updated.statusCode).toBe(200);
    await withTenantPostgresContext(sql, { orgId, actorId: memberId }, async () => {
      expect(await routing.resolveInboundRecipients(address)).toEqual([]);
      expect(await routing.resolveAuthorizedSender(orgId, memberId, address)).toBe(address);
      expect(await routing.resolveAuthorizedSender(orgId, otherId, address)).toBeNull();
    });
    await admin`update admin_domains set mail_enabled = false where org_id = ${orgId} and domain = ${secondDomain}`;
    try {
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: url(`/${alias.id}`),
            payload: { receiveEnabled: true },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await admin`update admin_domains set mail_enabled = true where org_id = ${orgId} and domain = ${secondDomain}`;
    }
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: url(`/${alias.id}`),
          payload: { receiveEnabled: false, sendAsEnabled: false },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: url(`/${alias.id}`, otherId),
          payload: { receiveEnabled: true },
        })
      ).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: "DELETE", url: url(`/${alias.id}`) })).statusCode).toBe(200);
    await withTenantPostgresContext(sql, { orgId, actorId: memberId }, async () => {
      expect(await routing.resolveAuthorizedSender(orgId, memberId, address)).toBeNull();
    });
  });

  it("atomically promotes an owned alias, retains the former primary, and leaves global login and other tenants intact", async () => {
    const address = `promoted@${secondDomain}`;
    expect(
      (await app.inject({ method: "POST", url: url(), payload: { address } })).statusCode,
    ).toBe(201);
    const response = await put(address);
    expect(response.statusCode).toBe(200);
    expect(response.json<UserMailAddresses>()).toMatchObject({
      primaryEmail: address,
      loginEmail: firstEmail,
      addresses: expect.arrayContaining([
        expect.objectContaining({ address, source: "primary", isPrimary: true }),
        expect.objectContaining({
          address: firstEmail,
          source: "alias",
          receiveEnabled: true,
          sendAsEnabled: true,
        }),
      ]),
    });
    expect((await admin`select email from "user" where id = 'address-login-user'`)[0]?.email).toBe(
      firstEmail,
    );
    expect((await admin`select email from actors where id = ${foreignId}`)[0]?.email).toBe(
      firstEmail,
    );
    const resolved = await new PostgresBetterAuthActorStore(sql).resolveVerifiedUser({
      authUserId: "address-login-user",
      orgId,
      email: firstEmail,
      displayName: "Login name",
    });
    expect(resolved).toMatchObject({ id: memberId, email: address });
    expect((await put(address)).statusCode).toBe(200);
    current = { ...current, id: memberId, scopes: ["mail.read"] };
    try {
      expect(
        (await app.inject("/v1/api/mail/addresses")).json<UserMailAddresses>().primaryEmail,
      ).toBe(address);
    } finally {
      current = { ...current, id: otherId, scopes: ["admin.users", "mail.read"] };
    }
  });

  it("enforces native address-only admin roles, read-only access and deny precedence without mailbox access", async () => {
    await withTenantPostgresContext(sql, { orgId, actorId: roleAdminId }, async () => {
      expect(
        (await sql`select helix_user_address_admin_access(${orgId}, true) as allowed`)[0]?.allowed,
      ).toBe(true);
      expect(
        (await sql`select helix_can_access_mailbox(${orgId}, ${memberId}) as allowed`)[0]?.allowed,
      ).toBe(false);
      expect(
        (await sql`select helix_user_address_admin_access(${foreignOrgId}, true) as allowed`)[0]
          ?.allowed,
      ).toBe(false);
      expect(
        (await sql`select id from mail_aliases where org_id = ${orgId} and actor_id = ${memberId}`)
          .length,
      ).toBeGreaterThan(0);
      await sql`insert into mail_aliases (org_id, actor_id, email) values (${orgId}, ${memberId}, ${`role-created@${secondDomain}`})`;
    });
    for (const principalId of [readonlyId, deniedId]) {
      await withTenantPostgresContext(sql, { orgId, actorId: principalId }, async () => {
        expect(
          (await sql`select helix_user_address_admin_access(${orgId}, true) as allowed`)[0]
            ?.allowed,
        ).toBe(false);
        const rows =
          await sql`select id from mail_aliases where org_id = ${orgId} and actor_id = ${memberId}`;
        expect(rows.length > 0).toBe(principalId === readonlyId);
        expect(
          (
            await sql`update mail_aliases set send_as_enabled = false where org_id = ${orgId} and actor_id = ${memberId} returning id`
          ).length,
        ).toBe(0);
      });
      await expect(
        withTenantPostgresContext(sql, { orgId, actorId: principalId }, async () => {
          await sql`insert into mail_aliases (org_id, actor_id, email) values (${orgId}, ${memberId}, ${`denied-create@${secondDomain}`})`;
        }),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("serializes competing address claims and keeps explicit aliases exact rather than granting unrelated domain aliases", async () => {
    const address = `race@${secondDomain}`;
    const results = await Promise.all(
      [memberId, otherId].map((id) =>
        app.inject({ method: "POST", url: url("", id), payload: { address } }),
      ),
    );
    expect(
      results.map((response) => response.statusCode).sort(),
      results.map((response) => response.body).join("\n"),
    ).toEqual([201, 409]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: url(),
          payload: { address: `sales@${firstDomain}` },
        })
      ).statusCode,
    ).toBe(201);
    const result = (await app.inject(url())).json<UserMailAddresses>();
    expect(result.addresses.some((entry) => entry.address === `sales@${aliasDomain}`)).toBe(false);
    expect(new Set(result.addresses.map((entry) => entry.address)).size).toBe(
      result.addresses.length,
    );
    await withTenantPostgresContext(sql, { orgId, actorId: memberId }, async () => {
      expect(
        await new MailRoutingStore(sql).resolveAuthorizedSender(
          orgId,
          memberId,
          `sales@${aliasDomain}`,
        ),
      ).toBeNull();
    });
  });

  it.each([`team@${mailOnlyDomain}`, `machine@${firstDomain}`])(
    "rejects directory collision with %s",
    async (address) => {
      const response = await app.inject({ method: "POST", url: url(), payload: { address } });
      expect(response.statusCode, response.body).toBe(409);
    },
  );

  it("guards reverse machine/group claims even when the database principal cannot read another user's aliases", async () => {
    const address = `hidden@${mailOnlyDomain}`;
    expect(
      (await app.inject({ method: "POST", url: url(), payload: { address } })).statusCode,
    ).toBe(201);
    await withTenantPostgresContext(sql, { orgId, actorId: deniedId }, async () => {
      expect(
        (await sql`select helix_can_access_mailbox(${orgId}, ${memberId}) as allowed`)[0]?.allowed,
      ).toBe(false);
    });
    await withTenantPostgresContext(sql, { orgId, actorId: deniedId }, async () => {
      expect(
        (await sql`select id from mail_aliases where org_id = ${orgId} and email = ${address}`)
          .length,
      ).toBe(0);
    });
    for (const type of ["agent", "service_account"] as const) {
      await expect(
        withTenantPostgresContext(sql, { orgId, actorId: deniedId }, async () => {
          await sql`insert into actors (org_id, type, email, display_name) values (${orgId}, ${type}, ${address}, 'Collision')`;
        }),
      ).rejects.toMatchObject({ code: "23505" });
    }
    await expect(
      withTenantPostgresContext(sql, { orgId, actorId: deniedId }, async () => {
        await sql`insert into admin_groups (org_id, name, email, kind, created_by) values (${orgId}, 'Collision', ${address}, 'mailing_list', ${deniedId})`;
      }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("serializes cross-kind machine and alias claims in the same mail-only namespace", async () => {
    const address = `cross-kind-race@${mailOnlyDomain}`;
    const outcomes = await Promise.all([
      app
        .inject({ method: "POST", url: url(), payload: { address } })
        .then((response) => response.statusCode),
      withTenantPostgresContext(sql, { orgId, actorId: deniedId }, async () => {
        await sql`insert into actors (org_id, type, email, display_name) values (${orgId}, 'service_account', ${address}, 'Concurrent claim')`;
      })
        .then(() => 201)
        .catch((error: unknown) => {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "23505"
          )
            return 409;
          throw error;
        }),
    ]);
    expect(outcomes.sort()).toEqual([201, 409]);
  });

  it("rejects namespace collisions and ineligible primary domains without losing the current primary", async () => {
    expect((await put(`team@${secondDomain}`)).statusCode).toBe(409);
    expect((await put(`admin@${firstDomain}`)).statusCode).toBe(409);
    expect((await put(`promoted@${aliasDomain}`)).statusCode).toBe(400);
    expect((await put("member@unverified.example.test")).statusCode).toBe(400);
    expect((await app.inject(url())).json<UserMailAddresses>().primaryEmail).toBe(
      `promoted@${secondDomain}`,
    );
    const collision = await app.inject({
      method: "POST",
      url: url(),
      payload: { address: `team@${secondDomain}` },
    });
    expect(collision.statusCode).toBe(409);
  });

  it("rejects foreign, inactive and machine targets, and rolls back a successful mutation when audit fails", async () => {
    for (const id of [foreignId, agentId])
      expect(
        (
          await app.inject({
            method: "POST",
            url: url("", id),
            payload: { address: `not-created@${secondDomain}` },
          })
        ).statusCode,
      ).toBe(404);
    await admin`update actors set disabled_at = now() where id = ${memberId}`;
    expect((await app.inject(url())).statusCode).toBe(404);
    await admin`update actors set disabled_at = null where id = ${memberId}`;
    failAudit = true;
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: url(),
            payload: { address: `audit-rollback@${secondDomain}` },
          })
        ).statusCode,
      ).toBe(500);
    } finally {
      failAudit = false;
    }
    expect(
      (
        await admin`select id from mail_aliases where org_id = ${orgId} and email = ${`audit-rollback@${secondDomain}`}`
      ).length,
    ).toBe(0);
    const events = await admin`select event_type from mail_address_events where org_id = ${orgId}`;
    expect(events.length).toBeGreaterThan(0);
  });
});
