import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(databaseUrl === undefined)("legacy receiving domain upgrade", () => {
  it("preserves catch-all delivery behind canonical domain, membership and quota checks", async () => {
    const sql = postgres(databaseUrl ?? "", { max: 1 });
    const rollback = new Error("fixture rollback");
    const orgId = randomUUID();
    const actorId = randomUUID();
    const domainId = randomUUID();
    const domain = `${orgId}.example.test`;
    try {
      await sql.begin(async (tx) => {
        await tx`insert into orgs (id, slug, display_name) values (${orgId}, ${orgId}, 'Receiving upgrade test')`;
        await tx`insert into admin_domains (
          id, org_id, domain, status, verified_at, is_primary, identity_enabled, mail_enabled,
          verification_host, verification_value, verification_expires_at
        ) values (${domainId}, ${orgId}, ${domain}, 'verified', now(), true, true, true,
          ${`_helix-verification.${domain}`}, 'fixture', now() + interval '1 day')`;
        await tx`insert into actors (id, org_id, type, email, display_name)
          values (${actorId}, ${orgId}, 'user', ${`owner@${domain}`}, 'Receiving owner')`;
        await tx`insert into mail_receiving_domains (
          org_id, admin_domain_id, domain, status, verified_at, catch_all_actor_id
        ) values (${orgId}, ${domainId}, ${domain}, 'active', now(), ${actorId})`;
        const resolve = (address = `unknown@${domain}`) => tx`
          select * from helix_resolve_inbound_mailboxes(${address}, ${domain})
        `;
        await tx.unsafe("set local role helix_app");
        await expect(resolve()).resolves.toEqual([
          { org_id: orgId, actor_id: actorId, address: `owner@${domain}`, quota_exceeded: false },
        ]);
        await expect(resolve(`owner@${domain}`)).resolves.toHaveLength(1);
        await expect(resolve("unknown@foreign.example.test")).resolves.toEqual([]);
        await tx.unsafe("reset role");
        await tx`update orgs set quotas = '{"storage_bytes_limit":0}'::jsonb where id = ${orgId}`;
        expect((await resolve())[0]?.quota_exceeded).toBe(true);
        await tx`update admin_domains set mail_enabled = false where id = ${domainId}`;
        await expect(resolve()).resolves.toEqual([]);
        await tx`update admin_domains set mail_enabled = true where id = ${domainId}`;
        await tx`update organization_memberships set status = 'suspended', suspended_at = now() where org_id = ${orgId} and actor_id = ${actorId}`;
        await expect(resolve()).resolves.toEqual([]);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await sql.end();
    }
  });
});
