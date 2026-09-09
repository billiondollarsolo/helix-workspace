import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL === undefined ? null : postgres(DATABASE_URL, { max: 4 });

describe("0121 configured session policy migration", () => {
  it("centralizes policy enforcement and authority-change revocation", async () => {
    const migration = await readFile(
      new URL("./0121_configured_session_policy.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("helix_authorize_tenant_session");
    expect(migration).toContain("create table auth_session_tenant_access");
    expect(migration).toContain("references actors(org_id, id)");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("absoluteLifetimeDays");
    expect(migration).toContain("inactivityTimeoutDays");
    expect(migration).toContain("maxConcurrentSessions");
    expect(migration).toContain("reauthIntervalMinutes");
    expect(migration).toContain("better_auth_account_password_revoke_sessions");
    expect(migration).toContain("organization_memberships_authority_revoke_sessions");
    expect(migration).toContain("iam_role_bindings_authority_revoke_sessions");
  });
});

describe.skipIf(sql === null)("0121 live configured session enforcement", () => {
  const database = sql as postgres.Sql;
  const orgA = "a1300000-0000-4000-8000-000000000001";
  const orgB = "a1300000-0000-4000-8000-000000000002";
  const actorA = "a1300000-0000-4000-8000-000000000011";
  const actorB = "a1300000-0000-4000-8000-000000000012";
  const actorAInOrgB = "a1300000-0000-4000-8000-000000000013";
  const userA = "iam13-user-a";
  const userB = "iam13-user-b";
  let subjectA = "";

  beforeAll(async () => {
    await database`delete from "user" where id in (${userA}, ${userB})`;
    await database`delete from actors where id in (${actorA}, ${actorB}, ${actorAInOrgB})`;
    await database`delete from orgs where id in (${orgA}, ${orgB})`;
    await database`delete from identity_subjects where canonical_email in ('iam13-a@example.test', 'iam13-b@example.test')`;
    await database`
      insert into orgs (id, slug, display_name, status, tier, region)
      values
        (${orgA}, 'iam13-a', 'IAM 13 A', 'active', 'business', 'test'),
        (${orgB}, 'iam13-b', 'IAM 13 B', 'active', 'business', 'test')
    `;
    await database`
      insert into actors (id, org_id, type, email, display_name)
      values
        (${actorA}, ${orgA}, 'user', 'iam13-a@example.test', 'IAM 13 A'),
        (${actorB}, ${orgB}, 'user', 'iam13-b@example.test', 'IAM 13 B'),
        (${actorAInOrgB}, ${orgB}, 'user', 'iam13-a@example.test', 'IAM 13 A in B')
    `;
    const subjects = await database<{ subject_id: string }[]>`
      select subject_id from organization_memberships where actor_id = ${actorA}
    `;
    subjectA = subjects[0]?.subject_id ?? "";
    await database`
      insert into "user" (id, name, email, "emailVerified") values
        (${userA}, 'IAM 13 A', 'iam13-a@example.test', true),
        (${userB}, 'IAM 13 B', 'iam13-b@example.test', true)
    `;
    await database`
      insert into identity_provider_subjects (provider, provider_subject, subject_id)
      values
        ('better-auth', ${userA}, ${subjectA}),
        ('better-auth', ${userB}, (
          select subject_id from organization_memberships where actor_id = ${actorB}
        ))
    `;
  });

  beforeEach(async () => {
    await database`delete from "session" where "userId" in (${userA}, ${userB})`;
    await database`delete from admin_security_policies where org_id in (${orgA}, ${orgB})`;
    await database`
      update organization_memberships
      set status = 'active', roles = '{}', suspended_at = null, ended_at = null
      where actor_id in (${actorA}, ${actorB}, ${actorAInOrgB})
    `;
    await database`update actors set disabled_at = null, scopes = '{}' where id in (${actorA}, ${actorB}, ${actorAInOrgB})`;
    await database`update identity_subjects set status = 'active' where id = ${subjectA}`;
    await database`update orgs set status = 'active', soft_deleted_at = null where id in (${orgA}, ${orgB})`;
  });

  afterAll(async () => {
    await database`delete from "user" where id in (${userA}, ${userB})`;
    await database`delete from actors where id in (${actorA}, ${actorB}, ${actorAInOrgB})`;
    await database`delete from orgs where id in (${orgA}, ${orgB})`;
    await database`delete from identity_subjects where canonical_email in ('iam13-a@example.test', 'iam13-b@example.test')`;
    await database.end();
  });

  it("rejects idle and absolute expiry and applies a tightened policy on the next check", async () => {
    await policy({ absolute: 30, idle: 20, max: 10, reauth: false });
    await session("policy-change", "2026-01-01T00:00:00Z", "2026-01-09T00:00:00Z");
    await expect(authorize("policy-change", false, "2026-01-10T00:00:00Z")).resolves.toBe(true);

    await policy({ absolute: 5, idle: 20, max: 10, reauth: false });
    await expect(authorize("policy-change", false, "2026-01-10T00:01:00Z")).resolves.toBe(false);

    await policy({ absolute: 30, idle: 2, max: 10, reauth: false });
    await session("idle", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z");
    await expect(authorize("idle", false, "2026-01-10T00:00:00Z")).resolves.toBe(false);

    await policy({ absolute: 2, idle: 20, max: 10, reauth: false });
    await session("absolute", "2026-01-01T00:00:00Z", "2026-01-09T00:00:00Z");
    await expect(authorize("absolute", false, "2026-01-10T00:00:00Z")).resolves.toBe(false);
  });

  it("requires recent assurance only for admin actions", async () => {
    await policy({ absolute: 30, idle: 20, max: 10, reauth: true, reauthMinutes: 10 });
    await session("reauth", "2026-01-09T00:00:00Z", "2026-01-09T00:00:00Z");
    await expect(authorize("reauth", false, "2026-01-10T00:00:00Z")).resolves.toBe(true);
    await expect(authorize("reauth", true, "2026-01-10T00:00:00Z")).resolves.toBe(false);
    await database`
      update "session" set mfa_verified_at = '2026-01-09T23:55:00Z', mfa_audience = 'helix'
      where token = 'reauth'
    `;
    await expect(authorize("reauth", true, "2026-01-10T00:00:00Z")).resolves.toBe(true);
  });

  it("serializes and enforces the concurrent session cap", async () => {
    await policy({ absolute: 30, idle: 20, max: 2, reauth: false });
    await session("oldest", "2026-01-07T00:00:00Z", "2026-01-07T00:00:00Z");
    await session("middle", "2026-01-08T00:00:00Z", "2026-01-08T00:00:00Z");
    await session("newest", "2026-01-09T00:00:00Z", "2026-01-09T00:00:00Z");
    await expect(
      authorize("oldest", false, "2026-01-09T09:00:00Z", orgB, actorAInOrgB),
    ).resolves.toBe(true);
    await Promise.all([
      authorize("oldest", false, "2026-01-09T10:00:00Z"),
      authorize("middle", false, "2026-01-09T11:00:00Z"),
      authorize("newest", false, "2026-01-09T12:00:00Z"),
    ]);
    const rows = await database<{ token: string }[]>`
      select s.token
      from auth_session_tenant_access access
      join "session" s on s.id = access.session_id
      where access.org_id = ${orgA} and access.actor_id = ${actorA}
        and access.revoked_at is null
      order by s.token
    `;
    expect(rows.map((row) => row.token)).toEqual(["middle", "newest"]);
    const otherTenant = await database<{ active: boolean }[]>`
      select revoked_at is null as active
      from auth_session_tenant_access
      where session_id = 'iam13-oldest' and org_id = ${orgB}
    `;
    expect(otherTenant).toEqual([{ active: true }]);
    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgA}, true)`;
        await tx`select * from auth_session_tenant_access where org_id = ${orgB}`;
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("fails closed for a cross-tenant actor and revokes on password, role, and status changes", async () => {
    await policy({ absolute: 30, idle: 20, max: 10, reauth: false });
    await session("cross-tenant", "2026-01-09T00:00:00Z", "2026-01-09T00:00:00Z");
    await expect(
      authorize("cross-tenant", false, "2026-01-10T00:00:00Z", orgB, actorB),
    ).resolves.toBe(false);

    await database`
      insert into account (id, "userId", "accountId", "providerId", password)
      values ('iam13-account', ${userA}, ${userA}, 'credential', 'old')
      on conflict (id) do update set password = excluded.password
    `;
    await database`update account set password = 'new' where id = 'iam13-account'`;
    await expect(sessionCount()).resolves.toBe(0);

    await session("role-change", "2026-01-09T00:00:00Z", "2026-01-09T00:00:00Z");
    await database`update organization_memberships set roles = array['admin.users'] where actor_id = ${actorA}`;
    await expect(authorize("role-change", false, "2026-01-10T00:00:00Z")).resolves.toBe(false);
    await expect(revocationReason("role-change")).resolves.toBe("membership_changed");

    await session("suspension", "2026-01-09T00:00:00Z", "2026-01-09T00:00:00Z");
    await database`
      update organization_memberships set status = 'suspended', suspended_at = now()
      where actor_id = ${actorA}
    `;
    await expect(authorize("suspension", false, "2026-01-10T00:00:00Z")).resolves.toBe(false);
    await expect(revocationReason("suspension")).resolves.toBe("membership_changed");
  });

  async function policy(input: {
    absolute: number;
    idle: number;
    max: number;
    reauth: boolean;
    reauthMinutes?: number;
  }): Promise<void> {
    await database`
      insert into admin_security_policies (org_id, policy_type, enabled, enforcement, settings)
      values (${orgA}, 'session', true, 'required', ${database.json({
        absoluteLifetimeDays: input.absolute,
        inactivityTimeoutDays: input.idle,
        maxConcurrentSessions: input.max,
        reauthForAdminActions: input.reauth,
        reauthIntervalMinutes: input.reauthMinutes ?? 10,
      })})
      on conflict (org_id, policy_type) do update set settings = excluded.settings
    `;
  }

  async function session(token: string, createdAt: string, updatedAt: string): Promise<void> {
    await database`
      insert into "session" (
        id, "userId", token, "expiresAt", "ipAddress", "userAgent", "createdAt", "updatedAt"
      ) values (
        ${`iam13-${token}`}, ${userA}, ${token}, '2027-01-01T00:00:00Z',
        '192.0.2.13', 'IAM-13 test device', ${createdAt}, ${updatedAt}
      )
    `;
  }

  async function authorize(
    token: string,
    adminAction: boolean,
    now: string,
    orgId = orgA,
    actorId = actorA,
  ): Promise<boolean> {
    const rows = await database.begin(async (tx) => {
      await tx.unsafe("set local role helix_app");
      return tx<{ authorized: boolean }[]>`
        select helix_authorize_tenant_session(
          ${token}, ${userA}, ${orgId}, ${actorId}, ${adminAction}, ${now}
        ) as authorized
      `;
    });
    return rows[0]?.authorized === true;
  }

  async function sessionCount(): Promise<number> {
    const rows = await database<{ count: number }[]>`
      select count(*)::integer as count from "session" where "userId" = ${userA}
    `;
    return rows[0]?.count ?? -1;
  }

  async function revocationReason(token: string): Promise<string | null> {
    const rows = await database<{ revocation_reason: string | null }[]>`
      select access.revocation_reason
      from auth_session_tenant_access access
      join "session" s on s.id = access.session_id
      where s.token = ${token} and access.org_id = ${orgA}
    `;
    return rows[0]?.revocation_reason ?? null;
  }
});
