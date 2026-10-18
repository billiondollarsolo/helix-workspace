import { PostgresChatStore } from "../chat/index.js";
import { createStoreBackedMcpResourceProvider } from "../../api/mcp-resources.js";
import Fastify from "fastify";
import { LiveRoutes } from "./routes.js";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { LiveStore } from "./store.js";

describe.skipIf(skipUnlessLiveDatabase("Live inbox and presence"))(
  "Live inbox through runtime RLS",
  () => {
    const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 3 });
    const app = tenantAwarePostgresSql(
      postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 4 }),
    );
    const orgId = randomUUID(),
      otherOrg = randomUUID();
    const actor: Actor = {
      id: randomUUID(),
      orgId,
      type: "agent",
      scopes: ["notifications.read", "chat.read", "mail.read"],
    };
    const other: Actor = { ...actor, id: randomUUID(), orgId: otherOrg };
    const store = new LiveStore(app);
    beforeAll(async () => {
      for (const a of [actor, other]) {
        await admin`insert into orgs(id,slug,display_name) values(${a.orgId},${a.orgId},'Live test')`;
        await admin`insert into actors(id,org_id,type,email,display_name) values(${a.id},${a.orgId},'agent',${`${a.id}@example.test`},'Live test')`;
      }
    });
    afterAll(async () => {
      await cleanupTestTenants(admin, [orgId, otherOrg]);
      await Promise.all([admin.end(), app.end()]);
    });
    const notification = async (tx: postgres.Sql | postgres.TransactionSql = admin) => {
      const id = randomUUID();
      await tx`insert into notifications(id,org_id,actor_id,verb,object_type,object_id,summary) values(${id},${orgId},${actor.id},'test.created','test',${id},'Private')`;
      return id;
    };
    it("projects committed references only; scopes rows to actor and tenant; explicitly resets stale cursors", async () => {
      const id = await notification();
      const page = await store.list(actor, 0);
      expect(page.events).toEqual([
        expect.objectContaining({ resourceId: id, type: "notification", cursor: 1 }),
      ]);
      expect(JSON.stringify(page)).not.toContain("Private");
      const first = page.events[0];
      if (!first) throw new Error("Missing event");
      expect(await store.resolve(actor, first.id)).toEqual({
        event: page.events[0],
        source: null,
      });
      await expect(store.resolve(other, first.id)).rejects.toThrow("Event unavailable");
      await expect(store.resolve({ ...actor, scopes: [] }, first.id)).rejects.toThrow(
        "Event unavailable",
      );
      expect((await store.list(other, 0)).events).toEqual([]);
      expect((await store.list({ ...actor, id: other.id }, 0)).events).toEqual([]);
      await expect(
        admin.begin(async (tx) => {
          await notification(tx);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect((await store.list(actor, 0)).latestCursor).toBe(1);
      await admin`update actor_events set created_at=now()-interval '8 days' where actor_id=${actor.id}`;
      expect(await store.list(actor, 0)).toMatchObject({
        resetRequired: true,
        cursor: 1,
        events: [],
      });
      expect(await store.list(actor, 999)).toMatchObject({ resetRequired: true, cursor: 1 });
    });
    it("resolves authenticated senders, reads the exact referenced message, and denies revoked room access", async () => {
      const sender = randomUUID(),
        room = randomUUID(),
        message = randomUUID();
      await admin`insert into actors(id,org_id,type,email,display_name) values(${sender},${orgId},'user',${`${sender}@example.test`},'Sender')`;
      await admin`insert into threads(id,org_id,kind,subject,created_by_actor_id) values(${room},${orgId},'chat_room','Resolver',${sender})`;
      await admin`insert into chat_room_settings(thread_id,org_id,name) values(${room},${orgId},'Resolver')`;
      await admin`insert into permissions(org_id,actor_id,resource_type,resource_id,role,granted_by_actor_id) values
        (${orgId},${sender},'thread',${room},'owner',${sender}),(${orgId},${actor.id},'thread',${room},'member',${sender})`;
      await admin`insert into messages(id,org_id,thread_id,actor_id,kind,body,metadata) values(${message},${orgId},${room},${sender},'chat','the exact message',${admin.json({ mentions: [{ id: actor.id, displayName: "Live test" }] })})`;
      await admin`insert into notifications(org_id,actor_id,verb,object_type,object_id,summary) values(${orgId},${actor.id},'chat.mentioned','chat.message',${message},'Mention')`;
      const [event] = await admin<
        { sequence: string }[]
      >`select sequence::text from actor_events where actor_id=${actor.id} and resource_id=${message}`;
      if (!event) throw new Error("Missing chat event");
      const id = `${actor.id}:${event.sequence}`;
      const fileId = randomUUID(),
        privateFileId = randomUUID(),
        pendingFileId = randomUUID();
      for (const [objectId, status] of [
        [fileId, "ready"],
        [privateFileId, "ready"],
        [pendingFileId, "ready"],
      ] as const) {
        await admin`insert into objects(id,org_id,owner_actor_id,kind,storage_key,mime_type,byte_size,sha256,metadata) values(${objectId},${orgId},${sender},'file',${objectId},'text/plain',12,${"a".repeat(64)},${admin.json({ name: "request.txt", status })})`;
      }
      await admin.begin(async (tx) => {
        await tx`select set_config('helix.org_id',${orgId},true),set_config('helix.actor_id',${sender},true)`;
        for (const objectId of [fileId, pendingFileId]) {
          await tx`insert into permissions(org_id,actor_id,resource_type,resource_id,role,granted_by_actor_id) values(${orgId},${actor.id},'object',${objectId},'reader',${sender})`;
          await tx`insert into message_attachments(org_id,message_id,object_id,disposition) values(${orgId},${message},${objectId},'attachment')`;
        }
      });
      await admin`update objects set metadata=metadata || '{"status":"pending_upload"}'::jsonb where id=${pendingFileId}`;
      const resolved = await store.resolve(actor, id);
      expect(resolved.source?.attachments).toEqual([
        {
          objectId: fileId,
          source: "drive",
          name: "request.txt",
          mimeType: "text/plain",
          byteSize: 12,
          sha256: "a".repeat(64),
        },
      ]);
      expect(resolved.source?.audienceHash).toMatch(/^[a-f0-9]{64}$/u);
      const newPeer = randomUUID();
      await admin`insert into actors(id,org_id,type,display_name) values(${newPeer},${orgId},'user','New peer')`;
      await admin`insert into permissions(org_id,actor_id,resource_type,resource_id,role,granted_by_actor_id) values(${orgId},${newPeer},'thread',${room},'member',${sender})`;
      const expanded = await store.resolve(actor, id);
      expect(expanded.source?.audienceHash).not.toBe(resolved.source?.audienceHash);
      expect(expanded.source?.attachments).toEqual([]);
      await admin`delete from permissions where org_id=${orgId} and actor_id=${newPeer} and resource_id=${room}`;
      expect((await store.resolve(actor, id)).source?.attachments).toHaveLength(1);
      await admin`update objects set sha256=${"b".repeat(64)} where id=${fileId}`;
      expect((await store.resolve(actor, id)).source?.attachments[0]?.sha256).toBe("b".repeat(64));
      await admin`update objects set deleted_at=now() where id=${fileId}`;
      expect((await store.resolve(actor, id)).source?.attachments).toEqual([]);
      expect(resolved.source).toMatchObject({
        senderActorId: sender,
        senderType: "user",
        messageId: message,
        threadId: room,
      });
      if (!resolved.source) throw new Error("Missing source");
      const resources = createStoreBackedMcpResourceProvider({ chat: new PostgresChatStore(app) });
      const read = (uri: string) =>
        withTenantPostgresContext(app, { orgId, actorId: actor.id }, () =>
          resources.read(actor, uri),
        );
      const content = await read(resolved.source.uri);
      expect(content?.text).toContain("the exact message");
      await expect(read(`helix://chat/room/${room}?messageId=${randomUUID()}`)).resolves.toBeNull();
      await expect(store.resolve(other, id)).rejects.toThrow("Event unavailable");
      await admin`delete from permissions where org_id=${orgId} and actor_id=${actor.id} and resource_id=${room}`;
      await expect(store.resolve(actor, id)).rejects.toThrow("Event unavailable");
      await expect(read(resolved.source.uri)).resolves.toBeNull();
    });
    it("aggregates multiple leases, keeps chosen status and expires both leases and statuses", async () => {
      const one = randomUUID(),
        two = randomUUID();
      await store.setStatus(actor, {
        availability: "dnd",
        text: "Testing",
        emoji: "🧪",
        expiresAt: null,
      });
      await store.heartbeat(actor, one, "working");
      await store.heartbeat(actor, two, "idle");
      expect(await store.status(actor, [actor.id])).toMatchObject([
        { connected: true, state: "working", availability: "dnd" },
      ]);
      expect(await store.status(other, [actor.id])).toEqual([]);
      await store.heartbeat(actor, one, "idle", true);
      expect(await store.status(actor, [actor.id])).toMatchObject([
        { connected: true, state: "idle" },
      ]);
      await admin`update actor_presence_connections set seen_at=now()-interval '70 seconds' where actor_id=${actor.id}`;
      await admin`update actor_status set expires_at=now()-interval '1 second' where actor_id=${actor.id}`;
      expect(await store.status(actor, [actor.id])).toMatchObject([
        { connected: false, state: "offline", availability: "available", text: "" },
      ]);
    });
    it("rejects anonymous presence access before touching actor data", async () => {
      const server = Fastify();
      const live = new LiveRoutes(app, async () => ({ actor: { ...actor, id: "anonymous" } }));
      await live.install(server);
      try {
        for (const url of ["/api/presence", "/api/events"])
          expect((await server.inject({ method: "GET", url })).statusCode).toBe(401);
        expect(
          (
            await server.inject({
              method: "POST",
              url: "/api/presence/heartbeat",
              payload: { connectionId: randomUUID(), state: "active" },
            })
          ).statusCode,
        ).toBe(401);
      } finally {
        await server.close();
      }
    });
    it("keeps credential status writes behind tool policy while allowing self transport heartbeats", async () => {
      const server = Fastify();
      const live = new LiveRoutes(app, async () => ({ actor, credentialId: "read-only-test-key" }));
      await live.install(server);
      try {
        expect(
          (
            await server.inject({
              method: "PATCH",
              url: "/api/presence",
              payload: { availability: "away", text: "Bypass", emoji: "", expiresAt: null },
            })
          ).statusCode,
        ).toBe(403);
        const connectionId = randomUUID();
        expect(
          (
            await server.inject({
              method: "POST",
              url: "/api/presence/heartbeat",
              payload: { connectionId, state: "idle" },
            })
          ).statusCode,
        ).toBe(200);
        await server.inject({
          method: "POST",
          url: "/api/presence/heartbeat",
          payload: { connectionId, state: "idle", disconnect: true },
        });
      } finally {
        await server.close();
      }
    });
    it("acknowledges the honored MCP filter, streams committed hints, and ends gracefully", async () => {
      const server = Fastify();
      const live = new LiveRoutes(app, async () => ({ actor, credentialId: "test-key" }));
      await live.install(server);
      server.post("/mcp", (request, reply) => live.stream(request, reply, true));
      const url = await server.listen({ port: 0, host: "127.0.0.1" });
      const response = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "watch-1",
          method: "subscriptions/listen",
          params: {
            notifications: {
              resourceSubscriptions: ["helix://events/inbox"],
              toolsListChanged: true,
            },
          },
        }),
      });
      if (!response.body) throw new Error("Missing subscription stream");
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      try {
        expect(response.headers.get("x-accel-buffering")).toBe("no");
        const ack = decoder.decode((await reader.read()).value);
        expect(ack).toContain("notifications/subscriptions/acknowledged");
        expect(ack).toContain('"io.modelcontextprotocol/subscriptionId":"watch-1"');
        expect(ack).not.toContain("toolsListChanged");
        await notification();
        const update = decoder.decode((await reader.read()).value);
        expect(update).toContain("notifications/resources/updated");
        expect(update).not.toContain("Private");
        expect(update).not.toContain("id: ");
        const closing = server.close();
        const final = decoder.decode((await reader.read()).value);
        expect(final).toContain(
          '"result":{"_meta":{"io.modelcontextprotocol/subscriptionId":"watch-1"}}',
        );
        await reader.cancel();
        await closing;
      } finally {
        await reader.cancel().catch(() => undefined);
        await server.close();
      }
    });

    it("rechecks room access, token scopes, blocks and invisible status on replay", async () => {
      const peer: Actor = { ...actor, id: randomUUID() },
        room = randomUUID(),
        message = randomUUID();
      await admin`insert into actors(id,org_id,type,display_name) values(${peer.id},${orgId},'user','Peer')`;
      await admin`insert into threads(id,org_id,kind,subject,created_by_actor_id) values(${room},${orgId},'chat_dm','Private',${actor.id})`;
      await admin`insert into chat_room_settings(thread_id,org_id,name) values(${room},${orgId},'Private')`;
      for (const id of [actor.id, peer.id])
        await admin`insert into permissions(org_id,actor_id,resource_type,resource_id,role,granted_by_actor_id) values(${orgId},${id},'thread',${room},'member',${actor.id})`;
      await admin`insert into messages(id,org_id,thread_id,actor_id,kind,body) values(${message},${orgId},${room},${peer.id},'chat','Sensitive text')`;
      const cursor = (await store.list(actor, Number.MAX_SAFE_INTEGER)).cursor;
      await admin`insert into notifications(org_id,actor_id,verb,object_type,object_id,summary) values(${orgId},${actor.id},'chat.message.created','chat.message',${message},'Private')`;
      expect((await store.list(actor, cursor)).events).toMatchObject([
        { type: "chat.direct", resourceId: message, parentId: room },
      ]);
      expect(
        (await store.list({ ...actor, scopes: ["notifications.read"] }, cursor)).events,
      ).toEqual([]);
      await store.heartbeat(peer, randomUUID(), "active");
      expect(await store.status(actor, [peer.id])).toMatchObject([{ connected: true }]);
      await store.setStatus(peer, {
        availability: "invisible",
        emoji: "",
        text: "",
        expiresAt: null,
      });
      expect(await store.status(actor, [peer.id])).toMatchObject([
        { connected: false, state: "offline", lastSeenAt: null },
      ]);
      // Invisible is a presence preference, not suppression of the sender's messages.
      expect((await store.list(actor, cursor)).events).toHaveLength(1);
      await admin`insert into chat_user_blocks(org_id,blocker_actor_id,blocked_actor_id) values(${orgId},${peer.id},${actor.id})`;
      expect((await store.list(actor, cursor)).events).toEqual([]);
      expect(await store.status(actor, [peer.id])).toEqual([]);
      await admin`delete from chat_user_blocks where org_id=${orgId}`;
      await admin`delete from permissions where actor_id=${actor.id} and resource_id=${room}`;
      expect((await store.list(actor, cursor)).events).toEqual([]);
      expect(await store.status(actor, [peer.id])).toEqual([]);
    });
    it("projects inbound mail once and both approval outcomes without copying content", async () => {
      const thread = randomUUID(),
        message = randomUUID(),
        action = randomUUID();
      const cursor = (await store.list(actor, Number.MAX_SAFE_INTEGER)).cursor;
      await admin`insert into threads(id,org_id,kind,subject,created_by_actor_id) values(${thread},${orgId},'mail','Test',${actor.id})`;
      await admin`insert into messages(id,org_id,thread_id,actor_id,kind,body) values(${message},${orgId},${thread},${actor.id},'mail','')`;
      await admin`insert into permissions(org_id,actor_id,resource_type,resource_id,role,granted_by_actor_id) values(${orgId},${actor.id},'thread',${thread},'owner',${actor.id})`;
      await admin`insert into mail_thread_state(org_id,thread_id,actor_id) values(${orgId},${thread},${actor.id})`;
      await admin`insert into mail_message_deliveries(org_id,message_id,actor_id,received_at) values(${orgId},${message},${actor.id},now())`;
      await admin`update mail_message_deliveries set received_at=now() where message_id=${message}`;
      await admin`insert into pending_actions(id,org_id,actor_id,tool_id,input,expires_at,execution_idempotency_key) values(${action},${orgId},${actor.id},'mail.send','{"secret":"not-in-event"}',now()+interval '1 hour',${action})`;
      await admin`update pending_actions set status='cancelled' where id=${action}`;
      const page = await store.list(actor, cursor);
      expect(page.events.map((event) => event.type)).toEqual([
        "mail.received",
        "approval.requested",
        "approval.updated",
      ]);
      expect(JSON.stringify(page)).not.toContain("not-in-event");
      const fileId = randomUUID();
      await admin`insert into objects(id,org_id,owner_actor_id,kind,storage_key,mime_type,byte_size,sha256,metadata) values(${fileId},${orgId},${actor.id},'mail_attachment',${fileId},'text/plain',12,${"c".repeat(64)},'{"filename":"mail.txt"}')`;
      await admin`insert into mail_attachment_ingestions(org_id,owner_actor_id,object_id,status,storage_key,filename,declared_mime_type,expected_byte_size,actual_byte_size,expected_sha256,actual_sha256,scan_evidence,expires_at) values(${orgId},${actor.id},${fileId},'clean',${fileId},'mail.txt','text/plain',12,12,${"c".repeat(64)},${"c".repeat(64)},'{"scanned":true}',now()+interval '1 hour')`;
      await admin`insert into message_attachments(org_id,message_id,object_id,disposition) values(${orgId},${message},${fileId},'attachment')`;
      const mailEvent = page.events.find((event) => event.type === "mail.received");
      if (!mailEvent) throw new Error("Missing mail event");
      expect((await store.resolve(actor, mailEvent.id)).source?.attachments).toEqual([
        {
          objectId: fileId,
          source: "mail",
          name: "mail.txt",
          mimeType: "text/plain",
          byteSize: 12,
          sha256: "c".repeat(64),
        },
      ]);
      await admin`update mail_attachment_ingestions set cleaned_at=now(),status='rejected',message_id=null,rejected_at=now(),failure_reason='revoked' where object_id=${fileId}`;
      expect((await store.resolve(actor, mailEvent.id)).source?.attachments).toEqual([]);
    });

    it("cannot skip an earlier uncommitted event when writers race", async () => {
      const after = (await store.list(actor, Number.MAX_SAFE_INTEGER)).cursor;
      let release!: () => void, ready!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const first = admin.begin(async (tx) => {
        const id = await notification(tx);
        ready();
        await gate;
        return id;
      });
      await started;
      const second = notification();
      try {
        expect((await store.list(actor, after)).events).toEqual([]);
      } finally {
        release();
      }
      const ids = await Promise.all([first, second]);
      expect((await store.list(actor, after)).events.map((event) => event.resourceId)).toEqual(ids);
    });
    it("closes a subscription before disclosing another event after credential revocation", async () => {
      let allowed = true;
      const server = Fastify(),
        live = new LiveRoutes(app, async () => {
          if (!allowed) throw new Error("Credential revoked");
          return { actor };
        });
      await live.install(server);
      server.post("/mcp", (request, reply) => live.stream(request, reply, true));
      const url = await server.listen({ port: 0, host: "127.0.0.1" });
      const response = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "subscriptions/listen",
          params: { notifications: { resourceSubscriptions: ["helix://events/inbox"] } },
        }),
      });
      if (!response.body) throw new Error("Missing stream");
      const reader = response.body.getReader();
      try {
        await reader.read();
        allowed = false;
        await notification();
        let ended = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          const next = await reader.read();
          if (next.done) {
            ended = true;
            break;
          }
          expect(new TextDecoder().decode(next.value).trim()).toMatch(/^:/u);
        }
        expect(ended).toBe(true);
      } finally {
        await reader.cancel().catch(() => undefined);
        await server.close();
      }
    });
  },
);
