import type postgres from "postgres";

export async function selectPresenceHiddenActors(
  sql: postgres.Sql,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly candidateActorIds: readonly string[];
  },
): Promise<readonly string[]> {
  if (input.candidateActorIds.length === 0) return [];
  const rows = await sql<{ readonly actor_id: string }[]>`
      select actor_id from helix_chat_presence_blocked_actor_ids(
        ${input.orgId}, ${input.actorId}, ${sql.array([...input.candidateActorIds])}::uuid[]
      )
      union select actor_id from actor_status where org_id=${input.orgId} and actor_id<>${input.actorId}
        and actor_id=any(${sql.array([...input.candidateActorIds])}::uuid[])
        and availability='invisible' and (expires_at is null or expires_at>now())
    `;
  return rows.map((row) => row.actor_id);
}
