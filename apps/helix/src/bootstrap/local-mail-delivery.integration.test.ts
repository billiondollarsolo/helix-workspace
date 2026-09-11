import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupTestTenants } from "../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../test-support/live-suite.js";
import { ensureAdminDomain } from "../platform/admin/domain-identity.js";
import { LocalMailTransport } from "../platform/mail/local-delivery.js";
import {
  MailSendService,
  OutboundMailDispatcher,
  OutboundMailWorker,
} from "../platform/mail/outbound.js";
import type { MailOutboundEnvelope } from "../platform/mail/types.js";
import { tenantMailClaims } from "../platform/mail/outbound-claims.js";
import { PostgresMailStore } from "../platform/mail/store.js";
import { mailRecordToIndexDocument } from "../platform/mail/search/indexer.js";
import {
  AuthorizingSearchEngine,
  authorizeWorkspaceSearchHit,
} from "../platform/search/authorized.js";
import {
  tenantAwarePostgresSql,
  withTenantPostgresContext,
} from "../platform/tenancy/postgres-roles.js";

describe.skipIf(skipUnlessLiveDatabase("local Mail delivery"))(
  "local Mail through the runtime database role",
  () => {
    const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 1 });
    const app = tenantAwarePostgresSql(
      postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 3 }),
    );
    const store = new PostgresMailStore(app);
    const orgId = randomUUID();
    const otherOrgId = randomUUID();
    const domain = `${orgId}.test`;
    const alice = randomUUID(),
      bob = randomUUID(),
      bcc = randomUUID(),
      outsider = randomUUID();
    const address = (id: string) => ({ address: `${id}@${domain}` });
    const tenant = <T>(fn: () => Promise<T>) => withTenantPostgresContext(app, { orgId }, fn);
    const actor = <T>(actorId: string, fn: () => Promise<T>) =>
      withTenantPostgresContext(app, { orgId, actorId }, fn);
    beforeAll(async () => {
      await admin`insert into orgs (id, slug, display_name, status) values (${orgId}, ${orgId}, 'Local Mail', 'active'), (${otherOrgId}, ${otherOrgId}, 'Other tenant', 'active')`;
      const domainId = await ensureAdminDomain(admin, { orgId, domain });
      await admin`update admin_domains set status='verified', verified_at=now(), mail_enabled=true, identity_enabled=true, is_primary=true where id=${domainId}`;
      for (const id of [alice, bob, bcc, outsider]) {
        await admin`insert into actors (id, org_id, type, email, display_name) values (${id}, ${orgId}, 'user', ${address(id).address}, ${id})`;
      }
    });
    afterAll(async () => {
      await cleanupTestTenants(admin, [orgId, otherOrgId]);
      await admin`delete from identity_subjects where id in ${admin([alice, bob, bcc, outsider])}`;
      await Promise.all([admin.end(), app.end()]);
    });
    it("delivers once, separates Inbox/Sent, hides Bcc and limits each reply to its recipients", async () => {
      expect(
        (await store.resolveInboundAddress(address(bob).address)).recipients.map(
          (entry) => entry.actorId,
        ),
      ).toEqual([bob]);
      const outbound = await tenant(() =>
        new MailSendService({ store, undoWindowMs: 0 }).queue({
          orgId,
          actorId: alice,
          envelope: {
            from: address(alice),
            to: [address(bob), address(alice)],
            cc: [],
            bcc: [address(bcc)],
            subject: "Private delivery",
            text: "Initial body",
            attachments: [],
          },
        }),
      );
      expect(await store.claimDueOutbound({ owner: "unscoped", leaseMs: 60_000 })).toBeNull();
      const claimed = await tenant(() =>
        store.claimDueOutbound({ owner: "test", leaseMs: 60_000 }),
      );
      expect(claimed?.id).toBe(outbound.id);
      if (!claimed) throw new Error("No claimed message");
      const remote = vi.fn(async () => {
        throw new Error("Local mail must not reach SMTP");
      });
      const transport = new LocalMailTransport(app, claimed, remote);
      await transport.send(claimed.envelope, { idempotencyKey: claimed.handoffKey });
      await transport.send(claimed.envelope, { idempotencyKey: claimed.handoffKey });
      expect(remote).not.toHaveBeenCalled();
      await admin`update mail_outbound_messages set delivery_metadata=${admin.json({ accepted: [address(bob).address, address(bcc).address] })} where id=${outbound.id}`;
      for (const id of [alice, bob, bcc]) {
        await actor(id, async () => {
          const inbox = await store.listThreads({ orgId, actorId: id });
          expect(inbox.threads.map((thread) => thread.threadId)).toContain(outbound.threadId);
          const sent = await store.listThreads({ orgId, actorId: id, folder: "sent" });
          expect(sent.threads.length).toBe(id === alice ? 1 : 0);
          const detail = await store.getThread({ orgId, actorId: id, threadId: outbound.threadId });
          expect(detail?.messages[0]?.bcc).toEqual(id === alice ? [address(bcc)] : []);
          expect(detail?.direction).toBe(id === alice ? "outbound" : "inbound");
          const indexed = await store.getMailSearchRecord({
            orgId,
            actorId: id,
            messageId: outbound.messageId,
          });
          expect(indexed?.direction).toBe(id === alice ? "outbound" : "inbound");
          // Also enforce the application boundary when an operator runs with privileged SQL.
          const search = await new PostgresMailStore(admin).search({
            orgId,
            actorId: id,
            query: "Initial body",
          });
          expect(search).toHaveLength(1);
          expect(search[0]?.deliveryMetadata).toEqual(
            id === alice ? { accepted: [address(bob).address, address(bcc).address] } : undefined,
          );
          expect(
            (await store.listFolders({ orgId, actorId: id })).find(
              (folder) => folder.id === "inbox",
            )?.total,
          ).toBe(1);
        });
      }
      const events =
        await admin`select payload->>'actorId' as actor from outbox where subject='activity.mail.received' and payload->>'messageId'=${outbound.messageId}`;
      expect(events.map((event) => event.actor).sort()).toEqual([alice, bob, bcc].sort());
      await actor(outsider, async () => {
        expect(
          await store.getThread({ orgId, actorId: outsider, threadId: outbound.threadId }),
        ).toBeNull();
        expect(
          await store.getThread({ orgId, actorId: bob, threadId: outbound.threadId }),
        ).toBeNull();
      });
      await expect(
        new LocalMailTransport(app, { ...claimed, orgId: otherOrgId }, remote).send(
          claimed.envelope,
          { idempotencyKey: claimed.handoffKey },
        ),
      ).rejects.toThrow("lease");
      const documents = (
        await new PostgresMailStore(admin).getMailSearchRecordsForIndexing({
          orgId,
          messageId: outbound.messageId,
        })
      ).map(mailRecordToIndexDocument);
      const globalSearch = new AuthorizingSearchEngine({
        engine: {
          id: "stale-index",
          index: async () => {},
          upsert: async () => {},
          delete: async () => {},
          search: async (request) => ({ query: request.query, hits: documents }),
        },
        authorize: (request, hit) =>
          authorizeWorkspaceSearchHit(
            {
              mail: store,
              drive: { getDriveSearchRecord: async () => null },
              chat: { getRoomForActor: async () => null },
              contacts: { getContactByIdForActor: async () => null },
            },
            request,
            hit,
          ),
      });
      const recipientResults = await actor(bob, () =>
        globalSearch.search({ query: domain, forOrgId: orgId, forActorId: bob }),
      );
      expect(recipientResults.hits).toHaveLength(1);
      expect(JSON.stringify(recipientResults)).not.toContain(address(bcc).address);
      expect(
        (
          await actor(outsider, () =>
            globalSearch.search({ query: domain, forOrgId: orgId, forActorId: outsider }),
          )
        ).hits,
      ).toEqual([]);
      const reply = await tenant(() =>
        new MailSendService({ store, undoWindowMs: 0 }).queue({
          orgId,
          actorId: bob,
          threadId: outbound.threadId,
          envelope: {
            from: address(bob),
            to: [address(alice)],
            cc: [],
            bcc: [],
            subject: "Private reply",
            text: "Bob to Alice only",
            attachments: [],
          },
        }),
      );
      const next = await tenant(() => store.claimDueOutbound({ owner: "test", leaseMs: 60_000 }));
      expect(next?.id).toBe(reply.id);
      if (!next) throw new Error("No claimed reply");
      await new LocalMailTransport(app, next, remote).send(next.envelope, {
        idempotencyKey: next.handoffKey,
      });
      await actor(bcc, async () => {
        const detail = await store.getThread({ orgId, actorId: bcc, threadId: reply.threadId });
        expect(detail?.messages.map((message) => message.id)).toEqual([outbound.messageId]);
        expect(await store.search({ orgId, actorId: bcc, query: "Bob to Alice only" })).toEqual([]);
        const records = await store.getMailSearchRecord({
          orgId,
          actorId: bcc,
          messageId: reply.messageId,
        });
        expect(records).toBeNull();
      });
    });
    it("rejects revoked Drive attachments before creating outbound mail", async () => {
      const objectId = randomUUID();
      await admin`insert into objects (id,org_id,kind,owner_actor_id,storage_key,mime_type,byte_size,metadata)
      values (${objectId},${orgId},'file',${outsider},${objectId},'text/plain',12,${admin.json({ status: "ready" })})`;
      await admin`insert into permissions (org_id,actor_id,resource_type,resource_id,role,granted_by_actor_id)
      values (${orgId},${bob},'object',${objectId},'reader',${outsider})`;
      await admin`update permissions set status='revoked',revoked_at=now(),revocation_epoch=revocation_epoch+1
      where org_id=${orgId} and actor_id=${bob} and resource_id=${objectId}`;
      await expect(
        actor(bob, () =>
          new MailSendService({ store, undoWindowMs: 0 }).queue({
            orgId,
            actorId: bob,
            envelope: {
              from: address(bob),
              to: [address(alice)],
              cc: [],
              bcc: [],
              subject: "Revoked attachment",
              text: "Denied",
              attachments: [{ objectId, mimeType: "text/plain" }],
            },
          }),
        ),
      ).rejects.toThrow("inaccessible");
      expect(
        await admin`select id from mail_outbound_messages where org_id=${orgId} and envelope->>'subject'='Revoked attachment'`,
      ).toHaveLength(0);
    });
    it("queues a sender through an authenticated request transaction", async () => {
      await actor(alice, () =>
        new MailSendService({ store, undoWindowMs: 0 }).queue({
          orgId,
          actorId: alice,
          envelope: {
            from: address(alice),
            to: [address(bob)],
            cc: [],
            bcc: [],
            subject: "Actor queue",
            text: "Actor body",
            attachments: [],
          },
        }),
      );
    });
    it("claims and completes under RLS without holding a transaction during transport I/O", async () => {
      const pending = await admin<
        { readonly id: string; readonly envelope: MailOutboundEnvelope }[]
      >`select id, envelope from mail_outbound_messages where org_id=${orgId} and status='queued'`;
      expect(pending).toHaveLength(1);
      const queued = pending[0];
      if (queued === undefined) throw new Error("Missing queued mail");
      const second = await actor(alice, () =>
        new MailSendService({ store, undoWindowMs: 0 }).queue({
          orgId,
          actorId: alice,
          envelope: {
            ...queued.envelope,
            messageId: `<${randomUUID()}@${domain}>`,
            subject: "Second batched message",
          },
        }),
      );
      const send = vi.fn(async () => {
        const context =
          await app`select nullif(current_setting('helix.org_id', true), '') as org_id`;
        expect(context[0]?.org_id).toBeNull();
        return { providerMessageId: "runtime-worker", deliveryMetadata: {} };
      });
      const claims = tenantMailClaims(app, store);
      const worker = new OutboundMailWorker({
        store: claims,
        dispatcher: new OutboundMailDispatcher(store, async () => ({ send }), {
          runForTenant: (tenantId, operation) =>
            withTenantPostgresContext(app, { orgId: tenantId }, operation),
          suppressionStore: {
            findActiveSuppressions: async (tenantId) => {
              const context = await app`select current_setting('helix.org_id') as org_id`;
              expect(context[0]?.org_id).toBe(tenantId);
              return [];
            },
          },
        }),
      });
      expect(await worker.drainOnce()).toBe(2);
      expect(send).toHaveBeenCalledTimes(2);
      const rows =
        await admin`select status from mail_outbound_messages where id in ${admin([queued.id, second.id])}`;
      expect(rows.map((row) => row.status)).toEqual(["accepted", "accepted"]);
      expect(await store.claimDueOutbound({ owner: "still-unscoped", leaseMs: 60_000 })).toBeNull();
    });
  },
);
