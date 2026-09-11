import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { tenantAwarePostgresSql } from "../tenancy/postgres-roles.js";
import { PostgresScimProvisioningStore, ScimConflictError } from "./scim-provisioning.js";

const live = !skipUnlessLiveDatabase("SCIM shared ownership handoff");
describe.skipIf(!live)("SCIM uses the same atomic account retirement", () => {
  const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 1 });
  const sql = tenantAwarePostgresSql(
    postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 4 }),
  );
  const store = new PostgresScimProvisioningStore(sql);
  const orgId = randomUUID(),
    otherOrgId = randomUUID();
  const sourceId = randomUUID(),
    foreignId = randomUUID(),
    adminA = randomUUID(),
    adminB = randomUUID();
  const fileId = randomUUID(),
    userId = randomUUID(),
    sessionId = randomUUID();
  const email = `${sourceId}@scim-handoff.test`;
  beforeAll(async () => {
    await admin`insert into orgs(id,slug,display_name,status) values(${orgId},${orgId},'SCIM Handoff','active'),(${otherOrgId},${otherOrgId},'Other workspace','active')`;
    for (const id of [sourceId, adminA, adminB])
      await admin`insert into actors(id,org_id,type,email,display_name,scopes) values(${id},${orgId},'user',${id === sourceId ? email : `${id}@scim-handoff.test`},${id},${id === sourceId ? [] : [id === adminB ? "admin.console.write" : "admin.users"]})`;
    await admin`insert into actors(id,org_id,type,email,display_name) values(${foreignId},${otherOrgId},'user',${email},'Global sibling')`;
    await admin`insert into objects(id,org_id,owner_actor_id,kind,storage_key,mime_type,byte_size) values(${fileId},${orgId},${sourceId},'file',${fileId},'text/plain',1)`;
    await admin`insert into "user"(id,name,email) values(${userId},'Shared global name',${email})`;
    await admin`insert into "session"(id,"userId",token,"expiresAt") values(${sessionId},${userId},${randomUUID()},now()+interval '1 day')`;
    await admin`insert into oauth_access_tokens(token_hash,client_id,actor_id,org_id,issued_at,expires_at) values(${sourceId},'scim-handoff',${sourceId},${orgId},now(),now()+interval '1 day')`;
    await admin`insert into oauth_refresh_tokens(token_hash,family_id,client_id,actor_id,org_id,scopes,client_epoch,issued_at,expires_at) values(${sourceId},${randomUUID()},'scim-handoff',${sourceId},${orgId},'{}',0,now(),now()+interval '1 day')`;
    await admin`insert into oauth_grants(id,client_id,actor_id,org_id) values(${randomUUID()},'scim-handoff',${sourceId},${orgId})`;
  });
  afterAll(async () => {
    await admin`delete from "user" where id=${userId}`;
    await cleanupTestTenants(admin, [orgId, otherOrgId]);
    await Promise.all([admin.end(), sql.end()]);
  });

  it("does not let tenant SCIM rename the shared global login", async () => {
    const current = await store.getUser(orgId, sourceId);
    expect(current).not.toBeNull();
    await store.putUser(
      orgId,
      sourceId,
      {
        externalId: "changed-tenant-profile",
        userName: email,
        displayName: "Tenant-only name",
        givenName: "Tenant",
        familyName: "Name",
        active: true,
      },
      current?.version ?? null,
    );
    expect((await admin`select name,email from "user" where id=${userId}`)[0]).toEqual({
      name: "Shared global name",
      email,
    });
    expect(
      (await admin`select display_name from actors where id=${foreignId}`)[0]?.display_name,
    ).toBe("Global sibling");
  });

  it("rejects foreign transfer atomically; explicit legacy no-target archival keeps data and global sessions", async () => {
    await expect(store.deleteUser(orgId, sourceId, null, foreignId)).rejects.toBeInstanceOf(
      ScimConflictError,
    );
    expect(
      (await admin`select disabled_at from actors where id=${sourceId}`)[0]?.disabled_at,
    ).toBeNull();
    expect(await store.deleteUser(orgId, sourceId, null, null)).toBe(true);
    expect(
      (await admin`select owner_actor_id from objects where id=${fileId}`)[0]?.owner_actor_id,
    ).toBe(sourceId);
    expect(
      (await admin`select disabled_at from actors where id=${sourceId}`)[0]?.disabled_at,
    ).not.toBeNull();
    for (const table of ["oauth_access_tokens", "oauth_refresh_tokens", "oauth_grants"]) {
      const rows = await admin.unsafe<{ revoked_at: Date | null }[]>(
        `select revoked_at from ${table} where org_id=$1 and actor_id=$2`,
        [orgId, sourceId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revoked_at).not.toBeNull();
    }
    expect(await admin`select 1 from "session" where id=${sessionId}`).toHaveLength(1);
    expect(
      (
        await admin`select helix_credential_principal_is_active(${foreignId},${otherOrgId}) active`
      )[0]?.active,
    ).toBe(true);
    expect(
      (await admin`select helix_credential_principal_is_active(${sourceId},${orgId}) active`)[0]
        ?.active,
    ).toBe(false);
  });

  it("serializes concurrent removals so one active human administrator remains", async () => {
    const results = await Promise.allSettled([
      store.deleteUser(orgId, adminA, null, null),
      store.deleteUser(orgId, adminB, null, null),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toBeInstanceOf(
      ScimConflictError,
    );
    expect(
      await admin`select id from actors where org_id=${orgId} and id in (${adminA},${adminB}) and disabled_at is null`,
    ).toHaveLength(1);
  });
});
