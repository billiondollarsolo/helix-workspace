import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { contractStorage } from "../../test-support/s3-storage.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import type { TenantStorageResolver } from "../storage/tenant-resolver.js";
import { PostgresGovernanceStore } from "../governance/ediscovery.js";
import { TenantEnvelopeCipher } from "../secrets/envelope.js";
import { PostgresMailDecisionStore } from "./decision/store.js";
import { PostgresMailStore } from "./store.js";
import { backfillMailBodies } from "./body-backfill.js";
import { linkMailBody, readMailBody, releaseMailBody, stageMailBody } from "./body-storage.js";

const skip = skipUnlessLiveDatabase("External mail body storage");
describe.skipIf(skip)("External mail body storage through runtime RLS", () => {
  const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 2 });
  const app = tenantAwarePostgresSql(
    postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 4 }),
  );
  const orgId = randomUUID();
  const otherOrg = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const outsider = randomUUID();
  let store: PostgresMailStore;
  let resolver: TenantStorageResolver;
  let storage: Awaited<ReturnType<typeof contractStorage>>["storage"];
  const text = "Hello résumé 📨\n".repeat(1000) + "hidden-search-needle";
  const html = `<p>${text}</p>`;
  const scope = <T>(actorId: string | undefined, run: () => Promise<T>) =>
    withTenantPostgresContext(app, { orgId, ...(actorId === undefined ? {} : { actorId }) }, run);
  beforeAll(async () => {
    ({ storage } = await contractStorage());
    resolver = ({ orgId: id }) =>
      id === orgId ? { client: storage, prefix: orgId, managedBy: "helix-default" } : undefined;
    store = new PostgresMailStore(app, { storageResolver: resolver });
    await admin`insert into orgs(id, slug, display_name) values (${orgId}, ${orgId}, 'Body storage'), (${otherOrg}, ${otherOrg}, 'Other')`;
    for (const [id, tenant] of [
      [alice, orgId],
      [bob, orgId],
      [outsider, otherOrg],
    ] as const) {
      await admin`insert into actors(id, org_id, type, email, display_name) values (${id}, ${tenant}, 'user', ${`${id}@example.test`}, 'Test')`;
    }
  });
  afterAll(async () => {
    const objects = await admin<
      { storage_key: string }[]
    >`select storage_key from mail_message_bodies where org_id = ${orgId}
      union select storage_key from drive_quarantine_deletions where org_id = ${orgId}`;
    for (const object of objects) await storage.delete(object.storage_key);
    await cleanupTestTenants(admin, [orgId, otherOrg]);
    await Promise.all([admin.end(), app.end()]);
  });
  const receive = (bodyText = text, target = store) =>
    scope(undefined, () =>
      target.insertInboundMessage({
        orgId,
        mailboxActorIds: [alice],
        from: { address: "sender@example.test" },
        to: [{ address: `${alice}@example.test` }],
        subject: "Stored body",
        bodyText,
        bodyHtml: `<p>${bodyText}</p>`,
        messageId: `<${randomUUID()}@example.test>`,
      }),
    );

  it("stores no full inline copy, hydrates mail and AI, and blocks another mailbox and tenant", async () => {
    const message = await receive();
    const [row] = await admin`select body, metadata from messages where id = ${message.messageId}`;
    expect(row?.body).toBe("");
    expect(row?.metadata.plainBody).toBeUndefined();
    expect(row?.metadata.preview.length).toBeLessThanOrEqual(240);
    expect(
      await scope(alice, () =>
        store.getThread({ orgId, actorId: alice, threadId: message.threadId }),
      ),
    ).toMatchObject({ messages: [{ body: html }] });
    const bounded = await scope(alice, () =>
      store.getThread({
        orgId,
        actorId: alice,
        threadId: message.threadId,
        resourcePage: { limit: 10 },
      }),
    );
    expect(bounded?.bodyTruncated).toBe(true);
    expect(bounded?.messages[0]?.body.length).toBeLessThanOrEqual(4096);
    expect(
      (
        await scope(alice, () =>
          store.getMailEnrichmentRecord({ orgId, actorId: alice, messageId: message.messageId }),
        )
      )?.body,
    ).toBe(text);
    const decision = new PostgresMailDecisionStore(
      app,
      new TenantEnvelopeCipher("mail-body-storage-test-master-secret"),
      resolver,
    );
    const candidate = await scope(undefined, () =>
      decision.loadCandidate({ orgId, messageId: message.messageId }),
    );
    expect(candidate?.candidate.body).toBe(html);
    expect(candidate?.candidate.plainBody).toBe(text);
    const get = vi.spyOn(storage, "get");
    get.mockClear();
    expect(
      await scope(bob, () => store.getThread({ orgId, actorId: bob, threadId: message.threadId })),
    ).toBeNull();
    await expect(
      scope(bob, () => readMailBody(app, resolver, orgId, message.messageId)),
    ).rejects.toThrow();
    await expect(
      withTenantPostgresContext(app, { orgId: otherOrg, actorId: outsider }, () =>
        readMailBody(app, resolver, orgId, message.messageId),
      ),
    ).rejects.toThrow();
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });

  it("hydrates scheduled and claimed sends without storing bodies in the delivery queue", async () => {
    const future = new Date(Date.now() + 60_000);
    const input = {
      orgId,
      actorId: alice,
      undoUntil: future,
      scheduled: true,
      outboxSubject: "helix.mail.outbound.queued",
      idempotencyKey: randomUUID(),
      envelope: {
        from: { address: `${alice}@example.test` },
        to: [{ address: "test@example.test" }],
        cc: [],
        bcc: [],
        subject: "Scheduled",
        text,
        html,
        attachments: [],
      },
    };
    const outbound = await scope(alice, () => store.createOutbound(input));
    expect(
      (await admin`select envelope from mail_outbound_messages where id = ${outbound.id}`)[0]
        ?.envelope,
    ).toMatchObject({ text: "", bodyStorage: "object-v1" });
    expect(
      (
        await scope(alice, () =>
          store.listScheduledSends({ orgId, actorId: alice, limit: 10, offset: 0 }),
        )
      ).scheduled[0]?.envelope.text,
    ).toBe(text);
    expect((await scope(alice, () => store.createOutbound(input))).envelope.html).toBe(html);
    const claimed = await scope(undefined, () =>
      store.claimDueOutbound({
        now: new Date(future.getTime() + 1),
        owner: "body-test",
        leaseMs: 60_000,
      }),
    );
    expect(claimed?.envelope.text).toBe(text);
    if (claimed === null) throw new Error("No claimed send");
    const get = vi
      .spyOn(storage, "get")
      .mockRejectedValue(new Error("storage unavailable after SMTP acceptance"));
    const accepted = await scope(undefined, () =>
      store.markOutboundSent({
        id: claimed.id,
        leaseToken: claimed.leaseToken,
        loadedEnvelope: claimed.envelope,
        providerMessageId: "accepted-fixture",
      }),
    );
    expect(accepted?.status).toBe("accepted");
    expect(accepted?.envelope.text).toBe(text);
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });

  it("keeps a durable cleanup job after outer transaction rollback and fences expired upload jobs", async () => {
    const before = await admin<
      { count: number }[]
    >`select count(*)::int as count from drive_quarantine_deletions where org_id = ${orgId}`;
    await expect(
      scope(undefined, async () => {
        await store.insertInboundMessage({
          orgId,
          mailboxActorIds: [alice],
          from: { address: "x@example.test" },
          to: [{ address: `${alice}@example.test` }],
          subject: "Rollback",
          bodyText: text,
        });
        throw new Error("rollback fixture");
      }),
    ).rejects.toThrow("rollback fixture");
    expect(
      (
        await admin`select count(*)::int as count from drive_quarantine_deletions where org_id = ${orgId}`
      )[0]?.count,
    ).toBe((before[0]?.count ?? 0) + 1);
    const stage = await stageMailBody(admin, resolver, orgId, { text });
    if (stage === undefined) throw new Error("No stage");
    const [job] =
      await admin`update drive_quarantine_deletions set status='processing', lease_expires_at=now()+interval '1 minute' where storage_key=${stage.storageKey} returning id`;
    await expect(admin.begin((tx) => linkMailBody(tx, randomUUID(), stage))).rejects.toThrow();
    await releaseMailBody(admin, stage);
    const [replacement] =
      await admin`select id, status from drive_quarantine_deletions where storage_key=${stage.storageKey}`;
    expect(replacement?.status).toBe("pending");
    expect(replacement?.id).not.toBe(job?.id);
  });

  it("migrates legacy bodies resumably and preserves bytes before removing inline copies", async () => {
    const legacy = new PostgresMailStore(app);
    const message = await receive(text, legacy);
    // Thread membership alone must not create another actor's private search copy.
    await admin`insert into mail_thread_state (org_id, actor_id, thread_id)
      values (${orgId}, ${bob}, ${message.threadId})`;
    const result = await backfillMailBodies(admin, resolver, orgId);
    expect(result.migrated).toBe(1);
    expect((await backfillMailBodies(admin, resolver, orgId)).migrated).toBe(0);
    const refreshes = await admin`
      select mutation, status from search_index_mutations
      where org_id = ${orgId} and indexer_id = 'mail.body-backfill'
    `;
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]).toMatchObject({
      status: "queued",
      mutation: { reloadMail: [{ orgId, actorId: alice, messageId: message.messageId }] },
    });
    expect(JSON.stringify(refreshes)).not.toContain(text);
    expect(await scope(alice, () => readMailBody(app, resolver, orgId, message.messageId))).toEqual(
      { version: 1, text, html },
    );
    const [reference] =
      await admin`select storage_key from mail_message_bodies where message_id=${message.messageId}`;
    await admin`delete from mail_message_deliveries where message_id=${message.messageId}`;
    await admin`delete from messages where id=${message.messageId}`;
    expect(
      (
        await admin`select status from drive_quarantine_deletions where storage_key=${reference?.storage_key}`
      )[0]?.status,
    ).toBe("pending");
  });
  it("preserves journal evidence, discovers body-only text, and keeps held blobs", async () => {
    const legacy = await receive("legacy retained", new PostgresMailStore(app));
    const matter = randomUUID();
    await admin`insert into governance_matters(id, org_id, name, created_by_actor_id) values (${matter}, ${orgId}, 'Body matter', ${alice})`;
    await admin`insert into mail_journal_settings(org_id, enabled, retention_days, updated_by_actor_id) values (${orgId}, true, 365, ${alice})`;
    const message = await receive();
    const [journal] =
      await admin`select snapshot from mail_journal_entries where message_id=${message.messageId}`;
    expect(journal?.snapshot.mailBody.storageKey).toMatch(/^mail\/bodies\//);
    expect(JSON.stringify(journal?.snapshot)).not.toContain("hidden-search-needle");
    const governance = new PostgresGovernanceStore(app, resolver);
    const found = await scope(alice, () =>
      governance.search({
        orgId,
        actorId: alice,
        matterId: matter,
        query: "hidden-search-needle",
        products: ["mail"],
        limit: 1,
      }),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.storageObjects.some((object) => object.key.startsWith("mail/bodies/"))).toBe(
      true,
    );
    await admin`insert into governance_legal_holds(id, org_id, matter_id, product, reason, created_by_actor_id)
      values (${randomUUID()}, ${orgId}, ${matter}, 'mail', 'Preserve mail', ${alice})`;
    await expect(admin`delete from messages where id=${message.messageId}`).rejects.toThrow(
      /protected/,
    );
    const result = await backfillMailBodies(admin, resolver, orgId);
    expect(result.retained).toBeGreaterThanOrEqual(1);
    expect((await admin`select body from messages where id=${legacy.messageId}`)[0]?.body).toBe(
      "<p>legacy retained</p>",
    );
  });

  it("rejects missing content and queues failed uploads for cleanup", async () => {
    const get = vi.spyOn(storage, "get").mockResolvedValue(null);
    await expect(receive()).rejects.toThrow(/verified or loaded/);
    get.mockRestore();
    const pending =
      await admin`select storage_key from drive_quarantine_deletions where org_id=${orgId} and status='pending' and next_attempt_at <= now()`;
    expect(pending.length).toBeGreaterThan(0);
  });
});
