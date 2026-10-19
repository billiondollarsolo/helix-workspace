import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { z } from "zod";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { BotAccountStore } from "./store.js";
import { PostgresAgentCredentialStore } from "../auth/postgres-store.js";
import { generateApiKey, hashApiKey } from "../auth/credentials.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { PostgresChatStore } from "../chat/index.js";
import { BotWorkspaceReader } from "./workspace.js";

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
describe.skipIf(!adminUrl || !appUrl)("bot account approval with runtime RLS", () => {
  let admin: postgres.Sql;
  let app: postgres.Sql;
  let store: BotAccountStore;
  const orgId = randomUUID();
  const otherOrg = randomUUID();
  const owner: Actor = {
    id: randomUUID(),
    orgId,
    type: "user",
    scopes: [
      "platform.read",
      "admin.agents",
      "mail.read",
      "mail.write",
      "chat.read",
      "chat.post",
      "drive.read",
      "drive.write",
    ],
  };
  const setup: Actor = {
    id: randomUUID(),
    orgId,
    type: "service_account",
    scopes: ["platform.read", "agent.accounts.request"],
  };
  const observer: Actor = { id: randomUUID(), orgId, type: "user", scopes: ["platform.read"] };
  const other: Actor = {
    id: randomUUID(),
    orgId: otherOrg,
    type: "user",
    scopes: ["platform.read", "admin.agents"],
  };
  const as = <T>(actor: Actor, fn: () => Promise<T>) =>
    withTenantPostgresContext(app, { orgId: actor.orgId, actorId: actor.id }, fn);
  const manifest = () => ({
    externalBotId: randomUUID(),
    displayName: "Integration bot",
    purpose: "Exercise enrollment",
    scopes: ["platform.read", "chat.read"] as ("platform.read" | "chat.read")[],
    apiKeyHash: hashApiKey(generateApiKey()),
  });
  const approval = (id: string) => ({
    requestId: id,
    ownerActorId: owner.id,
    scopes: ["platform.read", "chat.read"] as ("platform.read" | "chat.read")[],
    email: null,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  beforeAll(async () => {
    assert(adminUrl && appUrl);
    admin = postgres(adminUrl, { max: 2, prepare: false });
    app = tenantAwarePostgresSql(postgres(appUrl, { max: 5, prepare: false }));
    store = new BotAccountStore(app, new PostgresAgentCredentialStore(app), () => true);
    for (const id of [orgId, otherOrg])
      await admin`insert into orgs(id,slug,display_name,status) values(${id},${id},'Bot test','active')`;
    for (const actor of [owner, setup, observer, other])
      await admin`insert into actors(id,org_id,type,display_name,scopes) values(${actor.id},${actor.orgId},${actor.type},'Test actor',${admin.array([...(actor.scopes ?? [])])})`;
  });
  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId, otherOrg]);
    await Promise.all([app.end(), admin.end()]);
  });
  it("requires explicitly trusted installation authority, not ordinary platform access", async () => {
    await expect(as(observer, () => store.request(observer, manifest()))).rejects.toThrow(
      "trusted installation",
    );
    await expect(
      as(setup, () => store.request({ ...setup, scopes: ["platform.read"] }, manifest())),
    ).rejects.toThrow("trusted installation");
    await expect(
      as(owner, () => store.request({ ...owner, scopes: ["agent.accounts.request"] }, manifest())),
    ).rejects.toThrow("trusted installation");
  });
  it("deduplicates retries without activating keys and hides requests from other principals", async () => {
    const input = manifest();
    const [first, second] = await Promise.all([
      as(setup, () => store.request(setup, input)),
      as(setup, () => store.request(setup, input)),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.actorId).toBeNull();
    expect(first.status).toBe("pending");
    expect(JSON.stringify(first)).not.toContain(input.apiKeyHash);
    expect(first.keyFingerprint).toBe(createHash("sha256").update(input.apiKeyHash).digest("hex"));
    expect((await as(setup, () => store.get(setup, first.id))).keyFingerprint).toBe(
      first.keyFingerprint,
    );
    expect(
      (await admin`select id from agent_credentials where api_key_hash=${input.apiKeyHash}`).length,
    ).toBe(0);
    await expect(as(observer, () => store.get(observer, first.id))).rejects.toThrow("unavailable");
    await expect(as(other, () => store.get(other, first.id))).rejects.toThrow("unavailable");
    await expect(
      as(setup, () => store.request(setup, { ...input, displayName: "Changed" })),
    ).rejects.toThrow("different request");
  });
  it("finds an older exact request outside the newest 100 without crossing installation or tenant scope", async () => {
    const input = manifest();
    const target = await as(setup, () => store.request(setup, input));
    await admin`update bot_account_requests set created_at=now()-interval '3 days',expires_at=now()+interval '4 days' where org_id=${orgId} and id=${target.id}`;
    await admin`insert into bot_account_requests(org_id,requester_actor_id,external_bot_id,display_name,purpose,requested_scopes,api_key_hash,created_at,expires_at)
      select ${orgId},${setup.id},gen_random_uuid()::text,'Newer request','Historical request',array['platform.read'],lpad(n::text,64,'a'),now()-interval '2 days',now()+interval '5 days'
      from generate_series(1,100) n`;
    const secondSetup = { ...setup, id: randomUUID() };
    await admin`insert into actors(id,org_id,type,display_name,scopes) values(${secondSetup.id},${orgId},'service_account','Other installation',${admin.array([...(setup.scopes ?? [])])})`;
    const otherRequest = await as(secondSetup, () =>
      store.request(secondSetup, {
        ...manifest(),
        externalBotId: input.externalBotId,
      }),
    );
    const latest = await as(setup, () => store.listRequests(setup));
    expect(latest).toHaveLength(100);
    expect(latest.some((row) => row.id === target.id)).toBe(false);
    const filter = { externalBotId: input.externalBotId };
    expect(await as(setup, () => store.listRequests(setup, filter))).toMatchObject([
      { id: target.id },
    ]);
    expect(await as(secondSetup, () => store.listRequests(secondSetup, filter))).toMatchObject([
      { id: otherRequest.id },
    ]);
    expect(await as(observer, () => store.listRequests(observer, filter))).toEqual([]);
    expect(await as(other, () => store.listRequests(other, filter))).toEqual([]);
  });
  it("requires a human admin and creates exactly one account and credential under concurrent approval", async () => {
    const input = manifest();
    const request = await as(setup, () => store.request(setup, input));
    await expect(
      as(setup, () =>
        store.approve({ ...setup, scopes: owner.scopes ?? [] }, approval(request.id)),
      ),
    ).rejects.toThrow("administrator");
    const [first, second] = await Promise.all([
      as(owner, () => store.approve(owner, approval(request.id))),
      as(owner, () => store.approve(owner, approval(request.id))),
    ]);
    assert(first.actorId);
    const botActorId = first.actorId;
    expect(first.actorId).toBe(second.actorId);
    expect(first.status).toBe("approved");
    const rows =
      await admin`select * from agent_credentials where api_key_hash=${input.apiKeyHash}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_id).toBe(first.actorId);
    expect(rows[0]?.approval_owner_actor_id).toBe(owner.id);
    await as(owner, () => store.assertVisible(owner, botActorId));
    await expect(as(observer, () => store.assertVisible(observer, botActorId))).rejects.toThrow(
      "unavailable",
    );
    await as(owner, () => store.grant(owner, botActorId, observer.id, true));
    await as(observer, () => store.assertVisible(observer, botActorId));
    await expect(as(other, () => store.assertVisible(other, botActorId))).rejects.toThrow(
      "unavailable",
    );
    await as(owner, () => store.grant(owner, botActorId, observer.id, false));
    await expect(as(observer, () => store.assertVisible(observer, botActorId))).rejects.toThrow(
      "unavailable",
    );
  });
  it("rolls back identity creation on invalid mail domain and forbids approval scope escalation", async () => {
    const input = {
      ...manifest(),
      email: "test@unverified.test",
      scopes: ["platform.read", "mail.read"] as ("platform.read" | "mail.read")[],
    };
    const request = await as(setup, () => store.request(setup, input));
    await expect(
      as(owner, () =>
        store.approve(owner, { ...approval(request.id), scopes: ["platform.read", "drive.write"] }),
      ),
    ).rejects.toThrow("reduce");
    await expect(
      as(owner, () =>
        store.approve(owner, { ...approval(request.id), scopes: input.scopes, email: input.email }),
      ),
    ).rejects.toThrow();
    expect((await as(setup, () => store.get(setup, request.id))).status).toBe("pending");
    expect(
      (
        await admin`select id from actors where org_id=${orgId} and metadata->>'externalBotId'=${input.externalBotId}`
      ).length,
    ).toBe(0);
  });
  it("pages observed chats with runtime RLS and stops after membership or observation revocation", async () => {
    const request = await as(setup, () => store.request(setup, manifest()));
    const approved = await as(owner, () => store.approve(owner, approval(request.id)));
    assert(approved.actorId);
    const botActorId = approved.actorId;
    await as(owner, () => store.grant(owner, botActorId, observer.id, true));
    const roomIds = Array.from({ length: 52 }, () => randomUUID())
      .sort()
      .reverse();
    for (const id of roomIds) {
      await admin`insert into threads(id,org_id,kind,subject,created_by_actor_id,updated_at)
        values(${id},${orgId},'chat_room','Observed room',${owner.id},'2026-01-01')`;
      await admin`insert into chat_room_settings(thread_id,org_id,name)
        values(${id},${orgId},'Observed room')`;
      await admin`insert into permissions(org_id,actor_id,resource_type,resource_id,role,granted_by_actor_id)
        values(${orgId},${botActorId},'thread',${id},'member',${owner.id})`;
    }
    const roomId = roomIds[0];
    assert(roomId);
    const messageIds = Array.from({ length: 52 }, () => randomUUID())
      .sort()
      .reverse();
    for (const id of messageIds)
      await admin`insert into messages(id,org_id,thread_id,actor_id,kind,body,sent_at)
        values(${id},${orgId},${roomId},${owner.id},'chat','Observed message','2026-01-01')`;
    const reader = new BotWorkspaceReader(store, { chat: new PostgresChatStore(app) });
    const input = { botActorId, surface: "chat", offset: 0 } as const;
    const roomsSchema = z.object({
      rooms: z.array(z.object({ id: z.string() })),
      hasMore: z.boolean(),
    });
    const first = roomsSchema.parse(await as(observer, () => reader.read(observer, input)));
    const second = roomsSchema.parse(
      await as(observer, () => reader.read(observer, { ...input, offset: 50 })),
    );
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect([...first.rooms, ...second.rooms].map(({ id }) => id)).toEqual(roomIds);
    const messagesSchema = z.object({
      messages: z.array(z.object({ id: z.string() })),
      nextCursor: z.string().nullable(),
    });
    const latest = messagesSchema.parse(
      await as(observer, () => reader.read(observer, { ...input, roomId })),
    );
    assert(latest.nextCursor);
    const older = messagesSchema.parse(
      await as(observer, () =>
        reader.read(observer, { ...input, roomId, cursor: latest.nextCursor ?? undefined }),
      ),
    );
    expect([...latest.messages, ...older.messages].map(({ id }) => id)).toEqual(messageIds);
    expect(older.nextCursor).toBeNull();
    await expect(
      as(observer, () => reader.read(observer, { ...input, roomId, cursor: "invalid" })),
    ).rejects.toThrow("cursor is invalid");
    await expect(as(other, () => reader.read(other, input))).rejects.toThrow("unavailable");
    await admin`update permissions set status='revoked',revoked_at=now(),revocation_epoch=1 where org_id=${orgId} and actor_id=${botActorId} and resource_id=${roomId}`;
    await expect(
      as(observer, () =>
        reader.read(observer, { ...input, roomId, cursor: latest.nextCursor ?? undefined }),
      ),
    ).rejects.toThrow("not found");
    await as(owner, () => store.grant(owner, botActorId, observer.id, false));
    await expect(
      as(observer, () => reader.read(observer, { ...input, offset: 50 })),
    ).rejects.toThrow("unavailable");
  });
  it("lists explicit observers for human admins and can revoke a disabled person's grant", async () => {
    const request = await as(setup, () => store.request(setup, manifest()));
    const approved = await as(owner, () => store.approve(owner, approval(request.id)));
    assert(approved.actorId);
    const botId = approved.actorId;
    const ids = Array.from({ length: 51 }, () => randomUUID());
    for (const id of ids) {
      await admin`insert into actors(id,org_id,type,display_name) values(${id},${orgId},'user','Observer')`;
      await as(owner, () => store.grant(owner, botId, id, true));
    }
    const first = await as(owner, () => store.observers(owner, botId, 0));
    const second = await as(owner, () => store.observers(owner, botId, 50));
    expect(first.observers).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(second.observers).toHaveLength(2);
    expect(second.hasMore).toBe(false);
    expect(
      new Set([...first.observers, ...second.observers].map((person) => person.actorId)).size,
    ).toBe(52);
    await expect(as(observer, () => store.observers(observer, botId, 0))).rejects.toThrow(
      "administrator",
    );
    await expect(
      as(setup, () => store.observers({ ...setup, scopes: owner.scopes ?? [] }, botId, 0)),
    ).rejects.toThrow("administrator");
    await expect(as(other, () => store.observers(other, botId, 0))).rejects.toThrow("unavailable");
    const disabledId = ids[0];
    assert(disabledId);
    await admin`update actors set disabled_at=now() where id=${disabledId}`;
    const inventory = await as(owner, () => store.observers(owner, botId, 0));
    expect(inventory.observers.find((person) => person.actorId === disabledId)?.disabled).toBe(
      true,
    );
    await expect(as(owner, () => store.grant(owner, botId, disabledId, true))).rejects.toThrow(
      "active human",
    );
    await as(owner, () => store.grant(owner, botId, disabledId, false));
    expect(
      (
        await admin`select 1 from bot_account_observers where org_id=${orgId} and bot_actor_id=${botId} and observer_actor_id=${disabledId}`
      ).length,
    ).toBe(0);
    const visible = await as(owner, () => store.visible(owner, { botActorId: botId, offset: 0 }));
    expect(visible.map((bot) => bot.id)).toEqual([botId]);
    expect(
      await as(observer, () => store.visible(observer, { botActorId: botId, offset: 0 })),
    ).toEqual([]);
    expect(await as(other, () => store.visible(other, { botActorId: botId, offset: 0 }))).toEqual(
      [],
    );
  });
  it("does not activate expired requests or disabled requesting installations", async () => {
    const request = await as(setup, () => store.request(setup, manifest()));
    await admin`update bot_account_requests set expires_at=now()-interval '1 minute' where id=${request.id}`;
    await expect(as(owner, () => store.approve(owner, approval(request.id)))).rejects.toThrow(
      "pending",
    );
    const disabledRequest = await as(setup, () => store.request(setup, manifest()));
    await admin`update actors set disabled_at=now() where id=${setup.id}`;
    await expect(
      as(owner, () => store.approve(owner, approval(disabledRequest.id))),
    ).rejects.toThrow("requesting installation");
    await admin`update actors set disabled_at=null where id=${setup.id}`;
  });
});
