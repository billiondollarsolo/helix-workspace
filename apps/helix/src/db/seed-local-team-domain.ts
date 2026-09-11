import type postgres from "postgres";
import { ensureAdminDomain } from "../platform/admin/domain-identity.js";

/** Synthetic ownership of the reserved local demo name, never a public DNS claim. */
export async function seedLocalTeamDomain(
  sql: postgres.TransactionSql,
  orgId: string,
  actorId: string,
) {
  const existing =
    await sql`select id from admin_domains where org_id = ${orgId} and domain = 'helix.local' and status <> 'released'`;
  if (existing.length > 0) return; // Preserve subsequent operator changes, including disabling mail.
  const domainId = await ensureAdminDomain(sql, {
    orgId,
    domain: "helix.local",
    createdBy: actorId,
  });
  await sql`update admin_domains set status = 'verified', verified_at = now(),
    identity_enabled = true, mail_enabled = true, updated_at = now(),
    is_primary = not exists (select 1 from admin_domains where org_id = ${orgId} and is_primary)
    where org_id = ${orgId} and id = ${domainId}`;
  await sql`insert into mail_receiving_domains (org_id, admin_domain_id, domain, status, verified_at, created_by)
    values (${orgId}, ${domainId}, 'helix.local', 'active', now(), ${actorId})`;
}
