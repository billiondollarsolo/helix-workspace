import { type SqlLike } from "./rows.js";

export async function notifyDriveShare(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly resourceType: "object" | "drive_folder";
    readonly targetActorIds: readonly string[];
    readonly role: string;
  },
): Promise<void> {
  const recipients = [...new Set(input.targetActorIds)].filter((id) => id !== input.actorId);
  if (recipients.length === 0) {
    return;
  }
  const actors = await sql<
    { id: string; display_name: string }[]
  >`select id, display_name from actors
    where org_id = ${input.orgId} and disabled_at is null
      and id = any(${sql.array([input.actorId, ...recipients])}::uuid[])`;
  const authorName = actors.find((actor) => actor.id === input.actorId)?.display_name ?? "Someone";
  const title =
    input.resourceType === "drive_folder"
      ? ((
          await sql<{ name: string }[]>`select name from drive_folders
            where org_id = ${input.orgId} and id = ${input.objectId}`
        )[0]?.name ?? "a folder")
      : ((
          await sql<{ name: string | null }[]>`select metadata->>'name' as name from objects
            where org_id = ${input.orgId} and id = ${input.objectId}`
        )[0]?.name ?? "a file");
  for (const recipientId of recipients) {
    await sql`insert into notifications (
        org_id, actor_id, verb, object_type, object_id, summary, body, payload
      ) values (
        ${input.orgId}, ${recipientId}, 'drive.object.shared', ${input.resourceType}, ${input.objectId},
        ${`${authorName} shared "${title}" with you`}, ${null},
        ${sql.json({ sharedByActorId: input.actorId, role: input.role })}
      )`;
  }
}
