import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import {
  PostgresScimProvisioningStore,
  ScimConflictError,
  ScimPreconditionError,
  type PutScimUser,
} from "./scim-provisioning.js";

const ORG_A = "e1500000-0000-4000-8000-000000000001";
const ORG_B = "e1500000-0000-4000-8000-000000000002";
const SOURCE = "e1500000-0000-4000-8000-000000000011";
const TARGET = "e1500000-0000-4000-8000-000000000012";
const CROSS_TENANT_TARGET = "e1500000-0000-4000-8000-000000000013";
const OBJECT = "e1500000-0000-4000-8000-000000000021";
const GROUP = "e1500000-0000-4000-8000-000000000031";
const ACCESS_TOKEN = `$ba$1$${"a".repeat(80)}`;
const REFRESH_TOKEN = `$ba$1$${"b".repeat(80)}`;
const ID_TOKEN = `$ba$1$${"c".repeat(80)}`;

describe("Postgres SCIM provisioning", { skip: !process.env.DATABASE_URL }, () => {
  let sql: postgres.Sql;
  let store: PostgresScimProvisioningStore;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined) throw new Error("DATABASE_URL is required.");
    sql = postgres(databaseUrl, { max: 3, prepare: false });
    await sql.unsafe(
      await readFile(
        new URL("../../db/migrations/0083_scim_provisioning.sql", import.meta.url),
        "utf8",
      ),
    );
    store = new PostgresScimProvisioningStore(sql);
    await cleanup();
    await sql`
      insert into orgs (id, slug, display_name, status)
      values
        (${ORG_A}, 'scim-integration-a', 'SCIM integration A', 'active'),
        (${ORG_B}, 'scim-integration-b', 'SCIM integration B', 'active')
      on conflict (id) do update set status = 'active'
    `;
    await withTenantPostgresContext(sql, { orgId: ORG_A }, async (tx) => {
      await tx`
        insert into actors (id, org_id, type, email, display_name, scim_external_id)
        values
          (${SOURCE}, ${ORG_A}, 'user', 'source-scim@helix.test', 'Source', 'source-idp'),
          (${TARGET}, ${ORG_A}, 'user', 'target-scim@helix.test', 'Target', 'target-idp')
      `;
      await tx`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size)
        values (${OBJECT}, ${ORG_A}, ${SOURCE}, 'file', 'scim-transfer-object', 'text/plain', 1)
      `;
      await tx`
        insert into admin_groups (id, org_id, name, scim_external_id)
        values (${GROUP}, ${ORG_A}, 'SCIM transfer group', 'transfer-group')
      `;
      await tx`
        insert into admin_group_members (org_id, group_id, actor_id)
        values (${ORG_A}, ${GROUP}, ${SOURCE})
      `;
      await tx`
        insert into "user" (id, name, email)
        values ('scim-integration-user', 'Source', 'source-scim@helix.test')
      `;
      await tx`
        insert into "session" (id, "userId", token, "expiresAt")
        values ('scim-integration-session', 'scim-integration-user',
                'scim-integration-session-token', now() + interval '1 day')
      `;
      await tx`
        insert into account (
          id, "userId", "accountId", "providerId", issuer,
          "accessToken", "refreshToken", "idToken"
        )
        values ('scim-integration-account', 'scim-integration-user',
                'scim-integration-account-id', 'credential', 'local:credential',
                ${ACCESS_TOKEN}, ${REFRESH_TOKEN}, ${ID_TOKEN})
      `;
      await tx`
        insert into app_passwords (id, actor_id, label, hash)
        values ('e1500000-0000-4000-8000-000000000041', ${SOURCE}, 'SCIM test', 'hash')
      `;
      await tx`
        insert into oauth_access_tokens (
          token_hash, client_id, actor_id, org_id, issued_at, expires_at
        ) values (
          'scim-access-token', 'scim-client', ${SOURCE}, ${ORG_A}, now(), now() + interval '1 day'
        )
      `;
      await tx`
        insert into oauth_refresh_tokens (
          token_hash, family_id, client_id, actor_id, org_id, scopes,
          client_epoch, issued_at, expires_at
        ) values (
          'scim-refresh-token', 'e1500000-0000-4000-8000-000000000051',
          'scim-client', ${SOURCE}, ${ORG_A}, '{}', 0, now(), now() + interval '1 day'
        )
      `;
      await tx`
        insert into oauth_grants (id, client_id, actor_id, org_id)
        values ('e1500000-0000-4000-8000-000000000061', 'scim-client', ${SOURCE}, ${ORG_A})
      `;
    });
    await withTenantPostgresContext(sql, { orgId: ORG_B }, async (tx) => {
      await tx`
        insert into actors (id, org_id, type, email, display_name, scim_external_id)
        values (${CROSS_TENANT_TARGET}, ${ORG_B}, 'user',
                'cross-tenant-scim@helix.test', 'Cross tenant', 'cross-idp')
      `;
    });
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  it("makes retried creates idempotent while rejecting correlation-key reuse", async () => {
    const input = userInput("retry-idp", "retry-scim@helix.test", "Retry");
    const first = await store.createUser(ORG_A, input);
    const second = await store.createUser(ORG_A, input);
    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, record: { id: first.record.id } });
    await expect(
      store.createUser(ORG_A, { ...input, userName: "different-scim@helix.test" }),
    ).rejects.toBeInstanceOf(ScimConflictError);
  });

  it("persists idempotent Group sync and rejects stale membership replacement", async () => {
    const input = {
      externalId: "created-group-idp",
      displayName: "SCIM integration created group",
      memberIds: [TARGET],
    };
    const first = await store.createGroup(ORG_A, input);
    const retry = await store.createGroup(ORG_A, input);
    expect(first.created).toBe(true);
    expect(retry).toMatchObject({ created: false, record: { id: first.record.id } });
    const replaced = await store.putGroup(
      ORG_A,
      first.record.id,
      { ...input, displayName: "SCIM integration renamed group" },
      first.record.version,
    );
    expect(replaced).toMatchObject({
      displayName: "SCIM integration renamed group",
      members: [{ value: TARGET }],
    });
    await expect(
      store.putGroup(ORG_A, first.record.id, input, first.record.version),
    ).rejects.toBeInstanceOf(ScimPreconditionError);
    if (replaced === null) throw new Error("Group replacement unexpectedly returned null.");
    await expect(store.deleteGroup(ORG_A, first.record.id, replaced.version)).resolves.toBe(true);
  });

  it("atomically transfers data, removes access, and revokes every user token family", async () => {
    const source = await store.getUser(ORG_A, SOURCE);
    if (source === null) throw new Error("Missing source fixture.");
    await store.putUser(
      ORG_A,
      SOURCE,
      {
        ...userInput(source.externalId, source.userName, source.displayName),
        active: false,
        dataTransferTargetId: TARGET,
      },
      source.version,
    );

    await withTenantPostgresContext(sql, { orgId: ORG_A }, async (tx) => {
      const actors = await tx`select disabled_at from actors where id = ${SOURCE}`;
      const objects = await tx`select owner_actor_id from objects where id = ${OBJECT}`;
      const memberships = await tx`select id from admin_group_members where actor_id = ${SOURCE}`;
      const organizationMemberships = await tx`
        select status, ended_at from organization_memberships where actor_id = ${SOURCE}
      `;
      const sessions = await tx`select id from "session" where id = 'scim-integration-session'`;
      const accounts =
        await tx`select "accessToken", "refreshToken", "idToken" from account where id = 'scim-integration-account'`;
      const appPasswords =
        await tx`select revoked_at from app_passwords where actor_id = ${SOURCE}`;
      const accessTokens =
        await tx`select revoked_at from oauth_access_tokens where token_hash = 'scim-access-token'`;
      const refreshTokens =
        await tx`select revoked_at from oauth_refresh_tokens where token_hash = 'scim-refresh-token'`;
      const grants = await tx`select revoked_at from oauth_grants where actor_id = ${SOURCE}`;
      expect(actors[0]?.disabled_at).not.toBeNull();
      expect(objects[0]?.owner_actor_id).toBe(TARGET);
      expect(memberships).toHaveLength(0);
      expect(organizationMemberships[0]).toMatchObject({ status: "deprovisioned" });
      expect(organizationMemberships[0]?.ended_at).not.toBeNull();
      // BetterAuth sessions and upstream IdP tokens belong to the global
      // subject, so suspending one organization must not log it out elsewhere.
      expect(sessions).toHaveLength(1);
      expect(accounts[0]).toMatchObject({
        accessToken: ACCESS_TOKEN,
        refreshToken: REFRESH_TOKEN,
        idToken: ID_TOKEN,
      });
      expect(appPasswords[0]?.revoked_at).not.toBeNull();
      expect(accessTokens[0]?.revoked_at).not.toBeNull();
      expect(refreshTokens[0]?.revoked_at).not.toBeNull();
      expect(grants[0]?.revoked_at).not.toBeNull();
    });
  });

  it("rejects cross-tenant transfer targets before changing the user", async () => {
    const target = await store.getUser(ORG_A, TARGET);
    if (target === null) throw new Error("Missing target fixture.");
    await expect(
      store.putUser(
        ORG_A,
        TARGET,
        {
          ...userInput(target.externalId, target.userName, target.displayName),
          active: false,
          dataTransferTargetId: CROSS_TENANT_TARGET,
        },
        target.version,
      ),
    ).rejects.toBeInstanceOf(ScimConflictError);
    expect(await store.getUser(ORG_A, TARGET)).toMatchObject({
      active: true,
      version: target.version,
    });
  });

  async function cleanup(): Promise<void> {
    await withTenantPostgresContext(sql, { orgId: ORG_A }, async (tx) => {
      await tx`delete from oauth_refresh_tokens where token_hash = 'scim-refresh-token'`;
      await tx`delete from oauth_access_tokens where token_hash = 'scim-access-token'`;
      await tx`delete from oauth_grants where client_id = 'scim-client'`;
      await tx`delete from account where id = 'scim-integration-account'`;
      await tx`delete from "user" where id = 'scim-integration-user'`;
      await tx`delete from app_passwords where actor_id in (${SOURCE}, ${TARGET})`;
      await tx`delete from admin_groups where org_id = ${ORG_A} and
               (id = ${GROUP} or name like 'SCIM integration %')`;
      await tx`delete from objects where id = ${OBJECT}`;
      await tx`delete from actors where org_id = ${ORG_A} and
               (id in (${SOURCE}, ${TARGET}) or email like '%-scim@helix.test')`;
    });
    await withTenantPostgresContext(sql, { orgId: ORG_B }, async (tx) => {
      await tx`delete from actors where id = ${CROSS_TENANT_TARGET}`;
    });
    await sql`delete from orgs where id in (${ORG_A}, ${ORG_B})`;
  }
});

function userInput(externalId: string | null, userName: string, displayName: string): PutScimUser {
  return {
    externalId,
    userName,
    displayName,
    givenName: null,
    familyName: null,
    active: true,
  };
}
