/**
 * Seed 23 teammate actors for the large workspace seed.
 * IDs live in the b000 group (b000_00000001 .. b000_00000023).
 */

import {
  LARGE_TEAM,
  WORKSPACE_SEED_LARGE_SOURCE,
  json,
  teamId,
  type SeedSql,
} from "./config.js";

export async function seedTeammates(sql: SeedSql, orgId: string): Promise<number> {
  for (const member of LARGE_TEAM) {
    const id = teamId(member.idx);
    await sql`
      insert into actors (id, org_id, type, email, display_name, scopes, disabled_at, metadata)
      values (
        ${id}, ${orgId}, 'user', ${member.email}, ${member.displayName},
        ${sql.array(["platform.read", "mail.read", "chat.read", "calendar.read", "docs.read"], 1009)},
        null,
        ${json(sql, { source: WORKSPACE_SEED_LARGE_SOURCE, title: member.title })}
      )
      on conflict (id) do update
      set org_id      = excluded.org_id,
          email       = excluded.email,
          display_name = excluded.display_name,
          disabled_at  = null,
          metadata     = actors.metadata || excluded.metadata,
          updated_at   = now()
    `;
  }
  return LARGE_TEAM.length;
}
