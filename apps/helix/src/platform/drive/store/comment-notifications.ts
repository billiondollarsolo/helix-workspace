import type { JsonObject } from "@helix/sdk-types";
import { insertNotification } from "../../notifications/index.js";
import { stringMetadata } from "../core/mappers.js";
import { mentionedActorIds, mentionTokensForComment } from "../core/mentions.js";
import { type ObjectRow, type SqlLike } from "./rows.js";
export async function notifyDriveCommentMentions(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly object: ObjectRow;
    readonly commentId: string;
    readonly parentCommentId: string | null;
    readonly anchor: JsonObject;
    readonly body: string;
    readonly metadata: JsonObject;
    readonly tokens?: readonly string[] | undefined;
  },
): Promise<void> {
  const tokens = input.tokens ?? mentionTokensForComment(input.metadata, input.body);
  if (tokens.length === 0) {
    return;
  }
  const actorRows = await sql<
    {
      readonly id: string;
      readonly display_name: string;
      readonly email: string | null;
    }[]
  >`
    select id, display_name, email
    from actors
    where org_id = ${input.orgId}
      and disabled_at is null
      and type = 'user'
      and drive_comment_actor_role_rank(${input.orgId}, ${input.object.id}, actors.id) >= 0
  `;
  const recipients = mentionedActorIds({
    actors: actorRows,
    authorActorId: input.actorId,
    tokens,
  });
  if (recipients.length === 0) {
    return;
  }
  const authorName =
    actorRows.find((actor) => actor.id === input.actorId)?.display_name ?? "Someone";
  const title = driveObjectNotificationTitle(input.object);
  const app = stringMetadata(input.object.metadata, "app");
  for (const recipientId of recipients) {
    await insertNotification(sql, {
      orgId: input.orgId,
      actorId: recipientId,
      verb: "drive.comment.mention",
      objectType: "drive.object",
      objectId: input.object.id,
      summary: `${authorName} mentioned you in "${title}".`,
      body: input.body,
      payload: {
        objectId: input.object.id,
        commentId: input.commentId,
        ...(input.parentCommentId === null ? {} : { parentCommentId: input.parentCommentId }),
        anchor: input.anchor,
        mentionedByActorId: input.actorId,
        mentionsText: tokens,
        ...(app === undefined ? {} : { app }),
      },
    });
  }
}

export async function notifyDriveCommentReply(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly object: ObjectRow;
    readonly commentId: string;
    readonly parentCommentId: string | null;
    readonly body: string;
  },
): Promise<void> {
  if (input.parentCommentId === null) {
    return;
  }
  const rows = await sql<
    {
      readonly actor_id: string;
    }[]
  >`
    select parent.actor_id
    from drive_comments parent
    where parent.org_id = ${input.orgId}
      and parent.object_id = ${input.object.id}
      and parent.id = ${input.parentCommentId}
      and parent.deleted_at is null
      and parent.actor_id is not null
      and parent.actor_id <> ${input.actorId}
      and drive_comment_actor_role_rank(
        ${input.orgId}, ${input.object.id}, parent.actor_id
      ) >= 0
      and not exists (
        select 1 from notifications notification
        where notification.org_id = ${input.orgId}
          and notification.actor_id = parent.actor_id
          and notification.payload->>'commentId' = ${input.commentId}
      )
    limit 1
  `;
  const recipientId = rows[0]?.actor_id;
  if (recipientId === undefined) {
    return;
  }
  await insertNotification(sql, {
    orgId: input.orgId,
    actorId: recipientId,
    verb: "drive.comment.reply",
    objectType: "drive.object",
    objectId: input.object.id,
    summary: `Someone replied to your comment in "${driveObjectNotificationTitle(input.object)}".`,
    body: input.body,
    payload: {
      objectId: input.object.id,
      commentId: input.commentId,
      parentCommentId: input.parentCommentId,
      repliedByActorId: input.actorId,
    },
  });
}

function driveObjectNotificationTitle(object: ObjectRow): string {
  return (
    stringMetadata(object.metadata, "title") ??
    stringMetadata(object.metadata, "name") ??
    stringMetadata(object.metadata, "filename") ??
    object.storage_key.split("/").at(-1) ??
    "Drive object"
  );
}
