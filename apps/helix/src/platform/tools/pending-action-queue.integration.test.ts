import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Actor, ToolDefinition } from "@helix/sdk-types";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PostgresPendingActionStore } from "./pending-actions-postgres-store.js";
import { InMemoryConfirmationGate } from "./registry.js";

describe.skipIf(skipUnlessLiveDatabase("Action queue RLS"))("Action queue RLS", () => {
  const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 1 });
  const sql = tenantAwarePostgresSql(
    postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 2 }),
  );
  const orgId = randomUUID(),
    foreignOrg = randomUUID();
  const owner: Actor = { id: randomUUID(), orgId, type: "user", scopes: [] };
  const agent: Actor = { id: randomUUID(), orgId, type: "agent", scopes: [] };
  const outsider: Actor = { ...owner, id: randomUUID() };
  const foreign: Actor = { ...owner, id: randomUUID(), orgId: foreignOrg, scopes: ["admin.*"] };
  const gate = new InMemoryConfirmationGate(new PostgresPendingActionStore(sql));
  const schema = { parse: (value: unknown) => value, toJsonSchema: () => ({}) };
  const tool: ToolDefinition = {
    id: "test.write",
    description: "Queue test",
    permission: "platform.read",
    sideEffects: "write",
    inputSchema: schema,
    outputSchema: schema,
    handler: async () => ({}),
  };
  beforeAll(async () => {
    for (const org of [orgId, foreignOrg])
      await admin`insert into orgs(id,slug,display_name) values(${org},${org},'Queue test')`;
    for (const person of [owner, agent, outsider, foreign])
      await admin`insert into actors(id,org_id,type,display_name) values(${person.id},${person.orgId},${person.type},'Queue test')`;
  });
  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId, foreignOrg]);
    await Promise.all([admin.end(), sql.end()]);
  });
  const list = (actor: Actor, offset = 0, limit = 1) =>
    withTenantPostgresContext(sql, { orgId: actor.orgId, actorId: actor.id }, () =>
      gate.list({ actor, offset, limit }),
    );
  it("enforces owner/admin authority, tenant separation, exact counts, pagination and expiry", async () => {
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const pending = await withTenantPostgresContext(sql, { orgId, actorId: agent.id }, () =>
        gate.queue({
          tool,
          actor: agent,
          approvalOwnerActorId: owner.id,
          input: { secret: "not-listed" },
        }),
      );
      ids.push(pending.id);
    }
    const first = await list(owner),
      second = await list(owner, 1);
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(1);
    expect(second.total).toBe(3);
    expect(second.items).toHaveLength(1);
    expect(first.items[0]?.id).not.toBe(second.items[0]?.id);
    expect(JSON.stringify(first)).not.toContain("not-listed");
    for (const actor of [agent, outsider, foreign])
      expect(await list(actor)).toEqual({ items: [], total: 0 });
    expect((await list({ ...outsider, scopes: ["admin.agents"] })).total).toBe(3);
    expect((await list({ ...outsider, scopes: ["admin.audit"] })).total).toBe(0);
    await admin`update pending_actions set expires_at=now()-interval '1 second' where id=${ids[0] ?? ""}`;
    expect((await list(owner)).total).toBe(2);
    await withTenantPostgresContext(sql, { orgId, actorId: owner.id }, () =>
      gate.deny({ id: ids[1] ?? "", actor: owner }),
    );
    expect((await list(owner)).total).toBe(1);
    expect(await list(owner, 100)).toMatchObject({ items: [], total: 1 });
    const remaining = (await list(owner)).items[0];
    if (!remaining) throw new Error("Missing remaining request");
    await admin`update pending_actions set requester_principal=to_jsonb(requester_principal::text), preview=to_jsonb(preview::text) where id=${remaining.id}`;
    await admin.unsafe(
      readFileSync(
        new URL("../../db/migrations/0250_pending_action_json.sql", import.meta.url),
        "utf8",
      ),
    );
    const repaired = await list(owner);
    expect(repaired.total).toBe(1);
    expect(repaired.items[0]?.preview).toMatchObject({ toolId: "test.write" });
    expect(
      await withTenantPostgresContext(sql, { orgId, actorId: owner.id }, () =>
        gate.approve({ id: remaining.id, actor: owner }),
      ),
    ).toMatchObject({ status: "approved", approverActorId: owner.id });
  });
});
