import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { agentRuntimeConfigSchema, type LiveEvent } from "@helix/contracts";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { AgentRuntimeStore } from "./store.js";
describe.skipIf(skipUnlessLiveDatabase("Hosted agent configuration"))(
  "Hosted agent configuration through RLS",
  () => {
    const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 3 }),
      app = tenantAwarePostgresSql(
        postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 4 }),
      );
    const orgId = randomUUID(),
      otherOrg = randomUUID(),
      agentId = randomUUID(),
      credentialId = randomUUID();
    const owner: Actor = { id: randomUUID(), orgId, type: "user", scopes: ["admin.agents"] },
      agent: Actor = {
        id: agentId,
        orgId,
        type: "agent",
        scopes: ["notifications.read", "assistant.write"],
      },
      outsider: Actor = { id: randomUUID(), orgId, type: "user", scopes: [] };
    const config = agentRuntimeConfigSchema.parse({
      mode: "helix",
      enabled: true,
      credentialId,
      modelId: "test",
      turnsPerHour: 1,
    });
    const store = new AgentRuntimeStore(app);
    beforeAll(async () => {
      for (const id of [orgId, otherOrg])
        await admin`insert into orgs(id,slug,display_name) values(${id},${id},'Runtime test')`;
      for (const actor of [owner, agent, outsider])
        await admin`insert into actors(id,org_id,type,display_name,scopes) values(${actor.id},${actor.orgId},${actor.type},'Runtime test',${admin.array([...(actor.scopes ?? [])])})`;
      await admin`insert into agent_credentials(id,org_id,actor_id,owner_actor_id,credential_type,api_key_hash,scopes,label,purpose,expires_at) values(${credentialId},${orgId},${agentId},${owner.id},'api_key',${randomUUID()},${admin.array([...(agent.scopes ?? [])])},'Test','Test',now()+interval '1 day')`;
      await admin`select helix_append_actor_event(${orgId},${agentId},'notification',${randomUUID()},null)`;
    });
    afterAll(async () => {
      await admin`delete from agent_runtimes where org_id=${orgId}`;
      await cleanupTestTenants(admin, [orgId, otherOrg]);
      await Promise.all([admin.end(), app.end()]);
    });
    it("starts from the current inbox and keeps configuration private to its agent and administrators", async () => {
      const saved = await store.configure(owner, agentId, config, false);
      expect(saved.cursor).toBe(1);
      expect(await store.list(owner)).toHaveLength(1);
      expect(await store.get(agent)).toMatchObject({ actorId: agentId });
      expect(await store.list(outsider)).toEqual([]);
      expect(await store.get({ ...agent, orgId: otherOrg })).toBeNull();
      expect(
        await withTenantPostgresContext(
          app,
          { orgId, actorId: outsider.id },
          (tx) => tx`select * from agent_runtimes`,
        ),
      ).toEqual([]);
      expect(
        await withTenantPostgresContext(app, { orgId, actorId: owner.id }, () =>
          store.candidates(),
        ),
      ).toEqual([]);
    });
    it("rejects credentials from a different actor and missing model-call scope", async () => {
      await expect(store.configure(owner, outsider.id, config, false)).rejects.toThrow(
        "active agent",
      );
      await admin`update agent_credentials set scopes=array['notifications.read'] where id=${credentialId}`;
      await expect(store.configure(owner, agentId, config, false)).rejects.toThrow(
        "assistant.write",
      );
      await admin`update agent_credentials set scopes=${admin.array([...(agent.scopes ?? [])])} where id=${credentialId}`;
    });
    it("atomically claims a turn and refuses duplicate claims, uncertain retries and excess hourly turns", async () => {
      const runtime = await store.get(agent);
      if (!runtime) throw new Error("Missing runtime");
      const event: LiveEvent = {
        id: "one",
        cursor: 2,
        type: "chat.direct",
        resourceId: randomUUID(),
        parentId: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      expect(await store.begin(agent, runtime, event)).toBe(true);
      expect(await store.begin(agent, runtime, event)).toBe(false);
      await expect(store.configure(owner, agentId, config, false)).rejects.toThrow("interrupted");
      await store.complete(agent, event, randomUUID(), true);
      expect(await store.get(agent)).toMatchObject({
        cursor: 2,
        state: "waiting_approval",
        interrupted: false,
      });
      expect(await store.begin(agent, runtime, { ...event, id: "two", cursor: 3 })).toBe(false);
      await admin`update agent_runtimes set window_started_at=now()-interval '2 hours' where actor_id=${agentId}`;
      expect(await store.begin(agent, runtime, { ...event, id: "two", cursor: 3 })).toBe(true);
      await store.fail(agent, "Review interrupted work");
      expect(await store.get(agent)).toMatchObject({
        state: "error",
        cursor: 2,
        interrupted: true,
      });
      const reset = await store.configure(owner, agentId, { ...config, enabled: false }, true);
      expect(reset).toMatchObject({
        cursor: 1,
        lastError: null,
        interrupted: false,
        state: "paused",
      });
    });
  },
);
