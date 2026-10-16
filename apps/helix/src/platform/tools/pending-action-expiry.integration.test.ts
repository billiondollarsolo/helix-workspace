import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "@helix/sdk-types";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { PendingActionExpiryWorker } from "./pending-action-expiry-worker.js";
import { PostgresPendingActionStore } from "./pending-actions-postgres-store.js";
import { InMemoryConfirmationGate } from "./registry.js";

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const enabled = adminUrl !== undefined && appUrl !== undefined;
const admin = enabled ? postgres(adminUrl, { max: 1 }) : null;
const app = enabled ? tenantAwarePostgresSql(postgres(appUrl, { max: 3 })) : null;
const orgs = [randomUUID(), randomUUID(), randomUUID()];
const actors = orgs.map(() => randomUUID());
const schema = { parse: (input: unknown) => input, toJsonSchema: () => ({}) };
const tool: ToolDefinition = {
  id: "test.write",
  description: "Expiry fixture",
  permission: "platform.read",
  sideEffects: "write",
  inputSchema: schema,
  outputSchema: schema,
  handler: async () => ({}),
};

beforeAll(async () => {
  if (admin === null) return;
  for (const [index, orgId] of orgs.entries()) {
    const actorId = actors[index];
    if (actorId === undefined) throw new Error("Missing expiry fixture actor.");
    await admin`insert into orgs (id, slug, display_name) values (${orgId}, ${orgId}, 'Expiry fixture')`;
    await admin`insert into actors (id, org_id, type, display_name) values (${actorId}, ${orgId}, 'agent', 'Expiry fixture')`;
  }
});
afterAll(async () => {
  if (admin === null || app === null) return;
  await cleanupTestTenants(admin, orgs);
  await Promise.all([admin.end(), app.end()]);
});

it.skipIf(!enabled)(
  "expires requests under the runtime RLS role only within enumerated tenants",
  async () => {
    if (app === null || admin === null)
      throw new Error("Expiry tests require runtime and migration connections.");
    const database = app;
    const store = new PostgresPendingActionStore(database);
    const gate = new InMemoryConfirmationGate(store, { confirmationTimeoutMs: 60_000 });
    const now = new Date(Date.now() + 3_600_000);
    const ids: string[] = [];
    for (const [index, orgId] of orgs.entries()) {
      const actorId = actors[index];
      if (actorId === undefined) throw new Error("Missing expiry fixture actor.");
      const request = await withTenantPostgresContext(database, { orgId }, () =>
        gate.queue({ tool, actor: { id: actorId, orgId, type: "agent" }, input: {} }),
      );
      ids.push(request.id);
    }
    const results = await Promise.all(
      [1, 2].map(() =>
        new PendingActionExpiryWorker({
          store,
          now: () => now,
          listOrgIds: async () => orgs.slice(0, 2),
          runForOrg: (orgId, work) => withTenantPostgresContext(database, { orgId }, work),
        }).runOnce(),
      ),
    );
    expect(results.reduce((sum, result) => sum + result.expiredCount, 0)).toBe(2);
    const rows = await admin<
      { id: string; status: string }[]
    >`select id, status from pending_actions where id = any(${admin.array(ids)}::uuid[])`;
    expect(rows.find((row) => row.id === ids[0])?.status).toBe("expired");
    expect(rows.find((row) => row.id === ids[1])?.status).toBe("expired");
    expect(rows.find((row) => row.id === ids[2])?.status).toBe("pending_confirmation");
  },
);
