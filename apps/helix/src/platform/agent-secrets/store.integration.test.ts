import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { TenantEnvelopeCipher } from "../secrets/envelope.js";
import { tenantAwarePostgresSql } from "../tenancy/postgres-roles.js";
import { PostgresAgentSecretStore } from "./store.js";

/**
 * Agent secrets under the runtime database role: values are sealed at rest,
 * only a granted, active agent can open one, and no organization can reach
 * another's.
 */

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const skip =
  skipUnlessLiveDatabase("Agent secret storage through the runtime database role") ||
  adminUrl === undefined ||
  appUrl === undefined;

describe.skipIf(skip)("PostgresAgentSecretStore", () => {
  const admin = postgres(adminUrl ?? "", { max: 1 });
  const app = tenantAwarePostgresSql(postgres(appUrl ?? "", { max: 2 }));
  const store = new PostgresAgentSecretStore(
    app,
    new TenantEnvelopeCipher("agent-secret-store-test-master-secret"),
  );
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const adminId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const foreignAgentId = randomUUID();
  const scope = { orgId, actorId: adminId };
  const delivery = { allowedHosts: [], headerName: "authorization", headerPrefix: "Bearer " };

  beforeAll(async () => {
    for (const id of [orgId, otherOrgId]) {
      await admin`
        insert into orgs (id, slug, display_name, status, tier, region)
        values (${id}, ${`secrets-${id.slice(0, 8)}`}, 'Agent secrets test', 'active', 'personal', 'default')
      `;
    }
    await admin`
      insert into actors (id, org_id, type, display_name) values
        (${adminId}, ${orgId}, 'user', 'Admin'),
        (${agentId}, ${orgId}, 'agent', 'Deploy bot'),
        (${otherAgentId}, ${orgId}, 'service_account', 'Reporting'),
        (${foreignAgentId}, ${otherOrgId}, 'agent', 'Someone else''s bot')
    `;
  });

  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId, otherOrgId]);
    await Promise.all([admin.end(), app.end()]);
  });

  it("seals the value and opens it only for an agent holding a grant", async () => {
    const created = await store.create({
      ...scope,
      ...delivery,
      name: "portal-password",
      description: "Supplier portal",
      mode: "handover",
      value: "hunter2",
    });
    expect(created).toMatchObject({ name: "portal-password", mode: "handover", version: 1 });
    // Stored is not granted: nobody can open it yet.
    expect(created.grants).toEqual([]);
    await expect(
      store.open({ orgId, actorId: agentId, name: "portal-password" }),
    ).resolves.toBeNull();
    const granted = await store.setGrants({ ...scope, id: created.id, actorIds: [agentId] });
    expect(
      granted?.secret.grants.map((grant) => [grant.actorId, grant.displayName, grant.useCount]),
    ).toEqual([[agentId, "Deploy bot", 0]]);
    expect(JSON.stringify([created, granted])).not.toContain("hunter2");

    const [row] = await admin<{ value_ciphertext: string }[]>`
      select value_ciphertext from agent_secrets where id = ${created.id}
    `;
    expect(row?.value_ciphertext).toMatch(/^helix\$1\$/u);
    expect(row?.value_ciphertext).not.toContain("hunter2");

    await expect(
      store.open({ orgId, actorId: agentId, name: "portal-password" }),
    ).resolves.toMatchObject({ value: "hunter2", version: 1 });
    for (const actorId of [otherAgentId, adminId]) {
      await expect(store.open({ orgId, actorId, name: "portal-password" })).resolves.toBeNull();
    }
    // Another organization's agent finds nothing, even asking in this one's name.
    await expect(
      store.open({ orgId: otherOrgId, actorId: foreignAgentId, name: "portal-password" }),
    ).resolves.toBeNull();
    await expect(store.list({ orgId: otherOrgId, actorId: foreignAgentId })).resolves.toEqual([]);
  });

  it("grants only to the organization's own agents and service accounts", async () => {
    const [secret] = await store.list(scope);
    if (secret === undefined) throw new Error("Expected the secret from the first test.");
    for (const actorId of [adminId, foreignAgentId]) {
      await expect(
        store.setGrants({ ...scope, id: secret.id, actorIds: [actorId] }),
      ).rejects.toMatchObject({ code: "not_an_agent" });
    }
    const change = await store.setGrants({ ...scope, id: secret.id, actorIds: [otherAgentId] });
    expect(change).toMatchObject({ added: [otherAgentId], removed: [agentId] });
    await expect(store.open({ orgId, actorId: agentId, name: secret.name })).resolves.toBeNull();

    // A grant stops counting the moment the agent is disabled.
    await admin`update actors set disabled_at = now() where id = ${otherAgentId}`;
    await expect(
      store.open({ orgId, actorId: otherAgentId, name: secret.name }),
    ).resolves.toBeNull();
    await expect(store.listGranted({ orgId, actorId: otherAgentId })).resolves.toEqual([]);
    await admin`update actors set disabled_at = null where id = ${otherAgentId}`;
  });

  it("counts a new value as a new version and refuses a second secret of the same name", async () => {
    const [secret] = await store.list(scope);
    if (secret === undefined) throw new Error("Expected the secret from the first test.");
    await store.recordUse({ orgId, actorId: otherAgentId, secretId: secret.id });
    const rotated = await store.update({ ...scope, id: secret.id, value: "correct horse" });
    expect(rotated).toMatchObject({ version: 2 });
    expect(rotated?.grants[0]).toMatchObject({ actorId: otherAgentId, useCount: 1 });
    await expect(
      store.open({ orgId, actorId: otherAgentId, name: secret.name }),
    ).resolves.toMatchObject({ value: "correct horse" });
    await expect(
      store.create({
        ...scope,
        ...delivery,
        name: secret.name,
        description: "",
        mode: "handover",
        value: "x",
      }),
    ).rejects.toMatchObject({ code: "name_taken" });
  });

  it("will not repoint or unlock a use-only secret without its value", async () => {
    const useOnly = await store.create({
      ...scope,
      ...delivery,
      allowedHosts: ["api.example.com"],
      name: "billing-api",
      description: "",
      mode: "use_only",
      value: "tok_live_abc123",
    });
    for (const change of [{ allowedHosts: ["evil.example.net"] }, { mode: "handover" as const }]) {
      await expect(store.update({ ...scope, id: useOnly.id, ...change })).rejects.toMatchObject({
        code: "value_required",
      });
    }
    // Describing it differently reveals nothing, so that is allowed.
    await expect(
      store.update({ ...scope, id: useOnly.id, description: "Billing API" }),
    ).resolves.toMatchObject({ description: "Billing API", version: 1 });
    await expect(
      store.update({ ...scope, id: useOnly.id, allowedHosts: ["api.example.org"], value: "new" }),
    ).resolves.toMatchObject({ allowedHosts: ["api.example.org"], version: 2 });

    await expect(store.remove({ ...scope, id: useOnly.id })).resolves.toMatchObject({
      name: "billing-api",
    });
    const [grants] = await admin<{ count: number }[]>`
      select count(*)::int as count from agent_secret_grants where secret_id = ${useOnly.id}
    `;
    expect(grants?.count).toBe(0);
  });
});
