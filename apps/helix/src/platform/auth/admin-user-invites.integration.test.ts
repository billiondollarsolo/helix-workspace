import { randomUUID } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresAdminUserInviteStore } from "./admin-user-invites.js";
import { PostgresAdminUsersStore } from "./admin-users.js";
import { WORKSPACE_ADMIN_SCOPES, WORKSPACE_MEMBER_SCOPES } from "./member-scopes.js";

const live = !skipUnlessLiveDatabase("admin user invitations");
describe.skipIf(!live)("admin user invitations", () => {
  const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 1 });
  const sql = tenantAwarePostgresSql(
    postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 4 }),
  );
  const invites = new PostgresAdminUserInviteStore(sql);
  const users = new PostgresAdminUsersStore(sql);
  const orgId = randomUUID();
  const foreignOrgId = randomUUID();
  const adminId = randomUUID();
  const foreignAdminId = randomUUID();
  // One domain per run, so cleanup can find the global identity rows it made.
  const domain = `${randomUUID()}.invites.test`;
  const operator: Actor = { id: adminId, orgId, type: "user", scopes: ["admin.*"] };
  const foreignOperator: Actor = {
    id: foreignAdminId,
    orgId: foreignOrgId,
    type: "user",
    scopes: ["admin.*"],
  };
  let passwordHash = "";

  const listed = async (actorId: string) =>
    withTenantPostgresContext(sql, { orgId, actorId: adminId }, async () =>
      (await users.listUsers({ orgId, includeDisabled: true, limit: 100 })).find(
        (user) => user.id === actorId,
      ),
    );
  const auditVerbs = async (actorId: string) =>
    (
      await admin<{ verb: string }[]>`
        select verb from activity
        where org_id = ${orgId} and object_id = ${actorId} and verb like 'identity.user.%'
        order by sequence
      `
    ).map((row) => row.verb);

  beforeAll(async () => {
    passwordHash = await hashPassword("correct horse battery");
    await admin`
      insert into orgs (id, slug, display_name, status) values
        (${orgId}, ${orgId}, 'Invites Co', 'active'),
        (${foreignOrgId}, ${foreignOrgId}, 'Foreign Co', 'active')
    `;
    await admin`
      insert into actors (id, org_id, type, email, display_name, scopes) values
        (${adminId}, ${orgId}, 'user', ${`admin@${domain}`}, 'Admin', ${["admin.*"]}),
        (${foreignAdminId}, ${foreignOrgId}, 'user', ${`foreign-admin@${domain}`},
          'Foreign admin', ${["admin.*"]})
    `;
  });

  afterAll(async () => {
    await admin`delete from "user" where lower(email) like ${`%@${domain}`}`;
    await cleanupTestTenants(admin, [orgId, foreignOrgId]);
    await admin`delete from identity_subjects where canonical_email like ${`%@${domain}`}`;
    await Promise.all([admin.end(), sql.end()]);
  });

  it("creates a pending person listed as invited and refuses a duplicate invitation", async () => {
    const email = `Ada@${domain}`;
    const issued = await invites.invite(operator, {
      email,
      displayName: "Ada Lovelace",
      role: "member",
    });
    expect(issued).toMatchObject({
      email: email.toLowerCase(),
      displayName: "Ada Lovelace",
      token: expect.any(String),
    });
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await expect(listed(issued.actorId)).resolves.toMatchObject({
      email: email.toLowerCase(),
      displayName: "Ada Lovelace",
      status: "invited",
      scopes: [...WORKSPACE_MEMBER_SCOPES],
    });
    const [stored] = await admin<{ token_hash: string; metadata: Record<string, unknown> }[]>`
      select token_hash, metadata from signup_onboarding_invites
      where org_id = ${orgId} and email = ${email.toLowerCase()}
    `;
    // Only the hash is stored.
    expect(stored?.token_hash).not.toBe(issued.token);
    expect(stored?.metadata).toEqual({ source: "admin", actorId: issued.actorId });

    await expect(
      invites.invite(operator, { email, displayName: "Again", role: "member" }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("pending") });
    await expect(invites.inspect(orgId, issued.token)).resolves.toEqual({
      email: email.toLowerCase(),
      displayName: "Ada Lovelace",
      expiresAt: issued.expiresAt,
    });
  });

  it("accepts with a password: links a sign-in, activates the person and consumes the link", async () => {
    const email = `grace@${domain}`;
    const issued = await invites.invite(operator, {
      email,
      displayName: "Grace Hopper",
      role: "admin",
    });
    await expect(listed(issued.actorId)).resolves.toMatchObject({
      status: "invited",
      scopes: [...WORKSPACE_MEMBER_SCOPES, ...WORKSPACE_ADMIN_SCOPES],
    });

    await expect(invites.accept(orgId, { token: issued.token, passwordHash })).resolves.toEqual({
      status: "accepted",
      actorId: issued.actorId,
      email,
    });

    await expect(listed(issued.actorId)).resolves.toMatchObject({ status: "active" });
    const [link] = await admin<{ provider: string; provider_subject: string; status: string }[]>`
      select provider.provider, provider.provider_subject, membership.status
      from organization_memberships membership
      join identity_provider_subjects provider on provider.subject_id = membership.subject_id
      where membership.org_id = ${orgId} and membership.actor_id = ${issued.actorId}
    `;
    expect(link).toEqual({
      provider: "better-auth",
      provider_subject: `signup-${issued.actorId}`,
      status: "active",
    });
    const [credential] = await admin<{ password: string; email: string }[]>`
      select account.password, "user".email
      from account join "user" on "user".id = account."userId"
      where account."userId" = ${`signup-${issued.actorId}`}
        and account."providerId" = 'credential'
    `;
    expect(credential).toEqual({ password: passwordHash, email });
    const [invite] = await admin<{ accepted_by_actor_id: string | null }[]>`
      select accepted_by_actor_id from signup_onboarding_invites
      where org_id = ${orgId} and email = ${email}
    `;
    expect(invite?.accepted_by_actor_id).toBe(issued.actorId);

    // The link is single use.
    await expect(invites.accept(orgId, { token: issued.token, passwordHash })).resolves.toEqual({
      status: "invalid",
    });
    await expect(invites.inspect(orgId, issued.token)).resolves.toBeNull();
    // A joined person can't be invited, resent or withdrawn.
    await expect(
      invites.invite(operator, { email, displayName: "Grace", role: "member" }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining("already") });
    await expect(invites.resend(operator, issued.actorId)).resolves.toBeNull();
    await expect(invites.revoke(operator, issued.actorId)).resolves.toBe(false);

    expect(await auditVerbs(issued.actorId)).toEqual([
      "identity.user.invited",
      "identity.user.invite_accepted",
    ]);
  });

  it("resends a fresh link and stops the previous one working", async () => {
    const issued = await invites.invite(operator, {
      email: `linus@${domain}`,
      displayName: "Linus",
      role: "member",
    });
    const resent = await invites.resend(operator, issued.actorId);
    expect(resent).toMatchObject({
      actorId: issued.actorId,
      email: `linus@${domain}`,
      displayName: "Linus",
    });
    expect(resent?.token).not.toBe(issued.token);

    await expect(invites.inspect(orgId, issued.token)).resolves.toBeNull();
    await expect(invites.accept(orgId, { token: issued.token, passwordHash })).resolves.toEqual({
      status: "invalid",
    });
    await expect(invites.inspect(orgId, resent?.token ?? "")).resolves.toMatchObject({
      email: `linus@${domain}`,
    });
    await expect(invites.resend(operator, randomUUID())).resolves.toBeNull();
    expect(await auditVerbs(issued.actorId)).toEqual([
      "identity.user.invited",
      "identity.user.invite_resent",
    ]);
  });

  it("withdraws an invitation and reuses the person when invited again", async () => {
    const email = `margaret@${domain}`;
    const issued = await invites.invite(operator, {
      email,
      displayName: "Margaret",
      role: "member",
    });
    await expect(invites.revoke(operator, issued.actorId)).resolves.toBe(true);
    await expect(invites.inspect(orgId, issued.token)).resolves.toBeNull();
    await expect(listed(issued.actorId)).resolves.toMatchObject({ status: "removed" });
    await expect(invites.revoke(operator, issued.actorId)).resolves.toBe(false);
    await expect(invites.resend(operator, issued.actorId)).resolves.toBeNull();

    const again = await invites.invite(operator, {
      email,
      displayName: "Margaret Hamilton",
      role: "admin",
    });
    expect(again.actorId).toBe(issued.actorId);
    await expect(listed(issued.actorId)).resolves.toMatchObject({
      status: "invited",
      displayName: "Margaret Hamilton",
      scopes: [...WORKSPACE_MEMBER_SCOPES, ...WORKSPACE_ADMIN_SCOPES],
    });
    await expect(invites.inspect(orgId, issued.token)).resolves.toBeNull();
    await expect(invites.inspect(orgId, again.token)).resolves.toMatchObject({
      displayName: "Margaret Hamilton",
    });
    expect(await auditVerbs(issued.actorId)).toEqual([
      "identity.user.invited",
      "identity.user.invite_revoked",
      "identity.user.invited",
    ]);
  });

  it("asks a person who already has a sign-in to use it instead", async () => {
    const email = `existing@${domain}`;
    const issued = await invites.invite(operator, {
      email,
      displayName: "Existing",
      role: "member",
    });
    const authUserId = randomUUID();
    await admin`
      insert into "user" (id, name, email, "emailVerified") values
        (${authUserId}, 'Existing', ${email}, true)
    `;
    await expect(invites.accept(orgId, { token: issued.token, passwordHash })).resolves.toEqual({
      status: "existing_sign_in",
      email,
    });
    // Nothing changed: the link still works once they sign in another way.
    await expect(listed(issued.actorId)).resolves.toMatchObject({ status: "invited" });
    await expect(invites.inspect(orgId, issued.token)).resolves.not.toBeNull();
    const accounts = await admin`select 1 from account where "userId" = ${authUserId}`;
    expect(accounts).toHaveLength(0);
  });

  it("resolves links only inside the workspace that issued them", async () => {
    const issued = await invites.invite(operator, {
      email: `isolated@${domain}`,
      displayName: "Isolated",
      role: "member",
    });
    await expect(invites.inspect(foreignOrgId, issued.token)).resolves.toBeNull();
    await expect(
      invites.accept(foreignOrgId, { token: issued.token, passwordHash }),
    ).resolves.toEqual({ status: "invalid" });
    // A foreign administrator can't resend or withdraw it either.
    await expect(invites.resend(foreignOperator, issued.actorId)).resolves.toBeNull();
    await expect(invites.revoke(foreignOperator, issued.actorId)).resolves.toBe(false);

    await expect(listed(issued.actorId)).resolves.toMatchObject({ status: "invited" });
    await expect(invites.inspect(orgId, issued.token)).resolves.not.toBeNull();
    const foreignAudit = await admin`
      select 1 from activity where org_id = ${foreignOrgId} and verb like 'identity.user.%'
    `;
    expect(foreignAudit).toHaveLength(0);
    expect(await auditVerbs(issued.actorId)).toEqual(["identity.user.invited"]);
  });

  it("leaves people provisioned by the identity provider to sign in through it", async () => {
    const email = `scim-${randomUUID()}@${domain}`;
    const [scim] = await admin<{ id: string }[]>`
      insert into actors (org_id, type, email, display_name, scim_external_id)
      values (${orgId}, 'user', ${email}, 'Provisioned', ${randomUUID()})
      returning id
    `;
    await expect(
      invites.invite(operator, { email, displayName: "Provisioned", role: "member" }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(invites.resend(operator, scim?.id ?? "")).resolves.toBeNull();
    await expect(invites.revoke(operator, scim?.id ?? "")).resolves.toBe(false);
  });

  it("records who performed each invitation action", async () => {
    const audit = await admin<{ verb: string; actor_id: string; object_type: string }[]>`
      select distinct verb, actor_id, object_type from activity
      where org_id = ${orgId} and verb like 'identity.user.invite%'
    `;
    const performers = new Map(audit.map((row) => [row.verb, row]));
    expect(performers.get("identity.user.invited")).toMatchObject({
      actor_id: adminId,
      object_type: "actor",
    });
    expect(performers.get("identity.user.invite_resent")?.actor_id).toBe(adminId);
    expect(performers.get("identity.user.invite_revoked")?.actor_id).toBe(adminId);
    // The person who joined is the one who accepted.
    expect(performers.get("identity.user.invite_accepted")?.actor_id).not.toBe(adminId);
  });
});
