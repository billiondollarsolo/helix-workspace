import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { PostgresMailStore } from "./store.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(databaseUrl === undefined)("agent mail identities", () => {
  it("authorizes each machine's own mailbox and rejects impersonation, disabled actors and tenants", async () => {
    const sql = postgres(databaseUrl ?? "", { max: 1 });
    const rollback = new Error("fixture rollback");
    const orgId = randomUUID(),
      agentId = randomUUID(),
      serviceId = randomUUID();
    const domainId = randomUUID(),
      domain = `${orgId}.example.test`;
    try {
      await sql.begin(async (tx) => {
        await tx`insert into orgs (id, slug, display_name) values (${orgId}, ${orgId}, 'Agent mailbox test')`;
        await tx`insert into admin_domains (
          id, org_id, domain, status, verified_at, mail_enabled,
          verification_host, verification_value, verification_expires_at
        ) values (${domainId}, ${orgId}, ${domain}, 'verified', now(), true,
          ${`_helix-verification.${domain}`}, 'fixture', now() + interval '1 day')`;
        await tx`insert into actors (id, org_id, type, email, display_name) values
          (${agentId}, ${orgId}, 'agent', ${`agent@${domain}`}, 'Mail agent'),
          (${serviceId}, ${orgId}, 'service_account', ${`service@${domain}`}, 'Mail service')`;
        await tx.unsafe("set constraints all immediate");
        await expect(
          tx.savepoint(async (nested) => {
            await nested`insert into actors (org_id, type, email, display_name)
            values (${orgId}, 'agent', ${`AGENT@${domain}`}, 'Ambiguous address')`;
          }),
        ).rejects.toMatchObject({ code: "23505" });
        await tx`select set_config('helix.org_id', ${orgId}, true), set_config('helix.actor_id', ${agentId}, true)`;
        await tx.unsafe("set local role helix_app");
        const store = new PostgresMailStore(tx as unknown as postgres.Sql);
        await expect(
          store.resolveAuthorizedSender(orgId, agentId, `agent@${domain}`),
        ).resolves.toBe(`agent@${domain}`);
        await expect(
          store.resolveAuthorizedSender(orgId, serviceId, `service@${domain}`),
        ).resolves.toBe(`service@${domain}`);
        await expect(
          store.resolveAuthorizedSender(orgId, agentId, `service@${domain}`),
        ).resolves.toBeNull();
        await expect(
          store.resolveAuthorizedSender(orgId, agentId, "agent@foreign.example.test"),
        ).resolves.toBeNull();
        await expect(store.resolveInboundRecipients(`agent@${domain}`)).resolves.toEqual([
          { orgId, actorId: agentId, address: `agent@${domain}` },
        ]);
        await expect(store.resolveInboundRecipients(`service@${domain}`)).resolves.toEqual([
          { orgId, actorId: serviceId, address: `service@${domain}` },
        ]);
        await tx.unsafe("reset role");
        await tx`update actors set disabled_at = now() where id = ${agentId}`;
        await expect(
          store.resolveAuthorizedSender(orgId, agentId, `agent@${domain}`),
        ).resolves.toBeNull();
        await expect(store.resolveInboundRecipients(`agent@${domain}`)).resolves.toEqual([]);
        await tx`update orgs set status = 'suspended', suspended_at = now() where id = ${orgId}`;
        await expect(
          store.resolveAuthorizedSender(orgId, serviceId, `service@${domain}`),
        ).resolves.toBeNull();
        await expect(store.resolveInboundRecipients(`service@${domain}`)).resolves.toEqual([]);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await sql.end();
    }
  });
});
