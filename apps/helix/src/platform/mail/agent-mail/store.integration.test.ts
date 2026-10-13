import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../../test-support/live-suite.js";
import { tenantAwarePostgresSql } from "../../tenancy/postgres-roles.js";
import { PostgresAgentMailStore } from "./store.js";

/**
 * Agent mail under the runtime database role: an administrator gives an agent
 * an address on the organization's own mail domain, and the policy that mail
 * intake reads is the one the administrator saved.
 */

const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL;
const appUrl = process.env.HELIX_RLS_APP_DATABASE_URL;
const skip =
  skipUnlessLiveDatabase("Agent mail storage through the runtime database role") ||
  adminUrl === undefined ||
  appUrl === undefined;

describe.skipIf(skip)("PostgresAgentMailStore", () => {
  const admin = postgres(adminUrl ?? "", { max: 1 });
  const app = tenantAwarePostgresSql(postgres(appUrl ?? "", { max: 2 }));
  const store = new PostgresAgentMailStore(app);
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const adminId = randomUUID();
  const personId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const foreignAgentId = randomUUID();
  const domain = `agent-mail-${orgId.slice(0, 8)}.example`;
  const scope = { orgId, actorId: adminId };
  const open = { receiveMode: "anyone", allowedSenders: [] } as const;

  beforeAll(async () => {
    for (const id of [orgId, otherOrgId]) {
      await admin`
        insert into orgs (id, slug, display_name, status, tier, region)
        values (${id}, ${`agent-mail-${id.slice(0, 8)}`}, 'Agent mail test', 'active', 'personal', 'default')
      `;
    }
    await admin`insert into admin_domains (
        id, org_id, domain, status, verified_at, mail_enabled,
        verification_host, verification_value, verification_expires_at
      ) values (${randomUUID()}, ${orgId}, ${domain}, 'verified', now(), true,
        ${`_helix-verification.${domain}`}, 'fixture', now() + interval '1 day')`;
    await admin`
      insert into actors (id, org_id, type, display_name, email) values
        (${adminId}, ${orgId}, 'user', 'Admin', null),
        (${personId}, ${orgId}, 'user', 'Lee', null),
        (${agentId}, ${orgId}, 'agent', 'Billing bot', null),
        (${otherAgentId}, ${orgId}, 'service_account', 'Reporting', null),
        (${foreignAgentId}, ${otherOrgId}, 'agent', 'Someone else''s bot', null)
    `;
  });

  afterAll(async () => {
    await cleanupTestTenants(admin, [orgId, otherOrgId]);
    await Promise.all([admin.end(), app.end()]);
  });

  it("treats an agent nobody has configured as closed to outside mail", async () => {
    const listed = await store.list(scope);
    expect(listed.domains).toEqual([domain]);
    expect(
      listed.agents.map((agent) => [agent.displayName, agent.address, agent.receiveMode]),
    ).toEqual([
      ["Billing bot", null, "allowed_senders"],
      ["Reporting", null, "allowed_senders"],
    ]);
    const policies = await store.policiesFor(orgId, [agentId, personId]);
    // People have no policy: their mail is never held by this.
    expect([...policies.keys()]).toEqual([agentId]);
    expect(policies.get(agentId)).toEqual({ receiveMode: "allowed_senders", allowedSenders: [] });
  });

  it("gives an agent an address and the policy mail intake then reads", async () => {
    const saved = await store.save({
      ...scope,
      agentId,
      address: `Billing-Bot@${domain}`,
      receiveMode: "allowed_senders",
      allowedSenders: ["ana@partner.example", "@supplier.example"],
    });
    expect(saved).toMatchObject({
      address: `billing-bot@${domain}`,
      receiveMode: "allowed_senders",
      allowedSenders: ["ana@partner.example", "@supplier.example"],
    });
    const resolved = await admin<{ actor_id: string }[]>`
      select actor_id from helix_resolve_inbound_mailboxes(${`billing-bot@${domain}`}, ${domain})
    `;
    expect(resolved.map((row) => row.actor_id)).toEqual([agentId]);
    await expect(store.policiesFor(orgId, [agentId])).resolves.toEqual(
      new Map([
        [
          agentId,
          {
            receiveMode: "allowed_senders",
            allowedSenders: ["ana@partner.example", "@supplier.example"],
          },
        ],
      ]),
    );
    // Taking the address away leaves the policy in place.
    await expect(store.save({ ...scope, agentId, address: null, ...open })).resolves.toMatchObject({
      address: null,
      receiveMode: "anyone",
    });
  });

  it("refuses an address that is taken, off the organization's domains, or not an agent's", async () => {
    await store.save({ ...scope, agentId, address: `billing-bot@${domain}`, ...open });
    for (const [target, address, code] of [
      [otherAgentId, `billing-bot@${domain}`, "address_taken"],
      [otherAgentId, "reporting@elsewhere.example", "domain_not_eligible"],
      [otherAgentId, "not an address", "invalid_address"],
      [personId, `lee@${domain}`, "not_an_agent"],
      [foreignAgentId, `foreign@${domain}`, "not_an_agent"],
    ] as const) {
      await expect(
        store.save({ ...scope, agentId: target, address, ...open }),
      ).rejects.toMatchObject({ code });
    }
    // Another organization sees neither the agents nor their policies.
    await expect(store.policiesFor(otherOrgId, [agentId])).resolves.toEqual(new Map());
  });
});
