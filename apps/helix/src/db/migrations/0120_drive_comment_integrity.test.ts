import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DriveForbiddenError } from "../../platform/drive/errors.js";
import { PostgresDriveStore } from "../../platform/drive/store.js";

const DATABASE_URL = process.env.DATABASE_URL;
const sql = DATABASE_URL === undefined ? null : postgres(DATABASE_URL, { max: 1 });

describe("0120 Drive comment integrity migration", () => {
  it("defines inherited authorization, immutable evidence, tombstones, and forced RLS", async () => {
    const migration = await readFile(
      new URL("./0120_drive_comment_integrity.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("drive_comment_actor_role_rank");
    expect(migration).toContain("resource_type = 'drive_folder'");
    expect(migration).toContain("Only the comment author or an editor");
    expect(migration).toContain("Only an editor or thread owner");
    expect(migration).toContain("create table drive_comment_revisions");
    expect(migration).toContain("after insert on drive_comments");
    expect(migration).toContain("after update on drive_comments");
    expect(migration).toContain("security definer");
    expect(migration).toContain(
      "revoke insert, update, delete, truncate on drive_comment_revisions",
    );
    expect(migration).toContain("alter table drive_comment_revisions force row level security");
    expect(migration).toContain("drive_comments_parent_same_object_fk");
  });
});

describe.skipIf(sql === null)("0120 live Drive comment permission and evidence matrix", () => {
  const database = sql as postgres.Sql;
  const store = new PostgresDriveStore(database);
  const orgId = "d7180000-0000-4000-8000-000000000001";
  const objectId = "d7180000-0000-4000-8000-000000000010";
  const evidenceObjectId = "d7180000-0000-4000-8000-000000000011";
  const otherObjectId = "d7180000-0000-4000-8000-000000000012";
  const parentFolderId = "d7180000-0000-4000-8000-000000000020";
  const childFolderId = "d7180000-0000-4000-8000-000000000021";
  const actors = {
    owner: "d7180000-0000-4000-8000-000000000101",
    editor: "d7180000-0000-4000-8000-000000000102",
    commenter: "d7180000-0000-4000-8000-000000000103",
    reader: "d7180000-0000-4000-8000-000000000104",
    inheritedCommenter: "d7180000-0000-4000-8000-000000000105",
  } as const;

  beforeAll(async () => {
    await cleanup();
    await database`
      insert into orgs (id, slug, display_name, status, tier, region)
      values (${orgId}, 'drv-comment-integrity', 'DRV comment integrity', 'active', 'business', 'test')
    `;
    await database`
      insert into actors (id, org_id, type, display_name, email)
      values
        (${actors.owner}, ${orgId}, 'user', 'Owner', 'owner@drv.test'),
        (${actors.editor}, ${orgId}, 'user', 'Editor', 'editor@drv.test'),
        (${actors.commenter}, ${orgId}, 'user', 'Commenter', 'commenter@drv.test'),
        (${actors.reader}, ${orgId}, 'user', 'Reader', 'reader@drv.test'),
        (${actors.inheritedCommenter}, ${orgId}, 'user', 'Inherited', 'inherited@drv.test')
    `;
    await database`
      insert into drive_folders (id, org_id, parent_folder_id, owner_actor_id, name)
      values
        (${parentFolderId}, ${orgId}, null, ${actors.owner}, 'Parent'),
        (${childFolderId}, ${orgId}, ${parentFolderId}, ${actors.owner}, 'Child')
    `;
    await database`
      insert into objects (
        id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, metadata
      ) values
        (${objectId}, ${orgId}, ${actors.owner}, 'file', 'drv18/matrix', 'text/plain', 1,
          ${database.json({ name: "matrix.txt", folderId: childFolderId, status: "ready" })}),
        (${evidenceObjectId}, ${orgId}, ${actors.owner}, 'file', 'drv18/evidence', 'text/plain', 1,
          ${database.json({ name: "evidence.txt", status: "ready" })}),
        (${otherObjectId}, ${orgId}, ${actors.owner}, 'file', 'drv18/other', 'text/plain', 1,
          ${database.json({ name: "other.txt", status: "ready" })})
    `;
    await database`
      insert into permissions (
        org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
      ) values
        (${orgId}, ${actors.editor}, 'object', ${objectId}, 'editor', ${actors.owner}),
        (${orgId}, ${actors.commenter}, 'object', ${objectId}, 'commenter', ${actors.owner}),
        (${orgId}, ${actors.reader}, 'object', ${objectId}, 'reader', ${actors.owner}),
        (${orgId}, ${actors.inheritedCommenter}, 'drive_folder', ${parentFolderId}, 'commenter', ${actors.owner}),
        (${orgId}, ${actors.editor}, 'object', ${evidenceObjectId}, 'editor', ${actors.owner}),
        (${orgId}, ${actors.commenter}, 'object', ${evidenceObjectId}, 'commenter', ${actors.owner}),
        (${orgId}, ${actors.reader}, 'object', ${evidenceObjectId}, 'reader', ${actors.owner}),
        (${orgId}, ${actors.commenter}, 'object', ${otherObjectId}, 'commenter', ${actors.owner})
    `;
  });

  afterAll(async () => {
    await cleanup();
    await database.end();
  });

  async function cleanup(): Promise<void> {
    await database`delete from notifications where org_id = ${orgId}`;
    await database`delete from outbox where payload->>'orgId' = ${orgId}`;
    await database`delete from activity where org_id = ${orgId}`;
    await database`delete from permissions where org_id = ${orgId}`;
    await database`delete from objects where org_id = ${orgId}`;
    await database`delete from drive_folders where org_id = ${orgId}`;
    await database`delete from organization_memberships where org_id = ${orgId}`;
    await database`delete from actors where org_id = ${orgId}`;
    await database`delete from orgs where id = ${orgId}`;
    await database`delete from identity_subjects where id in ${database(Object.values(actors))}`;
  }

  async function setObjectRole(actorId: string, role: string): Promise<void> {
    await database`
      update permissions set role = ${role}, updated_at = now()
      where org_id = ${orgId}
        and actor_id = ${actorId}
        and resource_type = 'object'
        and resource_id = ${objectId}
    `;
  }

  async function createComment(
    actorId: string,
    body: string,
    targetObjectId = objectId,
    parentCommentId?: string,
  ) {
    return store.createComment({
      orgId,
      actorId,
      objectId: targetObjectId,
      body,
      anchor: {},
      metadata: {},
      ...(parentCommentId === undefined ? {} : { parentCommentId }),
    });
  }

  async function createAuthoredComment(actorId: string, body: string) {
    if (actorId !== actors.reader) {
      return createComment(actorId, body);
    }
    await setObjectRole(actorId, "commenter");
    const comment = await createComment(actorId, body);
    await setObjectRole(actorId, "reader");
    return comment;
  }

  function otherAuthor(actorId: string): string {
    return actorId === actors.owner ? actors.commenter : actors.owner;
  }

  it("allows commenter creation, including an inherited ancestor-folder grant", async () => {
    for (const actorId of [
      actors.owner,
      actors.editor,
      actors.commenter,
      actors.inheritedCommenter,
    ]) {
      await expect(createComment(actorId, `created-${actorId}`)).resolves.toMatchObject({
        actorId,
      });
    }
    await expect(createComment(actors.reader, "reader denied")).rejects.toBeInstanceOf(
      DriveForbiddenError,
    );
  });

  it("enforces author-or-editor for update and delete across every role", async () => {
    const matrix = [
      { actorId: actors.owner, canChangeOther: true },
      { actorId: actors.editor, canChangeOther: true },
      { actorId: actors.commenter, canChangeOther: false },
      { actorId: actors.reader, canChangeOther: false },
      { actorId: actors.inheritedCommenter, canChangeOther: false },
    ] as const;

    for (const entry of matrix) {
      const own = await createAuthoredComment(entry.actorId, `own-update-${entry.actorId}`);
      await expect(
        store.updateComment({
          orgId,
          actorId: entry.actorId,
          commentId: own.id,
          body: "own updated",
        }),
      ).resolves.toMatchObject({ body: "own updated" });

      const other = await createAuthoredComment(
        otherAuthor(entry.actorId),
        `other-update-${entry.actorId}`,
      );
      const update = store.updateComment({
        orgId,
        actorId: entry.actorId,
        commentId: other.id,
        body: "other updated",
      });
      if (entry.canChangeOther) {
        await expect(update).resolves.toMatchObject({ body: "other updated" });
      } else {
        await expect(update).rejects.toBeInstanceOf(DriveForbiddenError);
      }

      const ownDelete = await createAuthoredComment(entry.actorId, `own-delete-${entry.actorId}`);
      await expect(
        store.deleteComment({ orgId, actorId: entry.actorId, commentId: ownDelete.id }),
      ).resolves.toMatchObject({ id: ownDelete.id });

      const otherDelete = await createAuthoredComment(
        otherAuthor(entry.actorId),
        `other-delete-${entry.actorId}`,
      );
      const deletion = store.deleteComment({
        orgId,
        actorId: entry.actorId,
        commentId: otherDelete.id,
      });
      if (entry.canChangeOther) {
        await expect(deletion).resolves.toMatchObject({ id: otherDelete.id });
      } else {
        await expect(deletion).rejects.toBeInstanceOf(DriveForbiddenError);
      }
    }
  });

  it("enforces editor-or-root-thread-owner for resolve and reopen", async () => {
    const matrix = [
      { actorId: actors.owner, canResolveOther: true },
      { actorId: actors.editor, canResolveOther: true },
      { actorId: actors.commenter, canResolveOther: false },
      { actorId: actors.reader, canResolveOther: false },
      { actorId: actors.inheritedCommenter, canResolveOther: false },
    ] as const;

    for (const entry of matrix) {
      const ownRoot = await createAuthoredComment(entry.actorId, `own-root-${entry.actorId}`);
      await expect(
        store.resolveComment({ orgId, actorId: entry.actorId, commentId: ownRoot.id }),
      ).resolves.toMatchObject({ status: "resolved" });
      await expect(
        store.reopenComment({ orgId, actorId: entry.actorId, commentId: ownRoot.id }),
      ).resolves.toMatchObject({ status: "open" });

      const otherRoot = await createAuthoredComment(
        otherAuthor(entry.actorId),
        `other-root-${entry.actorId}`,
      );
      await store.resolveComment({
        orgId,
        actorId: actors.owner,
        commentId: otherRoot.id,
      });
      const reopen = store.reopenComment({
        orgId,
        actorId: entry.actorId,
        commentId: otherRoot.id,
      });
      if (entry.canResolveOther) {
        await expect(reopen).resolves.toMatchObject({ status: "open" });
      } else {
        await expect(reopen).rejects.toBeInstanceOf(DriveForbiddenError);
      }
    }

    const root = await createComment(actors.commenter, "root owned by commenter");
    const reply = await createComment(
      actors.inheritedCommenter,
      "reply owned by another commenter",
      objectId,
      root.id,
    );
    await expect(
      store.resolveComment({
        orgId,
        actorId: actors.inheritedCommenter,
        commentId: reply.id,
      }),
    ).rejects.toBeInstanceOf(DriveForbiddenError);
  });

  it("pages normal comments, hides tombstones, and exports complete immutable evidence", async () => {
    const first = await createComment(actors.owner, "original @nobody", evidenceObjectId);
    await createComment(actors.owner, "second", evidenceObjectId);
    await createComment(actors.owner, "third", evidenceObjectId);

    const pageOne = await store.listComments({
      orgId,
      actorId: actors.reader,
      objectId: evidenceObjectId,
      limit: 2,
    });
    expect(pageOne.comments).toHaveLength(2);
    expect(pageOne.nextCursor).not.toBeNull();
    const pageTwo = await store.listComments({
      orgId,
      actorId: actors.reader,
      objectId: evidenceObjectId,
      cursor: pageOne.nextCursor ?? undefined,
      limit: 2,
    });
    expect(pageTwo.comments).toHaveLength(1);
    expect(pageTwo.nextCursor).toBeNull();

    await store.updateComment({
      orgId,
      actorId: actors.owner,
      commentId: first.id,
      body: "updated @reader",
    });
    await store.resolveComment({ orgId, actorId: actors.owner, commentId: first.id });
    await store.deleteComment({ orgId, actorId: actors.owner, commentId: first.id });

    const visible = await store.listComments({
      orgId,
      actorId: actors.reader,
      objectId: evidenceObjectId,
      limit: 100,
    });
    expect(visible.comments.map((comment) => comment.id)).not.toContain(first.id);

    const evidence = await store.listCommentRevisions({
      orgId,
      actorId: actors.editor,
      objectId: evidenceObjectId,
      limit: 100,
    });
    const firstHistory = evidence.revisions.filter((revision) => revision.commentId === first.id);
    expect(firstHistory.map((revision) => revision.changeKind)).toEqual([
      "created",
      "edited",
      "resolved",
      "deleted",
    ]);
    expect(firstHistory.map((revision) => revision.body)).toEqual([
      "original @nobody",
      "updated @reader",
      "updated @reader",
      "updated @reader",
    ]);
    const evidencePageOne = await store.listCommentRevisions({
      orgId,
      actorId: actors.editor,
      objectId: evidenceObjectId,
      limit: 2,
    });
    expect(evidencePageOne.revisions).toHaveLength(2);
    expect(evidencePageOne.nextCursor).not.toBeNull();
    const evidencePageTwo = await store.listCommentRevisions({
      orgId,
      actorId: actors.editor,
      objectId: evidenceObjectId,
      cursor: evidencePageOne.nextCursor ?? undefined,
      limit: 2,
    });
    expect(evidencePageTwo.revisions).toHaveLength(2);
    expect(evidencePageTwo.revisions[0]?.id).not.toBe(evidencePageOne.revisions[0]?.id);
    await expect(
      store.listCommentRevisions({
        orgId,
        actorId: actors.reader,
        objectId: evidenceObjectId,
      }),
    ).rejects.toBeInstanceOf(DriveForbiddenError);

    const tombstones = await database<{ deleted_at: Date | null }[]>`
      select deleted_at from drive_comments where id = ${first.id}
    `;
    expect(tombstones[0]?.deleted_at).not.toBeNull();
    const mentions = await database<{ actor_id: string }[]>`
      select actor_id from notifications
      where org_id = ${orgId}
        and verb = 'drive.comment.mention'
        and payload->>'commentId' = ${first.id}
    `;
    expect(mentions).toEqual([{ actor_id: actors.reader }]);
    const audit = await database<{ verb: string }[]>`
      select verb from activity
      where org_id = ${orgId} and payload->>'commentId' = ${first.id}
      order by created_at
    `;
    expect(audit.map((row) => row.verb)).toEqual([
      "drive.comment.created",
      "drive.comment.updated",
      "drive.comment.resolved",
      "drive.comment.deleted",
    ]);
    await expect(
      database<{ count: number }[]>`
        select count(*)::integer as count from activity
        where org_id = ${orgId} and verb = 'drive.comment.evidence.exported'
      `,
    ).resolves.toMatchObject([{ count: 3 }]);
  });

  it("blocks direct runtime-role bypasses and cross-object reply forgery", async () => {
    const protectedComment = await createComment(actors.owner, "protected", evidenceObjectId);

    const runtimeCommentRows = await database.begin(async (tx) => {
      await tx.unsafe("set local role helix_app");
      await tx`select set_config('helix.org_id', ${orgId}, true)`;
      await tx`select set_config('helix.actor_id', ${actors.commenter}, true)`;
      return tx<{ id: string }[]>`
        insert into drive_comments (
          org_id, object_id, actor_id, anchor, body, metadata, changed_by_actor_id
        ) values (
          ${orgId}, ${evidenceObjectId}, ${actors.commenter}, '{}'::jsonb,
          'runtime role comment', '{}'::jsonb, ${actors.commenter}
        ) returning id
      `;
    });
    const runtimeCommentId = runtimeCommentRows[0]?.id;
    if (runtimeCommentId === undefined) {
      throw new Error("Expected a restricted-role Drive comment insert.");
    }
    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgId}, true)`;
        await tx`select set_config('helix.actor_id', ${actors.editor}, true)`;
        return tx<{ count: number }[]>`
          select count(*)::integer as count from drive_comment_revisions
          where comment_id = ${runtimeCommentId}
        `;
      }),
    ).resolves.toEqual([{ count: 1 }]);
    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgId}, true)`;
        await tx`select set_config('helix.actor_id', ${actors.reader}, true)`;
        return tx<{ count: number }[]>`
          select count(*)::integer as count from drive_comment_revisions
          where comment_id = ${runtimeCommentId}
        `;
      }),
    ).resolves.toEqual([{ count: 0 }]);

    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgId}, true)`;
        await tx`select set_config('helix.actor_id', ${actors.editor}, true)`;
        return tx`
          update drive_comments
          set body = 'editor update', changed_by_actor_id = ${actors.editor}
          where id = ${protectedComment.id}
          returning revision
        `;
      }),
    ).resolves.toMatchObject([{ revision: "2" }]);

    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgId}, true)`;
        await tx`select set_config('helix.actor_id', ${actors.reader}, true)`;
        await tx`
          insert into drive_comments (
            org_id, object_id, actor_id, anchor, body, metadata, changed_by_actor_id
          ) values (
            ${orgId}, ${evidenceObjectId}, ${actors.reader}, '{}'::jsonb,
            'forged', '{}'::jsonb, ${actors.reader}
          )
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgId}, true)`;
        await tx`select set_config('helix.actor_id', ${actors.commenter}, true)`;
        await tx`
          insert into drive_comments (
            org_id, object_id, actor_id, anchor, body, status, metadata,
            resolved_at, resolved_by_actor_id, changed_by_actor_id
          ) values (
            ${orgId}, ${evidenceObjectId}, ${actors.commenter}, '{}'::jsonb,
            'pre-resolved', 'resolved', '{}'::jsonb, now(), ${actors.commenter},
            ${actors.commenter}
          )
        `;
      }),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgId}, true)`;
        await tx`select set_config('helix.actor_id', ${actors.editor}, true)`;
        await tx`
          insert into drive_comment_revisions (
            org_id, object_id, comment_id, revision, change_kind, parent_comment_id,
            comment_actor_id, anchor, body, status, metadata, resolved_at,
            resolved_by_actor_id, deleted_at, deleted_by_actor_id, changed_by_actor_id
          )
          select
            org_id, object_id, id, 999, 'edited', parent_comment_id,
            actor_id, anchor, 'forged evidence', status, metadata, resolved_at,
            resolved_by_actor_id, deleted_at, deleted_by_actor_id, ${actors.editor}
          from drive_comments where id = ${protectedComment.id}
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });

    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgId}, true)`;
        await tx`select set_config('helix.actor_id', ${actors.reader}, true)`;
        await tx`
          update drive_comments set updated_at = now()
          where id = ${protectedComment.id}
        `;
      }),
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgId}, true)`;
        await tx`select set_config('helix.actor_id', ${actors.commenter}, true)`;
        await tx`
          update drive_comments
          set body = 'forged', changed_by_actor_id = ${actors.commenter}
          where id = ${protectedComment.id}
        `;
      }),
    ).rejects.toMatchObject({ code: "42501" });

    const revisionId = await database<{ id: string }[]>`
      select id from drive_comment_revisions
      where comment_id = ${protectedComment.id}
      order by revision limit 1
    `;
    const immutableRevisionId = revisionId[0]?.id;
    if (immutableRevisionId === undefined) {
      throw new Error("Expected immutable Drive comment evidence.");
    }
    await expect(
      database.begin(async (tx) => {
        await tx.unsafe("set local role helix_app");
        await tx`select set_config('helix.org_id', ${orgId}, true)`;
        await tx`select set_config('helix.actor_id', ${actors.editor}, true)`;
        await tx`update drive_comment_revisions set body = 'rewritten' where id = ${immutableRevisionId}`;
      }),
    ).rejects.toMatchObject({ code: "42501" });

    const otherComment = await createComment(actors.commenter, "other object", otherObjectId);
    await expect(
      database`
        insert into drive_comments (
          org_id, object_id, parent_comment_id, actor_id, anchor, body, metadata,
          changed_by_actor_id
        ) values (
          ${orgId}, ${objectId}, ${otherComment.id}, ${actors.commenter}, '{}'::jsonb,
          'cross-object reply', '{}'::jsonb, ${actors.commenter}
        )
      `,
    ).rejects.toMatchObject({ code: "23503" });
  });
});
