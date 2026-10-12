import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { uniqueTestRole } from "../../test-support/test-role.js";
import { PostgresAuditStore } from "./store.js";
import { verifyAuditHashChain } from "./verifier.js";
import { PostgresTenantBootstrapSeedStore } from "../tenancy/provisioning-bootstrap.js";
import { PostgresTenantOwnerActorStore } from "../tenancy/provisioning-owner.js";
import { PostgresTenantStorageNamespaceStore } from "../tenancy/provisioning-storage.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresChatStore } from "../chat/index.js";

const ORG = "fa110000-0000-4000-8000-000000000001";
const PROVISIONED_ORG = "fa110000-0000-4000-8000-000000000002";
const OWNER = "fa110000-0000-4000-8000-000000000011";
const MEMBER = "fa110000-0000-4000-8000-000000000012";
const skip = skipUnlessLiveDatabase("Audit append under the runtime role");

describe("Audit append under the runtime role", { skip }, () => {
  const { name: role, password } = uniqueTestRole("helix_chat_audit");
  let admin: postgres.Sql;
  let runtimeRaw: postgres.Sql;
  let runtime: postgres.Sql;
  let chat: PostgresChatStore;
  let audit: PostgresAuditStore;

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    admin = postgres(databaseUrl, { max: 2, prepare: false });
    await cleanupTestTenants(admin, [ORG, PROVISIONED_ORG]);
    // Exactly the production runtime grants: helix_app's, nothing added.
    await admin.unsafe(
      `create role ${role} login inherit nosuperuser nobypassrls password '${password}'`,
    );
    await admin.unsafe(`grant helix_app to ${role}`);
    await admin`
      insert into orgs (id, slug, display_name)
      values
        (${ORG}, 'chat-audit-runtime', 'Chat audit runtime'),
        (${PROVISIONED_ORG}, 'chat-audit-provisioned', 'Chat audit provisioned')
    `;
    await admin`
      insert into actors (id, org_id, type, email, display_name)
      values
        (${OWNER}, ${ORG}, 'user', 'owner@chat-audit.test', 'Audit Owner'),
        (${MEMBER}, ${ORG}, 'user', 'member@chat-audit.test', 'Audit Member')
    `;
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtimeRaw = postgres(runtimeUrl.href, { max: 12, prepare: false });
    runtime = tenantAwarePostgresSql(runtimeRaw);
    chat = new PostgresChatStore(runtime);
    audit = new PostgresAuditStore(runtime);
  });

  afterAll(async () => {
    await runtimeRaw.end();
    await cleanupTestTenants(admin, [ORG, PROVISIONED_ORG]);
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.end();
  });

  function asActor<T>(actorId: string, run: () => Promise<T>): Promise<T> {
    return withTenantPostgresContext(runtime, { orgId: ORG, actorId }, run);
  }

  async function chatAudit(objectId: string) {
    const rows = await admin<{ verb: string; actor_id: string }[]>`
      select verb, actor_id from activity
      where org_id = ${ORG} and object_id = ${objectId}
      order by sequence
    `;
    return rows.map((row) => ({ verb: row.verb, actorId: row.actor_id }));
  }

  it("records send, edit and delete in the hash chain", async () => {
    const room = await asActor(OWNER, () =>
      chat.createRoom({ orgId: ORG, actorId: OWNER, subject: "Audit", memberActorIds: [MEMBER] }),
    );
    const sent = await asActor(MEMBER, () =>
      chat.sendMessage({ orgId: ORG, actorId: MEMBER, roomId: room.id, body: "hello" }),
    );
    await asActor(MEMBER, () =>
      chat.editMessage({ orgId: ORG, actorId: MEMBER, messageId: sent.id, body: "hello again" }),
    );
    await asActor(MEMBER, () =>
      chat.deleteMessage({ orgId: ORG, actorId: MEMBER, messageId: sent.id }),
    );

    expect(await chatAudit(room.id)).toEqual([{ verb: "chat.room.created", actorId: OWNER }]);
    expect(await chatAudit(sent.id)).toEqual([
      { verb: "chat.message.sent", actorId: MEMBER },
      { verb: "chat.message.edited", actorId: MEMBER },
      { verb: "chat.message.deleted", actorId: MEMBER },
    ]);
  });

  it("keeps one contiguous, verifiable chain under concurrent writes across rooms", async () => {
    const rooms = await Promise.all(
      ["North", "South", "East"].map((subject) =>
        asActor(OWNER, () =>
          chat.createRoom({ orgId: ORG, actorId: OWNER, subject, memberActorIds: [MEMBER] }),
        ),
      ),
    );
    await Promise.all(
      Array.from({ length: 36 }, (_, index) => {
        const room = rooms[index % rooms.length];
        if (room === undefined) throw new Error("Expected a room");
        const actorId = index % 2 === 0 ? OWNER : MEMBER;
        return asActor(actorId, () =>
          chat.sendMessage({
            orgId: ORG,
            actorId,
            roomId: room.id,
            body: `message ${String(index)}`,
          }),
        );
      }),
    );

    const records = await audit.listVerificationRecords({ orgId: ORG });
    expect(records.map((record) => Number(record.sequence))).toEqual(
      Array.from({ length: records.length }, (_, index) => index + 1),
    );
    expect(records.filter((record) => record.verb === "chat.message.sent").length).toBe(37);
    expect(verifyAuditHashChain(records)).toMatchObject({ valid: true });
  });

  it("provisions a tenant (storage, owner, bootstrap seed) in the worker's order", async () => {
    const orgId = PROVISIONED_ORG;
    const ownerEmail = "Owner@Provisioned.test";
    await new PostgresTenantStorageNamespaceStore(runtime).ensureDefaultObjectStorePrefix({
      orgId,
    });
    const owner = await new PostgresTenantOwnerActorStore(runtime).ensureInitialOwnerActor({
      orgId,
      email: ownerEmail,
    });
    const bootstrap = new PostgresTenantBootstrapSeedStore(runtime);

    await expect(bootstrap.ensureTenantBootstrapSeed({ orgId, ownerEmail })).resolves.toEqual({
      orgId,
      ownerActorId: owner.id,
      permissionSeeded: true,
      activitySeeded: true,
    });
    await expect(bootstrap.ensureTenantBootstrapSeed({ orgId, ownerEmail })).resolves.toMatchObject(
      {
        permissionSeeded: false,
        activitySeeded: false,
      },
    );
    const records = await audit.listVerificationRecords({ orgId });
    expect(records.map((record) => record.verb)).toEqual(["tenant.bootstrap.seeded"]);
    expect(verifyAuditHashChain(records)).toMatchObject({ valid: true });
  });
});
