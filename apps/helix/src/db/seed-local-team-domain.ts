import type postgres from "postgres";
import { ensureAdminDomain } from "../platform/admin/domain-identity.js";

import { LOCAL_TEAM_DOMAINS } from "./local-team-fixtures.js";

/** Synthetic ownership of reserved local demo names, never a public DNS claim. */
export async function seedLocalTeamDomain(
  sql: postgres.TransactionSql,
  orgId: string,
  actorId: string,
) {
  for (const [index, domain] of LOCAL_TEAM_DOMAINS.entries()) {
    const existing =
      await sql<{ id: string }[]>`select id from admin_domains where org_id = ${orgId} and domain = ${domain} and status <> 'released'`;
    const domainId =
      existing[0]?.id ??
      (await ensureAdminDomain(sql, {
        orgId,
        domain,
        createdBy: actorId,
      }));
    await sql`update admin_domains set status = 'verified', verified_at = coalesce(verified_at, now()),
      identity_enabled = true, mail_enabled = true, aliases_enabled = true, updated_at = now(),
      is_primary = ${index === 0} or is_primary
      where org_id = ${orgId} and id = ${domainId}`;
    await sql`insert into mail_receiving_domains (org_id, admin_domain_id, domain, status, verified_at, created_by)
      values (${orgId}, ${domainId}, ${domain}, 'active', now(), ${actorId})
      on conflict do nothing`;
  }
}
