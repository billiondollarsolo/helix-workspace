import { randomUUID } from "node:crypto";
import type { Actor } from "@helix/sdk-types";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { ensureAdminDomain } from "../admin/domain-identity.js";
import { PostgresMailStore } from "../mail/index.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresActorOffboardingStore } from "./actor-offboarding.js";

const live = !skipUnlessLiveDatabase("actor ownership handoff");
describe.skipIf(!live)("atomic account ownership handoff", () => {
  const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 1 });
  const sql = tenantAwarePostgresSql(
    postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 4 }),
  );
  const offboarding = new PostgresActorOffboardingStore(sql);
  const mail = new PostgresMailStore(sql);
  const orgId = randomUUID(),
    foreignOrgId = randomUUID();
  const operatorId = randomUUID(),
    sourceId = randomUUID(),
    agentId = randomUUID(),
    userId = randomUUID(),
    foreignId = randomUUID();
  const domain = `${orgId}.test`,
    aliasDomain = `alias.${domain}`;
  const operator: Actor = { id: operatorId, orgId, type: "user", scopes: ["admin.users"] };
  const folderId = randomUUID(),
    fileId = randomUUID(),
    rawId = randomUUID(),
    threadId = randomUUID(),
    sentId = randomUUID(),
    incomingId = randomUUID();
  const authUserId = randomUUID(),
    authSessionId = randomUUID(),
    siblingActorId = randomUUID();
  const calendarId = randomUUID(),
    conversationId = randomUUID(),
    memoryId = randomUUID(),
    draftId = randomUUID();
  const as = <T>(actorId: string, operation: () => Promise<T>) =>
    withTenantPostgresContext(sql, { orgId, actorId }, operation);
  beforeAll(async () => {
    await admin`insert into orgs(id,slug,display_name,status) values(${orgId},${orgId},'Handoff','active'),(${foreignOrgId},${foreignOrgId},'Foreign','active')`;
    const primary = await ensureAdminDomain(admin, { orgId, domain });
    await admin`update admin_domains set status='verified',verified_at=now(),identity_enabled=true,mail_enabled=true,aliases_enabled=true,is_primary=true where id=${primary}`;
    const alias = await ensureAdminDomain(admin, { orgId, domain: aliasDomain });
    await admin`update admin_domains set status='verified',verified_at=now(),identity_enabled=true,mail_enabled=true,aliases_enabled=true,identity_mode='alias',alias_target_domain_id=${primary} where id=${alias}`;
    for (const id of [operatorId, sourceId, userId])
      await admin`insert into actors(id,org_id,type,email,display_name,scopes) values(${id},${orgId},'user',${`${id}@${domain}`},${id},${id === operatorId ? ["admin.users"] : []})`;
    await admin`insert into actors(id,org_id,type,email,display_name) values(${agentId},${orgId},'agent',${`agent@${domain}`},'Agent'),(${foreignId},${foreignOrgId},'user',${`${foreignId}@outside.test`},'Foreign')`;
    await admin`insert into drive_folders(id,org_id,owner_actor_id,created_by_actor_id,name) values(${folderId},${orgId},${sourceId},${sourceId},'Source files')`;
    await admin`insert into objects(id,org_id,owner_actor_id,kind,storage_key,mime_type,byte_size,metadata) values(${fileId},${orgId},${sourceId},'file',${fileId},'text/plain',1,${admin.json({ folderId })}),(${rawId},${orgId},${sourceId},'mail_source',${rawId},'message/rfc822',1,'{}')`;
    await admin`insert into threads(id,org_id,kind,subject,created_by_actor_id) values(${threadId},${orgId},'mail','Handoff history',${sourceId})`;
    await admin`insert into messages(id,org_id,thread_id,actor_id,kind,body,metadata) values(${sentId},${orgId},${threadId},${sourceId},'mail','Sent before handoff',${admin.json({ direction: "outbound", from: { address: `${sourceId}@${domain}` }, to: [{ address: `${userId}@${domain}` }], bcc: [{ address: "private@example.test" }] })}),(${incomingId},${orgId},${threadId},${userId},'mail','Received before handoff',${admin.json({ direction: "inbound", from: { address: `${userId}@${domain}` }, to: [{ address: `${sourceId}@${domain}` }] })})`;
    await admin`insert into mail_message_deliveries(org_id,message_id,actor_id,received_at,sent_at) values(${orgId},${sentId},${sourceId},null,now()),(${orgId},${incomingId},${sourceId},now(),null)`;
    await admin`insert into mail_thread_state(org_id,actor_id,thread_id,labels,starred) values(${orgId},${sourceId},${threadId},array['handoff-label'],true)`;
    await admin`insert into mail_labels(org_id,owner_actor_id,slug,name) values(${orgId},${sourceId},'handoff-label','Source label')`;
    await admin`insert into mail_drafts(id,org_id,actor_id,envelope) values(${draftId},${orgId},${sourceId},${admin.json({ from: { address: `${sourceId}@${domain}` }, to: [{ address: `${userId}@${domain}` }], subject: "Preserved draft", text: "Keep me" })})`;
    await admin`insert into cal_calendars(id,org_id,owner_actor_id,name) values(${calendarId},${orgId},${sourceId},'Source calendar')`;
    await admin`insert into carddav_contacts(org_id,owner_actor_id,addressbook_id,href,uid,vcard,etag) select ${orgId},${sourceId},id,'source.vcf',${randomUUID()},'BEGIN:VCARD\nVERSION:3.0\nFN:Source contact\nEND:VCARD','contact' from carddav_addressbooks where org_id=${orgId} and owner_actor_id=${sourceId} and is_default`;
    await admin`insert into assistant_conversations(id,org_id,actor_id,title) values(${conversationId},${orgId},${sourceId},'Source conversation')`;
    await admin`insert into assistant_messages(org_id,conversation_id,actor_id,role,content) values(${orgId},${conversationId},${sourceId},'user','Original author')`;
    await admin`insert into memory_items(id,org_id,actor_id,content,metadata) values(${memoryId},${orgId},${sourceId},'Source memory','{"classification":"standard"}')`;
    await admin`insert into mail_aliases(org_id,actor_id,email) values(${orgId},${sourceId},${`extra@${domain}`})`;
    await admin`insert into actors(id,org_id,type,email,display_name) values(${siblingActorId},${foreignOrgId},'user',${`${sourceId}@${domain}`},'Same global user in another workspace')`;
    await admin`insert into "user"(id,name,email) values(${authUserId},'Global identity',${`${sourceId}@${domain}`})`;
    await admin`insert into "session"(id,"userId",token,"expiresAt") values(${authSessionId},${authUserId},${randomUUID()},now()+interval '1 day')`;
    await as(
      operatorId,
      () =>
        sql`select helix_issue_nonhuman_credential(${orgId},${operatorId},${agentId},'api_key','Handoff agent','Regression',array['mail.read'],now()+interval '1 day',null,null,${"f".repeat(64)},null)`,
    );
    await admin`insert into app_passwords(actor_id,label,hash) values(${sourceId},'Retire','test-hash')`;
  });
  afterAll(async () => {
    await admin`delete from "user" where id=${authUserId}`;
    await cleanupTestTenants(admin, [orgId, foreignOrgId]);
    await Promise.all([admin.end(), sql.end()]);
  });

  it("requires explicit preview and an eligible successor; denies self, last-admin, and foreign boundaries", async () => {
    const missing = await offboarding.preview(operator, { actorId: sourceId });
    expect(missing.blockers).toContain("Choose a successor to receive this account's data.");
    expect(missing.counts).toMatchObject({
      driveFiles: 1,
      driveFolders: 1,
      mailMessages: 2,
      mailDrafts: 1,
      calendars: 1,
      contacts: 1,
      addressBooks: 1,
      assistantConversations: 1,
      assistantMemories: 1,
    });
    expect(
      (await offboarding.preview(operator, { actorId: operatorId, successorActorId: agentId }))
        .blockers,
    ).toContain("Administrators cannot offboard themselves.");
    await expect(
      offboarding.preview(operator, { actorId: foreignId, successorActorId: agentId }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(
      (await offboarding.preview(operator, { actorId: sourceId, successorActorId: foreignId }))
        .blockers,
    ).not.toHaveLength(0);
    await expect(
      offboarding.preview(
        { ...operator, id: userId, scopes: [] },
        { actorId: sourceId, successorActorId: agentId },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const [lastAdmin] = await admin.begin(async (tx) => {
      await tx`select set_config('helix.org_id',${orgId},true),set_config('helix.actor_id','',true)`;
      return tx<
        { preview: { blockers: string[] } }[]
      >`select helix_actor_offboard_preview(${orgId},${operatorId},null,false,true) preview`;
    });
    expect(lastAdmin?.preview.blockers).toContain(
      "The last active workspace administrator cannot be offboarded.",
    );
  });
  it("rejects stale preview and unavailable address capabilities without disabling or moving data", async () => {
    const preview = await offboarding.preview(operator, {
      actorId: sourceId,
      successorActorId: agentId,
      preserveReceivingAddresses: true,
    });
    expect(preview.blockers).toEqual([]);
    await admin`update actors set display_name='Updated source',updated_at=now() where id=${sourceId}`;
    await expect(
      offboarding.offboard(operator, {
        actorId: sourceId,
        successorActorId: agentId,
        preserveReceivingAddresses: true,
        confirmationToken: preview.confirmationToken,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    await admin`update admin_domains set aliases_enabled=false where org_id=${orgId} and domain=${domain}`;
    try {
      const blocked = await offboarding.preview(operator, {
        actorId: sourceId,
        successorActorId: agentId,
        preserveReceivingAddresses: true,
      });
      expect(blocked.blockers).toContain(
        "Every receiving address requires a verified domain with Mail and aliases enabled.",
      );
      await expect(
        offboarding.offboard(operator, {
          actorId: sourceId,
          successorActorId: agentId,
          preserveReceivingAddresses: true,
          confirmationToken: blocked.confirmationToken,
        }),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(
        (await admin`select disabled_at from actors where id=${sourceId}`)[0]?.disabled_at,
      ).toBeNull();
      expect(
        (await admin`select owner_actor_id from objects where id=${fileId}`)[0]?.owner_actor_id,
      ).toBe(sourceId);
    } finally {
      await admin`update admin_domains set aliases_enabled=true where org_id=${orgId} and domain=${domain}`;
    }
  });
  it("blocks in-flight transport and preserves immutable sender provenance against recipient writes", async () => {
    await admin`insert into mail_outbound_messages(org_id,actor_id,message_id,thread_id,envelope,undo_until,next_attempt_at,status,lease_owner,lease_token,lease_expires_at) values(${orgId},${sourceId},${sentId},${threadId},'{}',now(),null,'sending','test',${randomUUID()},now()+interval '1 minute')`;
    const input = { actorId: sourceId, successorActorId: agentId };
    const preview = await offboarding.preview(operator, input);
    expect(preview.blockers).toContain(
      "Mail delivery is in progress. Wait for it to settle before offboarding.",
    );
    await expect(
      offboarding.offboard(operator, { ...input, confirmationToken: preview.confirmationToken }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await admin`update mail_outbound_messages set status='queued',next_attempt_at=now()+interval '1 day',lease_owner=null,lease_token=null,lease_expires_at=null where org_id=${orgId} and actor_id=${sourceId}`;
    await expect(
      as(
        sourceId,
        () =>
          sql`update mail_message_deliveries set sent_at=now() where org_id=${orgId} and message_id=${incomingId} and actor_id=${sourceId}`,
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await withTenantPostgresContext(
      sql,
      { orgId },
      () =>
        sql`update mail_message_deliveries set sent_at=now() where org_id=${orgId} and message_id=${incomingId} and actor_id=${sourceId}`,
    );
    expect(
      (
        await admin`select sent_at from mail_message_deliveries where org_id=${orgId} and message_id=${incomingId} and actor_id=${sourceId}`
      )[0]?.sent_at,
    ).toBeNull();
  });
  it("rolls every transfer and credential change back when audit persistence fails", async () => {
    const input = {
      actorId: sourceId,
      successorActorId: agentId,
      preserveReceivingAddresses: true,
    };
    const preview = await offboarding.preview(operator, input);
    await admin.unsafe(
      `create function helix_test_offboard_audit_failure() returns trigger language plpgsql as $$ begin if new.verb='identity.actor.offboarded' then raise exception 'Offboard audit storage failed'; end if; return new; end $$; create trigger helix_test_offboard_audit_failure before insert on activity for each row execute function helix_test_offboard_audit_failure()`,
    );
    try {
      await expect(
        offboarding.offboard(operator, { ...input, confirmationToken: preview.confirmationToken }),
      ).rejects.toThrow("Offboard audit storage failed");
      expect(
        (await admin`select disabled_at from actors where id=${sourceId}`)[0]?.disabled_at,
      ).toBeNull();
      expect(
        (await admin`select owner_actor_id from objects where id=${fileId}`)[0]?.owner_actor_id,
      ).toBe(sourceId);
      expect(
        (await admin`select revoked_at from app_passwords where actor_id=${sourceId}`)[0]
          ?.revoked_at,
      ).toBeNull();
      expect(
        await admin`select 1 from mail_message_deliveries where org_id=${orgId} and actor_id=${agentId}`,
      ).toHaveLength(0);
    } finally {
      await admin.unsafe(
        "drop trigger helix_test_offboard_audit_failure on activity; drop function helix_test_offboard_audit_failure()",
      );
    }
  });
  it("hands user data to an agent atomically, retaining authors and receive-only primary/domain aliases", async () => {
    const input = {
      actorId: sourceId,
      successorActorId: agentId,
      preserveReceivingAddresses: true,
    };
    const preview = await offboarding.preview(operator, input);
    const result = await offboarding.offboard(operator, {
      ...input,
      confirmationToken: preview.confirmationToken,
    });
    expect(result).toMatchObject({
      disabled: true,
      appPasswordsRevoked: 1,
      sessionsRevoked: 0,
      successorActorId: agentId,
    });
    expect(
      (
        await admin`select status,lease_owner from mail_outbound_messages where org_id=${orgId} and actor_id=${sourceId}`
      )[0],
    ).toEqual({ status: "cancelled", lease_owner: null });
    expect(
      (await admin`select owner_actor_id from objects where id=${fileId}`)[0]?.owner_actor_id,
    ).toBe(agentId);
    expect(
      (await admin`select owner_actor_id from objects where id=${rawId}`)[0]?.owner_actor_id,
    ).toBe(sourceId);
    expect((await admin`select actor_id from messages where id=${sentId}`)[0]?.actor_id).toBe(
      sourceId,
    );
    expect(
      (
        await admin`select actor_id from assistant_messages where conversation_id=${conversationId}`
      )[0]?.actor_id,
    ).toBe(sourceId);
    expect(
      (await admin`select actor_id from assistant_conversations where id=${conversationId}`)[0]
        ?.actor_id,
    ).toBe(agentId);
    expect((await admin`select actor_id from memory_items where id=${memoryId}`)[0]?.actor_id).toBe(
      agentId,
    );
    expect(
      (await admin`select owner_actor_id from cal_calendars where id=${calendarId}`)[0]
        ?.owner_actor_id,
    ).toBe(agentId);
    expect(
      (await admin`select owner_actor_id from carddav_contacts where org_id=${orgId}`)[0]
        ?.owner_actor_id,
    ).toBe(agentId);
    expect(
      (await admin`select actor_id,envelope from mail_drafts where id=${draftId}`)[0],
    ).toMatchObject({ actor_id: agentId, envelope: { text: "Keep me" } });
    expect(
      (await admin`select envelope from mail_drafts where id=${draftId}`)[0]?.envelope,
    ).not.toHaveProperty("from");
    const delivered = await as(
      agentId,
      () =>
        sql<
          { message_id: string; sent_at: Date | null; received_at: Date | null }[]
        >`select message_id,sent_at,received_at from mail_message_deliveries where actor_id=${agentId}`,
    );
    expect(delivered.find((row) => row.message_id === sentId)?.sent_at).not.toBeNull();
    expect(delivered.find((row) => row.message_id === incomingId)?.received_at).not.toBeNull();
    expect(
      (
        await as(
          agentId,
          () =>
            sql`select labels,starred from mail_thread_state where actor_id=${agentId} and thread_id=${threadId}`,
        )
      )[0],
    ).toMatchObject({ labels: ["handoff-label"], starred: true });
    for (const address of [
      `${sourceId}@${domain}`,
      `${sourceId}@${aliasDomain}`,
      `extra@${domain}`,
    ])
      expect((await mail.resolveInboundAddress(address)).recipients).toMatchObject([
        { actorId: agentId, orgId },
      ]);
    expect(
      await as(agentId, () =>
        mail.resolveAuthorizedSender(orgId, agentId, `${sourceId}@${domain}`),
      ),
    ).toBeNull();
    const inherited = await as(agentId, () =>
      mail.getThread({ orgId, actorId: agentId, threadId }),
    );
    expect(inherited?.messages.find((message) => message.id === sentId)?.bcc).toEqual([
      { address: "private@example.test" },
    ]);
    expect(inherited?.messages).toHaveLength(2);
    for (const folder of ["inbox", "sent"] as const) {
      const page = await as(agentId, () => mail.listThreads({ orgId, actorId: agentId, folder }));
      expect(page.threads.map((thread) => thread.threadId)).toContain(threadId);
    }
    const folders = await as(agentId, () => mail.listFolders({ orgId, actorId: agentId }));
    expect(folders.find((folder) => folder.id === "sent")?.total).toBe(1);
    expect(
      (
        await as(agentId, () =>
          mail.search({ orgId, actorId: agentId, query: "Sent before handoff" }),
        )
      ).map((hit) => hit.messageId),
    ).toContain(sentId);
    expect(
      await as(operatorId, () => mail.getThread({ orgId, actorId: operatorId, threadId })),
    ).toBeNull();
    expect(
      await as(operatorId, () =>
        mail.getMailSearchRecord({ orgId, actorId: operatorId, messageId: sentId }),
      ),
    ).toBeNull();
    expect(
      (await admin`select status from organization_memberships where actor_id=${sourceId}`)[0]
        ?.status,
    ).toBe("deprovisioned");
    expect((await admin`select email,name from "user" where id=${authUserId}`)[0]).toEqual({
      email: `${sourceId}@${domain}`,
      name: "Global identity",
    });
    expect(await admin`select 1 from "session" where id=${authSessionId}`).toHaveLength(1);
    expect(
      (
        await admin`select helix_credential_principal_is_active(${siblingActorId},${foreignOrgId}) active`
      )[0]?.active,
    ).toBe(true);
    expect(
      (await admin`select helix_credential_principal_is_active(${sourceId},${orgId}) active`)[0]
        ?.active,
    ).toBe(false);
    expect(
      (
        await as(
          agentId,
          () => sql`select helix_drive_effective_role(${orgId},${agentId},'object',${fileId}) role`,
        )
      )[0]?.role,
    ).toBe("owner");
    expect(
      (
        await as(
          userId,
          () => sql`select helix_drive_effective_role(${orgId},${userId},'object',${fileId}) role`,
        )
      )[0]?.role,
    ).toBeNull();

    expect(
      (await admin`select status from search_reindex_jobs where id=${result.searchReindexJobId}`)[0]
        ?.status,
    ).toBe("queued");
    expect(
      await admin`select 1 from activity where org_id=${orgId} and verb='identity.actor.offboarded' and object_id=${sourceId}`,
    ).toHaveLength(1);
  });
  it("hands an agent's data to a human without changing prior authorship", async () => {
    const input = { actorId: agentId, successorActorId: userId };
    const preview = await offboarding.preview(operator, input);
    expect(preview.source.type).toBe("agent");
    expect(preview.counts.mailMessages).toBe(2);
    await offboarding.offboard(operator, {
      ...input,
      confirmationToken: preview.confirmationToken,
    });
    expect(
      (await admin`select owner_actor_id from objects where id=${fileId}`)[0]?.owner_actor_id,
    ).toBe(userId);
    expect((await admin`select actor_id from messages where id=${sentId}`)[0]?.actor_id).toBe(
      sourceId,
    );
    expect(
      (
        await admin`select actor_id from assistant_messages where conversation_id=${conversationId}`
      )[0]?.actor_id,
    ).toBe(sourceId);
    expect(
      (await admin`select actor_id from assistant_conversations where id=${conversationId}`)[0]
        ?.actor_id,
    ).toBe(userId);
    await expect(mail.resolveInboundAddress(`extra@${domain}`)).rejects.toMatchObject({
      responseCode: 550,
    });
    expect(
      (
        await admin`select revoked_at,revocation_epoch::int from agent_credentials where org_id=${orgId} and actor_id=${agentId}`
      )[0],
    ).toMatchObject({ revocation_epoch: 1 });
    expect(
      (
        await admin`select revoked_at from agent_credentials where org_id=${orgId} and actor_id=${agentId}`
      )[0]?.revoked_at,
    ).not.toBeNull();
  });
});
