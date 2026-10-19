import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { cleanupTestTenants } from "../../../test-support/cleanup-tenants.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { PostgresMailStore } from "../store.js";
import { MailProductivityService } from "./service.js";
import { MailProductivityStore } from "./store.js";

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;

describe.skipIf(!adminUrl || !appUrl)("prepared replies with real mailbox and artifact RLS", () => {
  let admin: postgres.Sql, app: postgres.Sql, mail: PostgresMailStore, store: MailProductivityStore;
  const orgId = randomUUID();
  const owner: Actor = {
    id: randomUUID(),
    orgId,
    type: "user",
    scopes: ["mail.read", "mail.write"],
  };
  const other: Actor = { ...owner, id: randomUUID() };
  const as = <T>(actor: Actor, fn: () => Promise<T>) =>
    withTenantPostgresContext(app, { orgId, actorId: actor.id }, fn);
  beforeAll(async () => {
    assert(adminUrl && appUrl);
    admin = postgres(adminUrl, { max: 2, prepare: false });
    app = tenantAwarePostgresSql(postgres(appUrl, { max: 4, prepare: false }));
    mail = new PostgresMailStore(app);
    store = new MailProductivityStore(app);
    await admin`insert into orgs(id,slug,display_name,status) values(${orgId},${orgId},'Prepared reply regression','active')`;
    for (const actor of [owner, other])
      await admin`insert into actors(id,org_id,type,email,display_name,scopes) values(${actor.id},${orgId},'user',${actor.id + "@example.test"},'Reply test',${admin.array([...(actor.scopes ?? [])])})`;
  });
  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId]);
    await Promise.all([app.end(), admin.end()]);
  });
  async function message(threadId: string) {
    const id = randomUUID();
    await admin`insert into messages(id,org_id,thread_id,kind,body,sent_at,metadata) values(${id},${orgId},${threadId},'mail','Could you review?',clock_timestamp(),${admin.json({ direction: "inbound", from: { address: "sender@example.test" }, to: [{ address: owner.id + "@example.test" }], cc: [], bcc: [], subject: "Private request" })})`;
    await admin`insert into mail_message_deliveries(org_id,message_id,actor_id) values(${orgId},${id},${owner.id})`;
    return id;
  }
  async function thread() {
    const id = randomUUID();
    await admin`insert into threads(id,org_id,kind,subject,created_by_actor_id) values(${id},${orgId},'mail','Private request',${owner.id})`;
    await message(id);
    await admin`insert into mail_thread_state(org_id,actor_id,thread_id,category) values(${orgId},${owner.id},${id},'primary')`;
    return id;
  }
  function preparation(beforeReply: () => Promise<void> = async () => {}) {
    let enabled = true;
    const chat = vi.fn(async () => {
      await beforeReply();
      return { message: "Prepared reply", providerId: "fixture", model: "fixture" };
    });
    const service = new MailProductivityService({
      mail,
      store,
      ai: { chat },
      enabled: async () => enabled,
      classifyThread: async () => "restricted",
    });
    return {
      service,
      chat,
      disable: () => {
        enabled = false;
      },
    };
  }
  it("deduplicates concurrent preparation and preserves an independently edited human draft", async () => {
    const threadId = await thread();
    const draft = await as(owner, () =>
      mail.saveDraft({
        orgId,
        actorId: owner.id,
        threadId,
        idempotencyKey: randomUUID(),
        attachmentObjectIds: [],
        envelope: { bodyText: "Original human draft", to: [], subject: "Private request" },
      }),
    );
    let signalEntered!: () => void, unblock!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const h = preparation(async () => {
      signalEntered();
      await release;
    });
    const first = as(owner, () => h.service.prepareReply(owner, threadId));
    try {
      await Promise.race([
        entered,
        first.then(() => {
          throw new Error("Expected AI preparation to wait");
        }),
      ]);
      expect(await as(owner, () => h.service.prepareReply(owner, threadId))).toMatchObject({
        status: "working",
        text: "",
      });
      await as(owner, () =>
        mail.saveDraft({
          orgId,
          actorId: owner.id,
          id: draft.id,
          threadId,
          expectedRevision: draft.revision,
          idempotencyKey: randomUUID(),
          attachmentObjectIds: [],
          envelope: {
            bodyText: "Human edit during preparation",
            to: [],
            subject: "Private request",
          },
        }),
      );
    } finally {
      unblock();
      await first.catch(() => undefined);
    }
    expect(await first).toMatchObject({ status: "ready", text: "Prepared reply" });
    expect(h.chat).toHaveBeenCalledOnce();
    expect(
      await as(owner, () => mail.getDraft({ orgId, actorId: owner.id, id: draft.id })),
    ).toMatchObject({ revision: 2, envelope: { bodyText: "Human edit during preparation" } });
    expect(await as(other, () => store.recent(other))).toEqual([]);
    await expect(as(other, () => h.service.prepareReply(other, threadId))).rejects.toThrow(
      /unavailable|not found/i,
    );
    expect(h.chat).toHaveBeenCalledOnce();
  });
  it("fails stale prepared text when another message arrives during generation", async () => {
    const threadId = await thread();
    const h = preparation(async () => {
      await message(threadId);
    });
    await expect(as(owner, () => h.service.prepareReply(owner, threadId))).rejects.toThrow(
      "New mail arrived",
    );
    const artifacts = await as(owner, () => store.recent(owner));
    expect(artifacts.filter((row) => row.thread_id === threadId)).toEqual([
      expect.objectContaining({ status: "failed", body: "" }),
    ]);
  });
  it("rechecks AI availability before saving and makes no model call when disabled", async () => {
    const threadId = await thread();
    const h = preparation(async () => {
      h.disable();
    });
    await expect(as(owner, () => h.service.prepareReply(owner, threadId))).rejects.toThrow(
      "disabled",
    );
    expect(
      (await as(owner, () => store.recent(owner))).filter((row) => row.thread_id === threadId),
    ).toEqual([expect.objectContaining({ status: "failed", body: "" })]);
    h.chat.mockClear();
    await expect(as(owner, () => h.service.prepareReply(owner, threadId))).rejects.toThrow(
      "disabled",
    );
    expect(h.chat).not.toHaveBeenCalled();
  });
  it("lets one lease reclaim preparation and prevents its predecessor overwriting the result", async () => {
    const sourceKey = randomUUID();
    const claims = await Promise.all([
      store.claim(owner, { kind: "digest", sourceKey }),
      store.claim(owner, { kind: "digest", sourceKey }),
    ]);
    const first = claims.find((claim) => claim !== null);
    assert(first);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await admin`update mail_productivity_artifacts set lease_until=now()-interval '1 second' where org_id=${orgId} and id=${first.id}`;
    const replacement = await store.claim(owner, { kind: "digest", sourceKey });
    assert(replacement);
    expect(replacement.lease_token).not.toBe(first.lease_token);
    await store.finish(owner, replacement, "Current preparation");
    await store.finish(owner, first, "Stale preparation");
    expect(await as(owner, () => store.find(owner, "digest", sourceKey))).toMatchObject({
      status: "ready",
      body: "Current preparation",
    });
  });
});
