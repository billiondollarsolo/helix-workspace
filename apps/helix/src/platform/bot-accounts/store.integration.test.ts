import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { BotAccountStore } from "./store.js";
import { PostgresAgentCredentialStore } from "../auth/postgres-store.js";
import { generateApiKey, hashApiKey } from "../auth/credentials.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";

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
    expect(
      (await admin`select id from agent_credentials where api_key_hash=${input.apiKeyHash}`).length,
    ).toBe(0);
    await expect(as(observer, () => store.get(observer, first.id))).rejects.toThrow("unavailable");
    await expect(as(other, () => store.get(other, first.id))).rejects.toThrow("unavailable");
    await expect(
      as(setup, () => store.request(setup, { ...input, displayName: "Changed" })),
    ).rejects.toThrow("different request");
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
