import { withTenantIoSagaPostgresContext as withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { toSqlJson } from "../../util/sql.js";
import { DriveForbiddenError } from "../errors.js";
import type { DriveEntryRecord } from "../types.js";
import { appendDriveActivity } from "./activity.js";
import {
  requireFolderAddChildren,
  requireFolderRole,
  requireFolderRoleIncludingDeleted,
} from "./authz.js";
import { type DriveStoreContext } from "./context.js";
import { type DriveFolderCreateInput } from "./contracts.js";
import { deleteEntry } from "./lifecycle.js";
import { mapFolderEntry, missingFolderRow } from "./mappers.js";
import { type DriveFolderRow, type SqlLike } from "./rows.js";
async function grantFolderAccess(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
    readonly role: string;
    readonly grantedByActorId: string;
  },
): Promise<void> {
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values (${input.orgId}, ${input.actorId}, 'drive_folder', ${input.folderId}, ${input.role}, ${input.grantedByActorId})
    on conflict do nothing
  `;
}

export async function createFolder(
  context: DriveStoreContext,
  input: DriveFolderCreateInput,
): Promise<DriveEntryRecord> {
  return context.sql.begin(async (tx) => {
    if (input.parentFolderId !== undefined && input.parentFolderId !== null) {
      await requireFolderAddChildren(tx, input.orgId, input.actorId, input.parentFolderId);
    }
    const rows = await tx<DriveFolderRow[]>`
        insert into drive_folders (
          org_id,
          name,
          parent_folder_id,
          owner_actor_id,
          created_by_actor_id,
          metadata
        )
        values (
          ${input.orgId},
          ${input.name},
          ${input.parentFolderId ?? null},
          ${input.actorId},
          ${input.actorId},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `;
    const folder = mapFolderEntry(rows[0] ?? missingFolderRow());
    await grantFolderAccess(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      folderId: folder.id,
      role: folder.ownerActorId === null ? "editor" : "owner",
      grantedByActorId: input.actorId,
    });
    await appendDriveActivity(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      verb: "drive.folder.created",
      objectId: folder.id,
      payload: { name: input.name, parentFolderId: input.parentFolderId ?? null },
    });
    return folder;
  });
}

export async function trashFolder(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
  },
): Promise<DriveEntryRecord | null> {
  return withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    async (tx) => {
      await requireFolderRole(tx, input.orgId, input.actorId, input.folderId, "editor");
      const rows = await tx<
        (DriveFolderRow & {
          readonly trashed_file_ids: readonly string[];
        })[]
      >`
        with recursive folder_tree as (
          select *
          from drive_folders
          where id = ${input.folderId}
            and org_id = ${input.orgId}
            and deleted_at is null
          union all
          select child.*
          from drive_folders child
          join folder_tree parent on child.parent_folder_id = parent.id
          where child.org_id = ${input.orgId}
            and child.deleted_at is null
        ),
        unauthorized as (
          select folder.id
          from folder_tree folder
          where coalesce(helix_drive_effective_role(
            ${input.orgId}, ${input.actorId}, 'drive_folder', folder.id
          ), '') not in ('editor', 'owner')
          union all
          select object.id
          from objects object
          where object.org_id = ${input.orgId}
            and object.kind = 'file'
            and object.deleted_at is null
            and object.metadata->>'folderId' in (select id::text from folder_tree)
            and coalesce(helix_drive_effective_role(
              ${input.orgId}, ${input.actorId}, 'object', object.id
            ), '') not in ('editor', 'owner')
        ),
        trashed_files as (
          update objects
          set deleted_at = now(),
              metadata = metadata || jsonb_build_object('trashRootFolderId', ${input.folderId}::text),
              updated_at = now()
          where org_id = ${input.orgId}
            and kind = 'file'
            and deleted_at is null
            and metadata->>'folderId' in (select id::text from folder_tree)
            and not exists (select 1 from unauthorized)
          returning id, metadata
        ),
        trashed_folders as (
          update drive_folders
          set deleted_at = now(),
              metadata = metadata || jsonb_build_object('trashRootFolderId', ${input.folderId}::text),
              updated_at = now()
          where id in (select id from folder_tree)
            and not exists (select 1 from unauthorized)
          returning *
        )
        select folder.*,
          coalesce((select array_agg(id::text) from trashed_files), array[]::text[])
            as trashed_file_ids
        from trashed_folders folder
        where folder.id = ${input.folderId}
        limit 1
      `;
      const row = rows[0];
      if (row === undefined) {
        throw new DriveForbiddenError(
          `Drive folder ${input.folderId} contains an item the actor cannot trash.`,
        );
      }
      for (const objectId of row.trashed_file_ids) {
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "drive.object.trashed",
          objectId,
          payload: { parentFolderId: input.folderId, recursive: true },
        });
      }
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.folder.trashed",
        objectId: input.folderId,
        payload: { name: row.name, parentFolderId: row.parent_folder_id },
      });
      return mapFolderEntry(row);
    },
  );
}

export async function restoreFolder(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
  },
): Promise<DriveEntryRecord | null> {
  return withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    async (tx) => {
      await requireFolderRoleIncludingDeleted(
        tx,
        input.orgId,
        input.actorId,
        input.folderId,
        "editor",
      );
      const rows = await tx<
        (DriveFolderRow & {
          readonly restored_file_ids: readonly string[];
        })[]
      >`
          with recursive folder_tree as (
            select * from drive_folders
            where id = ${input.folderId} and org_id = ${input.orgId}
              and deleted_at is not null
              and trash_purge_after > now()
              and metadata->>'trashRootFolderId' = ${input.folderId}
              and not (metadata ? 'purgeRootFolderId')
            union all
            select child.* from drive_folders child
            join folder_tree parent on child.parent_folder_id = parent.id
            where child.org_id = ${input.orgId}
              and child.trash_purge_after > now()
              and child.metadata->>'trashRootFolderId' = ${input.folderId}
          ), unauthorized as (
            select folder.id from folder_tree folder
            where coalesce(helix_drive_effective_role(
              ${input.orgId}, ${input.actorId}, 'drive_folder', folder.id
            ), '') not in ('editor', 'owner')
            union all
            select object.id from objects object
            where object.org_id = ${input.orgId}
              and object.metadata->>'trashRootFolderId' = ${input.folderId}
              and coalesce(helix_drive_effective_role(
                ${input.orgId}, ${input.actorId}, 'object', object.id
              ), '') not in ('editor', 'owner')
          ), restored_files as (
            update objects
            set deleted_at = null, metadata = metadata - 'trashRootFolderId', updated_at = now()
            where org_id = ${input.orgId}
              and metadata->>'trashRootFolderId' = ${input.folderId}
              and not exists (select 1 from unauthorized)
            returning id
          ), restored_folders as (
            update drive_folders
            set deleted_at = null, metadata = metadata - 'trashRootFolderId', updated_at = now()
            where id in (select id from folder_tree)
              and not exists (select 1 from unauthorized)
            returning *
          )
          select folder.*,
            coalesce((select array_agg(id::text) from restored_files), array[]::text[])
              as restored_file_ids
          from restored_folders folder
          where folder.id = ${input.folderId}
          limit 1
        `;
      const row = rows[0];
      if (row === undefined) {
        throw new DriveForbiddenError(
          `Drive folder ${input.folderId} contains an item the actor cannot restore.`,
        );
      }
      for (const objectId of row.restored_file_ids) {
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "drive.object.restored",
          objectId,
          payload: { parentFolderId: input.folderId, recursive: true },
        });
      }
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.folder.restored",
        objectId: input.folderId,
        payload: { name: row.name, parentFolderId: row.parent_folder_id },
      });
      return mapFolderEntry(row);
    },
  );
}

export async function deleteFolder(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
  },
): Promise<boolean> {
  const fileIds = await withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    async (tx) => {
      await requireFolderRoleIncludingDeleted(
        tx,
        input.orgId,
        input.actorId,
        input.folderId,
        "owner",
      );
      const rows = await tx<
        {
          readonly file_ids: readonly string[];
          readonly root_marked: boolean;
        }[]
      >`
          with recursive folder_tree as (
            select * from drive_folders
            where id = ${input.folderId} and org_id = ${input.orgId}
              and deleted_at is not null
              and (
                metadata->>'trashRootFolderId' = ${input.folderId}
                or metadata->>'purgeRootFolderId' = ${input.folderId}
              )
            union all
            select child.* from drive_folders child
            join folder_tree parent on child.parent_folder_id = parent.id
            where child.org_id = ${input.orgId}
              and (
                child.metadata->>'trashRootFolderId' = ${input.folderId}
                or child.metadata->>'purgeRootFolderId' = ${input.folderId}
              )
          ), unauthorized as (
            select folder.id from folder_tree folder
            where helix_drive_effective_role(
                ${input.orgId}, ${input.actorId}, 'drive_folder', folder.id
              ) is distinct from 'owner'
              or folder.trash_purge_after > now()
              or folder.retain_until > now()
              or exists (
                select 1 from drive_retention_holds hold
                where hold.org_id = ${input.orgId}
                  and hold.resource_type = 'folder' and hold.resource_id = folder.id
                  and hold.released_at is null
                  and (hold.expires_at is null or hold.expires_at > now())
              )
            union all
            select object.id from objects object
            where object.org_id = ${input.orgId}
              and object.metadata->>'trashRootFolderId' = ${input.folderId}
              and (
                helix_drive_effective_role(
                  ${input.orgId}, ${input.actorId}, 'object', object.id
                ) is distinct from 'owner'
                or object.trash_purge_after > now()
                or object.retain_until > now()
                or exists (
                  select 1 from drive_retention_holds hold
                  where hold.org_id = ${input.orgId}
                    and hold.resource_type = 'object' and hold.resource_id = object.id
                    and hold.released_at is null
                    and (hold.expires_at is null or hold.expires_at > now())
                )
              )
          ), marked_folders as (
            update drive_folders
            set metadata = metadata || jsonb_build_object('purgeRootFolderId', ${input.folderId}::text),
                updated_at = now()
            where id in (select id from folder_tree)
              and not exists (select 1 from unauthorized)
            returning id
          ), marked_files as (
            update objects
            set metadata = metadata || jsonb_build_object('purgeRootFolderId', ${input.folderId}::text),
                updated_at = now()
            where org_id = ${input.orgId}
              and metadata->>'trashRootFolderId' = ${input.folderId}
              and not exists (select 1 from unauthorized)
            returning id
          )
          select coalesce(array_agg(id::text), array[]::text[]) as file_ids,
            exists (select 1 from marked_folders where id = ${input.folderId}) as root_marked
          from marked_files
        `;
      const row = rows[0];
      if (row?.root_marked !== true) {
        throw new DriveForbiddenError(
          `Drive folder ${input.folderId} contains an item the actor cannot purge.`,
        );
      }
      return row.file_ids;
    },
  );
  for (const objectId of fileIds) {
    await deleteEntry(context, { ...input, objectId });
  }
  return withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    async (tx) => {
      await requireFolderRoleIncludingDeleted(
        tx,
        input.orgId,
        input.actorId,
        input.folderId,
        "owner",
      );
      await tx`
          with recursive folder_tree as (
            select id from drive_folders
            where id = ${input.folderId} and org_id = ${input.orgId}
              and metadata->>'purgeRootFolderId' = ${input.folderId}
            union all
            select child.id from drive_folders child
            join folder_tree parent on child.parent_folder_id = parent.id
            where child.org_id = ${input.orgId}
              and child.metadata->>'purgeRootFolderId' = ${input.folderId}
          )
          delete from permissions
          where org_id = ${input.orgId}
            and resource_type = 'drive_folder'
            and resource_id in (select id from folder_tree)
        `;
      const deleted = await tx`
          with recursive folder_tree as (
            select id from drive_folders
            where id = ${input.folderId} and org_id = ${input.orgId}
              and metadata->>'purgeRootFolderId' = ${input.folderId}
            union all
            select child.id from drive_folders child
            join folder_tree parent on child.parent_folder_id = parent.id
            where child.org_id = ${input.orgId}
              and child.metadata->>'purgeRootFolderId' = ${input.folderId}
          )
          delete from drive_folders
          where id in (select id from folder_tree)
        `;
      if (deleted.count > 0) {
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "drive.folder.deleted",
          objectId: input.folderId,
          payload: { recursive: true },
        });
      }
      return deleted.count > 0;
    },
  );
}

export async function moveFolder(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
    readonly parentFolderId?: string | null;
  },
): Promise<DriveEntryRecord | null> {
  return withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    async (tx) => {
      await tx`select helix_drive_move_folder(
          ${input.orgId}, ${input.actorId}, ${input.folderId}, ${input.parentFolderId ?? null}
        )`;
      const rows = await tx<DriveFolderRow[]>`
          select * from drive_folders where org_id = ${input.orgId} and id = ${input.folderId}
        `;
      const row = rows[0];
      if (row === undefined) return null;
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.folder.moved",
        objectId: input.folderId,
        payload: { parentFolderId: input.parentFolderId ?? null },
      });
      return mapFolderEntry(row);
    },
  );
}
