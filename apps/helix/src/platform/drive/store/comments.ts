import type { JsonObject } from "@helix/sdk-types";
import { BadRequestError } from "../../../api/api-error.js";
import { toSqlJson } from "../../util/sql.js";
import { mentionTokensForComment } from "../core/mentions.js";
import { DriveForbiddenError, DriveNotFoundError } from "../errors.js";
import type { DriveCommentPage, DriveCommentRecord, DriveCommentRevisionPage } from "../types.js";
import { appendDriveActivity } from "./activity.js";
import { assertDriveObjectReady } from "./authz.js";
import { notifyDriveCommentMentions, notifyDriveCommentReply } from "./comment-notifications.js";
import { type DriveStoreContext } from "./context.js";
import { mapDriveComment, mapDriveCommentListItem, mapDriveCommentRevision } from "./mappers.js";
import {
  type DriveCommentCursor,
  type DriveCommentObjectContext,
  type DriveCommentProjectionRow,
  type DriveCommentRevisionRow,
  type DriveCommentRow,
  type SqlLike,
} from "./rows.js";
async function requireReadyDriveCommentObject(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  objectId: string,
  minimumRoleRank: number,
): Promise<DriveCommentObjectContext> {
  const rows = await sql<DriveCommentObjectContext[]>`
    select object.*,
      drive_comment_actor_role_rank(${orgId}, ${objectId}, ${actorId}) as comment_role_rank
    from objects object
    where object.org_id = ${orgId}
      and object.id = ${objectId}
      and object.kind in ('file', 'recording')
      and object.deleted_at is null
    limit 1
  `;
  const object = rows[0];
  if (object === undefined || object.comment_role_rank < 0) {
    throw new DriveNotFoundError(`Unknown or inaccessible Drive object: ${objectId}`);
  }
  assertDriveObjectReady(object);
  if (object.comment_role_rank < minimumRoleRank) {
    throw new DriveForbiddenError(
      `Insufficient permission to comment on Drive object ${objectId}.`,
    );
  }
  return object;
}

async function requireDriveCommentMutation(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  comment: DriveCommentRow,
  operation: "author" | "resolve",
): Promise<DriveCommentObjectContext> {
  const object = await requireReadyDriveCommentObject(sql, orgId, actorId, comment.object_id, 0);
  if (object.comment_role_rank >= 2) {
    return object;
  }
  const permitted =
    operation === "author"
      ? comment.actor_id === actorId
      : await driveCommentThreadOwnerId(sql, orgId, comment.id).then((id) => id === actorId);
  if (!permitted) {
    throw new DriveForbiddenError(
      operation === "author"
        ? "Only the comment author or an editor can change this comment."
        : "Only the thread owner or an editor can resolve this comment thread.",
    );
  }
  return object;
}

async function driveCommentThreadOwnerId(
  sql: SqlLike,
  orgId: string,
  commentId: string,
): Promise<string | null> {
  const rows = await sql<
    {
      readonly actor_id: string | null;
    }[]
  >`
    select drive_comment_thread_owner_id(${orgId}, ${commentId}) as actor_id
  `;
  return rows[0]?.actor_id ?? null;
}

function boundedDriveCommentLimit(limit: number | undefined): number {
  return Math.min(100, Math.max(1, Math.trunc(limit ?? 50)));
}

function encodeDriveCommentCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

function decodeDriveCommentCursor(cursor: string | undefined): DriveCommentCursor | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    const id = Buffer.from(cursor, "base64url").toString("utf8");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
      throw new Error("invalid fields");
    }
    return { id };
  } catch {
    throw new BadRequestError("Invalid Drive comment cursor.");
  }
}

async function requireDriveCommentParent(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly objectId: string;
    readonly parentCommentId: string;
  },
): Promise<void> {
  const rows = await sql<
    {
      readonly id: string;
    }[]
  >`
    select id
    from drive_comments
    where id = ${input.parentCommentId}
      and org_id = ${input.orgId}
      and object_id = ${input.objectId}
      and deleted_at is null
    limit 1
  `;
  if (rows[0] === undefined) {
    throw new Error(`Unknown parent Drive comment: ${input.parentCommentId}`);
  }
}

export async function createComment(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly parentCommentId?: string | undefined;
    readonly body: string;
    readonly anchor?: JsonObject | undefined;
    readonly metadata?: JsonObject | undefined;
  },
): Promise<DriveCommentRecord> {
  return context.sql.begin(async (tx) => {
    const object = await requireReadyDriveCommentObject(
      tx,
      input.orgId,
      input.actorId,
      input.objectId,
      1,
    );
    if (input.parentCommentId !== undefined) {
      await requireDriveCommentParent(tx, {
        orgId: input.orgId,
        objectId: input.objectId,
        parentCommentId: input.parentCommentId,
      });
    }
    const rows = await tx<DriveCommentRow[]>`
        insert into drive_comments
          (org_id, object_id, parent_comment_id, actor_id, anchor, body, metadata,
           changed_by_actor_id)
        values (
          ${input.orgId},
          ${input.objectId},
          ${input.parentCommentId ?? null},
          ${input.actorId},
          ${tx.json(toSqlJson(input.anchor ?? {}))},
          ${input.body},
          ${tx.json(toSqlJson(input.metadata ?? {}))},
          ${input.actorId}
        )
        returning *
      `;
    const comment = mapDriveComment(rows[0]);
    await appendDriveActivity(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      verb: "drive.comment.created",
      objectId: input.objectId,
      payload: { commentId: comment.id, parentCommentId: comment.parentCommentId },
    });
    await notifyDriveCommentMentions(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      object,
      commentId: comment.id,
      parentCommentId: comment.parentCommentId,
      anchor: comment.anchor,
      body: input.body,
      metadata: comment.metadata,
    });
    await notifyDriveCommentReply(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      object,
      commentId: comment.id,
      parentCommentId: comment.parentCommentId,
      body: comment.body,
    });
    return comment;
  });
}

export async function listComments(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly status?: string | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  },
): Promise<DriveCommentPage> {
  await requireReadyDriveCommentObject(context.sql, input.orgId, input.actorId, input.objectId, 0);
  const cursor = decodeDriveCommentCursor(input.cursor);
  const limit = boundedDriveCommentLimit(input.limit);
  const rows = await context.sql<DriveCommentProjectionRow[]>`
      select
        c.*,
        a.display_name as actor_display_name,
        a.email as actor_email
      from drive_comments c
      left join actors a on a.id = c.actor_id and a.org_id = c.org_id
      where c.org_id = ${input.orgId}
        and c.object_id = ${input.objectId}
        and c.deleted_at is null
        ${
          input.status === undefined || input.status === "all"
            ? context.sql``
            : context.sql`and c.status = ${input.status}`
        }
        ${
          cursor === undefined
            ? context.sql``
            : context.sql`and (c.created_at, c.id) > (
                select anchor.created_at, anchor.id
                from drive_comments anchor
                where anchor.org_id = ${input.orgId}
                  and anchor.object_id = ${input.objectId}
                  and anchor.id = ${cursor.id}
              )`
        }
      order by c.created_at asc, c.id asc
      limit ${limit + 1}
    `;
  const comments = rows.slice(0, limit).map(mapDriveCommentListItem);
  const last = comments.at(-1);
  return {
    comments,
    nextCursor:
      rows.length > limit && last !== undefined ? encodeDriveCommentCursor(last.id) : null,
  };
}

export async function listCommentRevisions(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  },
): Promise<DriveCommentRevisionPage> {
  return context.sql.begin(async (tx) => {
    await requireReadyDriveCommentObject(tx, input.orgId, input.actorId, input.objectId, 2);
    const cursor = decodeDriveCommentCursor(input.cursor);
    const limit = boundedDriveCommentLimit(input.limit);
    const rows = await tx<DriveCommentRevisionRow[]>`
        select *
        from drive_comment_revisions
        where org_id = ${input.orgId}
          and object_id = ${input.objectId}
          ${
            cursor === undefined
              ? tx``
              : tx`and (captured_at, id) > (
                  select anchor.captured_at, anchor.id
                  from drive_comment_revisions anchor
                  where anchor.org_id = ${input.orgId}
                    and anchor.object_id = ${input.objectId}
                    and anchor.id = ${cursor.id}
                )`
          }
        order by captured_at asc, id asc
        limit ${limit + 1}
      `;
    const revisions = rows.slice(0, limit).map(mapDriveCommentRevision);
    const last = revisions.at(-1);
    await appendDriveActivity(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      verb: "drive.comment.evidence.exported",
      objectId: input.objectId,
      payload: { returned: revisions.length },
    });
    return {
      revisions,
      nextCursor:
        rows.length > limit && last !== undefined ? encodeDriveCommentCursor(last.id) : null,
    };
  });
}

export async function resolveComment(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  },
): Promise<DriveCommentRecord | null> {
  return context.sql.begin(async (tx) => {
    const existingRows = await tx<DriveCommentRow[]>`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        limit 1
      `;
    const existing = existingRows[0];
    if (existing === undefined) {
      return null;
    }
    await requireDriveCommentMutation(tx, input.orgId, input.actorId, existing, "resolve");
    if (existing.status === "resolved") {
      return mapDriveComment(existing);
    }
    const rows = await tx<DriveCommentRow[]>`
        update drive_comments
        set status = 'resolved', resolved_at = now(), resolved_by_actor_id = ${input.actorId},
            changed_by_actor_id = ${input.actorId}, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        returning *
      `;
    const comment = mapDriveComment(rows[0]);
    await appendDriveActivity(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      verb: "drive.comment.resolved",
      objectId: comment.objectId,
      payload: { commentId: comment.id },
    });
    return comment;
  });
}

export async function reopenComment(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  },
): Promise<DriveCommentRecord | null> {
  return context.sql.begin(async (tx) => {
    const existingRows = await tx<DriveCommentRow[]>`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        limit 1
      `;
    const existing = existingRows[0];
    if (existing === undefined) {
      return null;
    }
    await requireDriveCommentMutation(tx, input.orgId, input.actorId, existing, "resolve");
    if (existing.status === "open") {
      return mapDriveComment(existing);
    }
    const rows = await tx<DriveCommentRow[]>`
        update drive_comments
        set status = 'open', resolved_at = null, resolved_by_actor_id = null,
            changed_by_actor_id = ${input.actorId}, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        returning *
      `;
    const comment = mapDriveComment(rows[0]);
    await appendDriveActivity(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      verb: "drive.comment.reopened",
      objectId: comment.objectId,
      payload: { commentId: comment.id },
    });
    return comment;
  });
}

export async function updateComment(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
    readonly body: string;
  },
): Promise<DriveCommentRecord | null> {
  return context.sql.begin(async (tx) => {
    const existingRows = await tx<DriveCommentRow[]>`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        limit 1
      `;
    const existing = existingRows[0];
    if (existing === undefined) {
      return null;
    }
    const object = await requireDriveCommentMutation(
      tx,
      input.orgId,
      input.actorId,
      existing,
      "author",
    );
    if (existing.body === input.body) {
      return mapDriveComment(existing);
    }
    const rows = await tx<DriveCommentRow[]>`
        update drive_comments
        set body = ${input.body}, changed_by_actor_id = ${input.actorId}, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        returning *
      `;
    const comment = mapDriveComment(rows[0]);
    await appendDriveActivity(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      verb: "drive.comment.updated",
      objectId: comment.objectId,
      payload: { commentId: comment.id },
    });
    const oldTokens = new Set(mentionTokensForComment(existing.metadata, existing.body));
    const addedTokens = mentionTokensForComment(existing.metadata, input.body).filter(
      (token) => !oldTokens.has(token),
    );
    await notifyDriveCommentMentions(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      object,
      commentId: comment.id,
      parentCommentId: comment.parentCommentId,
      anchor: comment.anchor,
      body: comment.body,
      metadata: comment.metadata,
      tokens: addedTokens,
    });
    return comment;
  });
}

export async function deleteComment(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  },
): Promise<DriveCommentRecord | null> {
  return context.sql.begin(async (tx) => {
    const existingRows = await tx<DriveCommentRow[]>`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        limit 1
      `;
    const existing = existingRows[0];
    if (existing === undefined) {
      return null;
    }
    await requireDriveCommentMutation(tx, input.orgId, input.actorId, existing, "author");
    const rows = await tx<DriveCommentRow[]>`
        update drive_comments
        set deleted_at = now(), deleted_by_actor_id = ${input.actorId},
            changed_by_actor_id = ${input.actorId}, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        returning *
      `;
    const comment = mapDriveComment(rows[0]);
    await appendDriveActivity(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      verb: "drive.comment.deleted",
      objectId: comment.objectId,
      payload: { commentId: comment.id },
    });
    return comment;
  });
}
