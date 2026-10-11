import { randomUUID } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { PostgresDriveS3AccessKeyStore } from "../drive/s3/access-keys.js";
import { TenantEnvelopeCipher } from "../secrets/envelope.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresAdminUsersStore } from "./admin-users.js";
import { AppPasswordManager, PostgresAppPasswordStore } from "./app-passwords.js";

const live = !skipUnlessLiveDatabase("admin user suspension");
describe.skipIf(!live)("admin user suspension and last sign-in", () => {
  const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 1 });
  const sql = tenantAwarePostgresSql(
    postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 4 }),
  );
  const users = new PostgresAdminUsersStore(sql);
  const appPasswords = new PostgresAppPasswordStore(sql);
  const cipher = new TenantEnvelopeCipher("admin-user-suspension-master-secret-32+");
  const s3Keys = new PostgresDriveS3AccessKeyStore(sql, cipher);
  // Protocol sign-ins look credentials up before any tenant is known, on the
  // runtime's credential connection.
  const credentialLogins = new PostgresAppPasswordStore(admin);
  const s3Logins = new PostgresDriveS3AccessKeyStore(admin, cipher);
  const orgId = randomUUID();
  const foreignOrgId = randomUUID();
  const adminId = randomUUID();
  const personId = randomUUID();
  const memberId = randomUUID();
  const foreignAdminId = randomUUID();
  const agentId = randomUUID();
  const authUserId = randomUUID();
  const sessionToken = randomUUID();
  const personEmail = `person-${personId}@suspension.test`;
  const operator: Actor = { id: adminId, orgId, type: "user", scopes: ["admin.users"] };
  let appPassword = "";
  let s3AccessKeyId = "";

  const authorizeSession = async (token: string) => {
    const [row] = await sql<{ authorized: boolean }[]>`
      select helix_authorize_tenant_session(${token}, ${authUserId}, ${orgId}, ${personId}, false)
        as authorized
    `;
    return row?.authorized === true;
  };
  const listed = async (actorId: string) =>
    withTenantPostgresContext(sql, { orgId, actorId: adminId }, async () =>
      (await users.listUsers({ orgId, includeDisabled: true, limit: 50 })).find(
        (user) => user.id === actorId,
      ),
    );
  const appPasswordWorks = async () =>
    (await credentialLogins.authenticateAppPassword({
      username: personEmail,
      password: appPassword,
      requiredScope: "caldav",
    })) !== null;

  beforeAll(async () => {
    await admin`
      insert into orgs (id, slug, display_name, status) values
        (${orgId}, ${orgId}, 'Suspension', 'active'),
        (${foreignOrgId}, ${foreignOrgId}, 'Foreign', 'active')
    `;
    await admin`
      insert into actors (id, org_id, type, email, display_name, scopes) values
        (${adminId}, ${orgId}, 'user', ${`admin-${adminId}@suspension.test`}, 'Admin',
          ${["admin.users"]}),
        (${personId}, ${orgId}, 'user', ${personEmail}, 'Person', ${["caldav", "drive.read"]}),
        (${memberId}, ${orgId}, 'user', ${`member-${memberId}@suspension.test`}, 'Member', ${[]}),
        (${agentId}, ${orgId}, 'agent', null, 'Directory sync', ${["admin.users"]}),
        (${foreignAdminId}, ${foreignOrgId}, 'user', ${`foreign-${foreignAdminId}@x.test`},
          'Foreign admin', ${["admin.users"]})
    `;
    await admin`
      insert into "user" (id, name, email, "emailVerified") values
        (${authUserId}, 'Person', ${personEmail}, true)
    `;
    await sql`
      select helix_activate_identity_membership(
        'better-auth', ${authUserId}, ${orgId}, ${personEmail}, 'Person'
      )
    `;
    await admin`
      insert into "session" (id, "userId", token, "expiresAt", "createdAt") values
        (${randomUUID()}, ${authUserId}, ${sessionToken}, now() + interval '1 day',
          now() - interval '5 minutes')
    `;
    await withTenantPostgresContext(sql, { orgId, actorId: personId }, async () => {
      appPassword = (
        await new AppPasswordManager(appPasswords).create({
          actorId: personId,
          orgId,
          label: "Phone",
          scopes: ["caldav"],
        })
      ).password;
      s3AccessKeyId = (
        await s3Keys.create({ orgId, actorId: personId, label: "Sync", scopes: ["drive.read"] })
      ).accessKey.accessKeyId;
    });
  });

  afterAll(async () => {
    await admin`delete from "user" where id = ${authUserId}`;
    await cleanupTestTenants(admin, [orgId, foreignOrgId]);
    await Promise.all([admin.end(), sql.end()]);
  });

  it("records the sign-in when a session is first admitted to the workspace", async () => {
    await expect(listed(personId)).resolves.toMatchObject({
      status: "active",
      lastSignInAt: null,
    });
    expect(await authorizeSession(sessionToken)).toBe(true);
    const [session] = await admin<{ created_at: Date }[]>`
      select "createdAt" as created_at from "session" where token = ${sessionToken}
    `;
    const first = await listed(personId);
    expect(first?.lastSignInAt).toBe(session?.created_at.toISOString());
    // Later requests on the same session are not new sign-ins.
    expect(await authorizeSession(sessionToken)).toBe(true);
    expect((await listed(personId))?.lastSignInAt).toBe(first?.lastSignInAt);
  });

  it("suspends a person: signs them out and stops sign-in, app passwords and S3 keys", async () => {
    expect(await appPasswordWorks()).toBe(true);
    expect(await s3Logins.authenticate(s3AccessKeyId)).not.toBeNull();

    await expect(users.setSuspended(operator, personId, true)).resolves.toEqual({
      actorId: personId,
      status: "suspended",
      changed: true,
      sessionsRevoked: 1,
    });

    expect(await authorizeSession(sessionToken)).toBe(false);
    expect(await appPasswordWorks()).toBe(false);
    expect(await s3Logins.authenticate(s3AccessKeyId)).toBeNull();
    const [signIn] = await sql<{ actor_id: string | null }[]>`
      select helix_activate_identity_membership(
        'better-auth', ${authUserId}, ${orgId}, ${personEmail}, 'Person'
      ) as actor_id
    `;
    expect(signIn?.actor_id).toBeNull();
    await expect(listed(personId)).resolves.toMatchObject({ status: "suspended" });

    await expect(users.setSuspended(operator, personId, true)).resolves.toMatchObject({
      changed: false,
    });
    const audit = await admin<{ verb: string; actor_id: string }[]>`
      select verb, actor_id from activity
      where org_id = ${orgId} and object_id = ${personId} and verb like 'identity.user.%'
    `;
    expect(audit).toEqual([{ verb: "identity.user.suspended", actor_id: adminId }]);
  });

  it("restores a suspended person without reviving old sessions", async () => {
    await expect(users.setSuspended(operator, personId, false)).resolves.toEqual({
      actorId: personId,
      status: "active",
      changed: true,
    });
    expect(await appPasswordWorks()).toBe(true);
    expect(await s3Logins.authenticate(s3AccessKeyId)).not.toBeNull();
    // Suspension revoked the session in this workspace; they sign in again.
    expect(await authorizeSession(sessionToken)).toBe(false);
    await expect(listed(personId)).resolves.toMatchObject({ status: "active" });
    const audit = await admin<{ verb: string }[]>`
      select verb from activity
      where org_id = ${orgId} and object_id = ${personId} and verb = 'identity.user.restored'
    `;
    expect(audit).toHaveLength(1);
  });

  it("refuses self, last-administrator, non-administrator and cross-tenant changes", async () => {
    await expect(users.setSuspended(operator, adminId, true)).rejects.toMatchObject({
      statusCode: 409,
      message: "You can't suspend your own account.",
    });
    await admin`update actors set scopes = ${["admin.users"]} where id = ${memberId}`;
    await expect(
      users.setSuspended({ ...operator, id: memberId }, adminId, true),
    ).resolves.toMatchObject({ status: "suspended" });
    await expect(
      users.setSuspended({ ...operator, id: adminId }, memberId, true),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      users.setSuspended({ ...operator, id: memberId }, adminId, false),
    ).resolves.toMatchObject({ status: "active" });
    await admin`update actors set scopes = ${[]} where id = ${memberId}`;
    await expect(
      users.setSuspended({ ...operator, id: memberId, scopes: [] }, personId, true),
    ).rejects.toMatchObject({ statusCode: 403 });

    // An automation with user administration can't lock out the last person who has it.
    await expect(
      users.setSuspended({ ...operator, id: agentId, type: "agent" }, adminId, true),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: "The last active workspace administrator can't be suspended.",
    });

    const foreignOperator: Actor = {
      id: foreignAdminId,
      orgId: foreignOrgId,
      type: "user",
      scopes: ["admin.users"],
    };
    await expect(users.setSuspended(foreignOperator, memberId, true)).resolves.toBeNull();
    await expect(listed(memberId)).resolves.toMatchObject({ status: "active" });
  });

  it("keeps removed accounts closed", async () => {
    await admin`
      update organization_memberships
      set status = 'deprovisioned', suspended_at = null, ended_at = now()
      where org_id = ${orgId} and actor_id = ${memberId}
    `;
    await admin`update actors set disabled_at = now() where id = ${memberId}`;
    await expect(listed(memberId)).resolves.toMatchObject({ status: "removed" });
    await expect(users.setSuspended(operator, memberId, false)).rejects.toMatchObject({
      statusCode: 409,
      message: "This account was removed and can't be restored.",
    });
    await expect(users.setSuspended(operator, memberId, true)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});
