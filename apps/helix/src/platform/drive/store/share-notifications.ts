import type { DriveStoreContext } from "./context.js";
import { type SqlLike } from "./rows.js";

export interface DriveShareNotice {
  readonly title: string;
  readonly role: string;
  readonly objectId: string;
  readonly authorName: string;
  readonly authorEmail: string | null;
  readonly recipients: readonly {
    readonly actorId: string;
    readonly displayName: string | null;
    readonly email: string | null;
  }[];
}

export async function notifyDriveShare(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly resourceType: "object" | "drive_folder";
    readonly targetActorIds: readonly string[];
    readonly role: string;
    readonly message?: string;
  },
): Promise<DriveShareNotice | null> {
  const recipients = [...new Set(input.targetActorIds)].filter((id) => id !== input.actorId);
  if (recipients.length === 0) {
    return null;
  }
  const actors = await loadDriveMailActors(sql, input.orgId, [input.actorId, ...recipients]);
  const author = actors.get(input.actorId);
  const authorName = author?.displayName ?? "Someone";
  const title = await loadDriveItemTitle(sql, input.orgId, input.objectId, input.resourceType);
  const summary = `${authorName} shared "${title}" with you`;
  for (const recipientId of recipients) {
    await sql`insert into notifications (
        org_id, actor_id, verb, object_type, object_id, summary, body, payload
      ) values (
        ${input.orgId}, ${recipientId}, 'drive.object.shared', ${input.resourceType}, ${input.objectId},
        ${summary}, ${input.message ?? null},
        ${sql.json({ sharedByActorId: input.actorId, role: input.role })}
      )`;
  }
  return {
    title,
    role: input.role,
    objectId: input.objectId,
    authorName,
    authorEmail: author?.email ?? null,
    recipients: recipients.map((actorId) => {
      const actor = actors.get(actorId);
      return {
        actorId,
        displayName: actor?.displayName ?? null,
        email: actor?.email ?? null,
      };
    }),
  };
}

export async function deliverDriveMail(
  context: DriveStoreContext,
  task: () => Promise<void>,
): Promise<void> {
  try {
    await task();
  } catch (error) {
    context.options.onShareMailError?.(error);
  }
}

export async function loadDriveMailActors(
  sql: SqlLike,
  orgId: string,
  actorIds: readonly string[],
): Promise<ReadonlyMap<string, { readonly displayName: string; readonly email: string | null }>> {
  const unique = [...new Set(actorIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await sql<
    { id: string; display_name: string; email: string | null }[]
  >`select id, display_name, email from actors
    where org_id = ${orgId} and disabled_at is null
      and id = any(${sql.array(unique)}::uuid[])`;
  return new Map(rows.map((row) => [row.id, { displayName: row.display_name, email: row.email }]));
}

export async function loadDriveItemTitle(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  resourceType: "object" | "drive_folder",
): Promise<string> {
  if (resourceType === "drive_folder") {
    return (
      (
        await sql<{ name: string }[]>`select name from drive_folders
          where org_id = ${orgId} and id = ${objectId}`
      )[0]?.name ?? "a folder"
    );
  }
  return (
    (
      await sql<{ name: string | null }[]>`select metadata->>'name' as name from objects
        where org_id = ${orgId} and id = ${objectId}`
    )[0]?.name ?? "a file"
  );
}
