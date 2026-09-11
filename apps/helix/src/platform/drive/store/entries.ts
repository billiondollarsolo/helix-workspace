import { createHash } from "node:crypto";
import { BadRequestError } from "../../../api/api-error.js";
import { withTenantIoSagaPostgresContext as withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { toSqlJson } from "../../util/sql.js";
import { DriveForbiddenError } from "../errors.js";
import type { DriveEntryPage, DriveEntryRecord, DriveSearchHit } from "../types.js";
import { appendDriveActivity } from "./activity.js";
import {
  canReadFolderSql,
  canReadObjectSql,
  requireFolderAccess,
  requireFolderAddChildren,
  requireFolderRole,
  requireReadyObjectRole,
} from "./authz.js";
import { type DriveStoreContext } from "./context.js";
import { type DriveDocumentSurfaceView } from "./contracts.js";
import { assertDriveRestoreAllowed } from "./lifecycle.js";
import { mapDriveListEntry, mapFolderEntry, mapObjectEntry, mapSearchHit } from "./mappers.js";
import { withoutMetadataKey } from "./metadata.js";
import {
  type DriveFolderRow,
  type DriveListCursor,
  type DriveListRow,
  type DriveSearchRow,
} from "./rows.js";
function driveListFilterKey(input: {
  readonly orgId: string;
  readonly actorId: string;
  readonly folderId: string | null;
  readonly includeTrashed: boolean;
  readonly kind: string;
  readonly acrossFolders: boolean;
  readonly view: "owned" | "shared" | null;
}): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("base64url").slice(0, 16);
}

function encodeDriveListCursor(cursor: DriveListCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      n: cursor.name,
      t: cursor.type,
      i: cursor.id,
      s: cursor.snapshotAt.toISOString(),
      f: cursor.filter,
    }),
    "utf8",
  ).toString("base64url");
}

function decodeDriveListCursor(
  encoded: string | undefined,
  expectedFilter: string,
): DriveListCursor | undefined {
  if (encoded === undefined) return undefined;
  try {
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const snapshotAt = new Date(typeof value.s === "string" ? value.s : "");
    if (
      value.v !== 1 ||
      typeof value.n !== "string" ||
      (value.t !== 0 && value.t !== 1) ||
      typeof value.i !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        value.i,
      ) ||
      Number.isNaN(snapshotAt.valueOf()) ||
      value.f !== expectedFilter
    ) {
      throw new Error("invalid fields");
    }
    return { name: value.n, type: value.t, id: value.i, snapshotAt, filter: expectedFilter };
  } catch {
    throw new BadRequestError("Invalid Drive list cursor.");
  }
}

export async function list(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId?: string | null;
    readonly includeTrashed?: boolean;
    readonly limit?: number;
    readonly cursor?: string;
    /** Filter by object kind. Defaults to 'file'; the Recordings drive
     *  scope passes 'recording'. */
    readonly kind?: string | null;
    /** When true, return every visible file regardless of which folder
     *  it lives in. Folder
     *  rows are suppressed in this mode — the result is a flat file list. */
    readonly acrossFolders?: boolean;
    /** Root-only Google Drive views. Ignored when listing a folder's children
     *  or when `acrossFolders` is set. `owned` is My Drive; `shared` is
     *  Shared with me (share-roots only, not nested contents). */
    readonly view?: "owned" | "shared" | null;
  },
): Promise<DriveEntryPage> {
  // When filtering for non-file kinds (e.g. 'recording'), the folder
  // hierarchy doesn't apply — those objects don't live in user-managed
  // folders. Force acrossFolders=true so we skip the folder rows and the
  // folderId metadata match.
  const kind = input.kind ?? "file";
  const acrossFolders = input.acrossFolders === true || kind !== "file";
  const folderId = input.folderId ?? null;
  const view = acrossFolders || folderId !== null ? null : (input.view ?? null);
  const ownedRoot = view === "owned";
  const sharedRoot = view === "shared";
  const limit = Math.min(250, Math.max(1, Math.trunc(input.limit ?? 100)));
  const filter = driveListFilterKey({
    orgId: input.orgId,
    actorId: input.actorId,
    folderId,
    includeTrashed: input.includeTrashed ?? false,
    kind,
    acrossFolders,
    view,
  });
  const cursor = decodeDriveListCursor(input.cursor, filter);
  if (input.folderId !== undefined && input.folderId !== null && !acrossFolders) {
    await requireFolderAccess(context.sql, input.orgId, input.actorId, input.folderId);
  }
  const rows = await withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    async (tx) =>
      await tx<DriveListRow[]>`
          with page as (
            select coalesce(${cursor?.snapshotAt ?? null}::timestamptz, statement_timestamp()) as snapshot_at
          ), visible_entries as (
            select
              'folder'::text as entry_type,
              drive_folders.id,
              drive_folders.name,
              drive_folders.parent_folder_id::text as folder_id,
              drive_folders.owner_actor_id,
              null::text as mime_type,
              null::bigint as byte_size,
              null::text as sha256,
              null::text as storage_key,
              null::integer as version_number,
              drive_folders.metadata,
              case when drive_folders.deleted_at > page.snapshot_at then null else drive_folders.deleted_at end as deleted_at,
              drive_folders.created_at,
              drive_folders.updated_at,
              null::boolean as mine,
              null::bigint as shared_count,
              null::boolean as starred,
              lower(drive_folders.name) as sort_name,
              0 as sort_type,
              page.snapshot_at
            from drive_folders
            cross join page
            where not ${acrossFolders}
              and drive_folders.org_id = ${input.orgId}
              and (
                (${input.folderId ?? null}::uuid is null and drive_folders.parent_folder_id is null)
                or drive_folders.parent_folder_id = ${input.folderId ?? null}
              )
              and (${input.includeTrashed ?? false} or drive_folders.deleted_at is null or drive_folders.deleted_at > page.snapshot_at)
              and drive_folders.created_at <= page.snapshot_at
              and ${canReadFolderSql(tx, input.orgId, input.actorId)}
              and (
                not ${ownedRoot}
                or drive_folders.owner_actor_id = ${input.actorId}
              )
              and (
                not ${sharedRoot}
                or (
                  drive_folders.owner_actor_id is distinct from ${input.actorId}
                  and (
                    drive_folders.parent_folder_id is null
                    or helix_drive_effective_role(
                      ${input.orgId}, ${input.actorId}, 'drive_folder', drive_folders.parent_folder_id
                    ) is null
                  )
                )
              )

            union all

            select
              'file'::text as entry_type,
              o.id,
              coalesce(o.metadata->>'name', o.storage_key) as name,
              nullif(o.metadata->>'folderId', '') as folder_id,
              o.owner_actor_id,
              o.mime_type,
              o.byte_size,
              o.sha256,
              o.storage_key,
              (select max(version_number) from drive_versions v where v.object_id = o.id) as version_number,
              o.metadata,
              case when o.deleted_at > page.snapshot_at then null else o.deleted_at end as deleted_at,
              o.created_at,
              o.updated_at,
              (o.owner_actor_id = ${input.actorId}) as mine,
              greatest(cardinality(helix_drive_visible_actor_ids(
                ${input.orgId}, 'object', o.id
              )) - case when o.owner_actor_id is null then 0 else 1 end, 0)::bigint as shared_count,
              exists (
                select 1
                from drive_member_stars star
                join organization_memberships membership
                  on membership.org_id = star.org_id
                 and membership.id = star.membership_id
                where star.org_id = o.org_id
                  and star.object_id = o.id
                  and membership.actor_id = ${input.actorId}
                  and membership.status = 'active'
              ) as starred,
              lower(coalesce(o.metadata->>'name', o.storage_key)) as sort_name,
              1 as sort_type,
              page.snapshot_at
            from objects o
            cross join page
            where o.org_id = ${input.orgId}
              and o.kind = ${kind}
              and (coalesce(o.metadata->>'status', 'ready') = 'ready'
                or (o.owner_actor_id = ${input.actorId}
                  and o.metadata->>'status' in ('scan_pending', 'scan_processing', 'infected', 'quarantined', 'scan_failed', 'scan_dead_letter')))
              and (${acrossFolders} or coalesce(o.metadata->>'folderId', '') = coalesce(${input.folderId ?? null}::text, ''))
              and (${input.includeTrashed ?? false} or o.deleted_at is null or o.deleted_at > page.snapshot_at)
              and o.created_at <= page.snapshot_at
              and helix_drive_effective_role(
                ${input.orgId}, ${input.actorId}, 'object', o.id
              ) is not null
              and (
                not ${ownedRoot}
                or o.owner_actor_id = ${input.actorId}
              )
              and (
                not ${sharedRoot}
                or (
                  o.owner_actor_id is distinct from ${input.actorId}
                  and (
                    coalesce(o.metadata->>'folderId', '') = ''
                    or helix_drive_effective_role(
                      ${input.orgId}, ${input.actorId}, 'drive_folder',
                      nullif(o.metadata->>'folderId', '')::uuid
                    ) is null
                  )
                )
              )
          )
          select *
          from visible_entries
          where ${cursor === undefined}
             or (sort_name collate "C", sort_type, id) > (${cursor?.name ?? ""} collate "C", ${cursor?.type ?? 0}, ${cursor?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid)
          order by sort_name collate "C", sort_type, id
          limit ${limit + 1}
        `,
  );
  const entries = rows.slice(0, limit).map(mapDriveListEntry);
  const last = rows.length > limit ? rows[limit - 1] : undefined;
  return {
    entries,
    nextCursor:
      last === undefined
        ? null
        : encodeDriveListCursor({
            name: last.sort_name,
            type: last.sort_type,
            id: last.id,
            snapshotAt: last.snapshot_at,
            filter,
          }),
  };
}

export async function move(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
  },
): Promise<DriveEntryRecord | null> {
  return context.sql.begin(async (tx) => {
    await requireReadyObjectRole(tx, input.orgId, input.actorId, input.objectId, "editor");
    if (input.folderId !== undefined && input.folderId !== null) {
      await requireFolderAddChildren(tx, input.orgId, input.actorId, input.folderId);
    }
    await tx`select helix_drive_move_object(
        ${input.orgId}, ${input.actorId}, ${input.objectId}, ${input.folderId ?? null}
      )`;
    const rows = await tx<DriveSearchRow[]>`
        select *, (select max(version_number) from drive_versions version
          where version.object_id = objects.id) as version_number
        from objects where org_id = ${input.orgId} and id = ${input.objectId}
      `;
    await appendDriveActivity(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      verb: "drive.object.moved",
      objectId: input.objectId,
      payload: { folderId: input.folderId ?? null },
    });
    return rows[0] === undefined ? null : mapObjectEntry(rows[0]);
  });
}

export async function setStarred(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly starred: boolean;
  },
): Promise<DriveEntryRecord | null> {
  return withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    async (tx) => {
      const rows = input.starred
        ? await tx<DriveSearchRow[]>`
              with readable as (
                select objects.*,
                  (select max(version_number) from drive_versions version
                   where version.object_id = objects.id) as version_number
                from objects
                where id = ${input.objectId}
                  and org_id = ${input.orgId}
                  and kind = 'file'
                  and deleted_at is null
                  and coalesce(metadata->>'status', 'ready') = 'ready'
                  and ${canReadObjectSql(tx, input.orgId, input.actorId)}
              ), active_membership as (
                select id
                from organization_memberships
                where org_id = ${input.orgId}
                  and actor_id = ${input.actorId}
                  and status = 'active'
              ), added as (
                insert into drive_member_stars (org_id, membership_id, object_id)
                select ${input.orgId}, active_membership.id, readable.id
                from active_membership cross join readable
                on conflict do nothing
              )
              select readable.*, true as starred
              from readable cross join active_membership
            `
        : await tx<DriveSearchRow[]>`
              with readable as (
                select objects.*,
                  (select max(version_number) from drive_versions version
                   where version.object_id = objects.id) as version_number
                from objects
                where id = ${input.objectId}
                  and org_id = ${input.orgId}
                  and kind = 'file'
                  and deleted_at is null
                  and coalesce(metadata->>'status', 'ready') = 'ready'
                  and ${canReadObjectSql(tx, input.orgId, input.actorId)}
              ), active_membership as (
                select id
                from organization_memberships
                where org_id = ${input.orgId}
                  and actor_id = ${input.actorId}
                  and status = 'active'
              ), removed as (
                delete from drive_member_stars star
                using active_membership, readable
                where star.org_id = ${input.orgId}
                  and star.membership_id = active_membership.id
                  and star.object_id = readable.id
              )
              select readable.*, false as starred
              from readable cross join active_membership
            `;
      if (rows[0] !== undefined) {
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: input.starred ? "drive.object.starred" : "drive.object.unstarred",
          objectId: input.objectId,
          payload: { starred: input.starred },
        });
      }
      return rows[0] === undefined ? null : mapObjectEntry(rows[0]);
    },
  );
}

export async function getDocumentSurfaceView(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
  },
): Promise<DriveDocumentSurfaceView> {
  return withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    async (tx) => {
      const rows = await tx<
        {
          readonly view: DriveDocumentSurfaceView;
        }[]
      >`
          select coalesce(preference.document_surface_view, 'grid') as view
          from organization_memberships membership
          left join workspace_member_preferences preference
            on preference.org_id = membership.org_id
           and preference.membership_id = membership.id
          where membership.org_id = ${input.orgId}
            and membership.actor_id = ${input.actorId}
            and membership.status = 'active'
          limit 1
        `;
      const view = rows[0]?.view;
      if (view === undefined) {
        throw new DriveForbiddenError("Active organization membership required.");
      }
      return view;
    },
  );
}

export async function setDocumentSurfaceView(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly view: DriveDocumentSurfaceView;
  },
): Promise<DriveDocumentSurfaceView> {
  return withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    async (tx) => {
      const rows = await tx<
        {
          readonly view: DriveDocumentSurfaceView;
        }[]
      >`
          insert into workspace_member_preferences (
            org_id,
            membership_id,
            document_surface_view
          )
          select ${input.orgId}, membership.id, ${input.view}
          from organization_memberships membership
          where membership.org_id = ${input.orgId}
            and membership.actor_id = ${input.actorId}
            and membership.status = 'active'
          on conflict (org_id, membership_id) do update
          set document_surface_view = excluded.document_surface_view
          returning document_surface_view as view
        `;
      const view = rows[0]?.view;
      if (view === undefined) {
        throw new DriveForbiddenError("Active organization membership required.");
      }
      return view;
    },
  );
}

export async function rename(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly name: string;
  },
): Promise<DriveEntryRecord | null> {
  return context.sql.begin(async (tx) => {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new BadRequestError("Drive rename requires a non-empty name.");
    }
    const object = await tx<
      { id: string }[]
    >`select id from objects where id = ${input.objectId} and org_id = ${input.orgId} and kind in ('file', 'recording') and deleted_at is null`;
    if (object[0] !== undefined) {
      await requireReadyObjectRole(tx, input.orgId, input.actorId, input.objectId, "editor");
    }
    const rows = await tx<DriveSearchRow[]>`
        update objects
        set metadata = metadata || ${tx.json(toSqlJson({ name }))}::jsonb,
            updated_at = now()
        where id = ${input.objectId}
          and org_id = ${input.orgId}
          and kind in ('file', 'recording')
          and deleted_at is null
        returning *, (select max(version_number) from drive_versions v where v.object_id = objects.id) as version_number
      `;
    if (rows[0] !== undefined) {
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.object.renamed",
        objectId: input.objectId,
        payload: { name },
      });
      return mapObjectEntry(rows[0]);
    }
    await requireFolderRole(tx, input.orgId, input.actorId, input.objectId, "editor");
    const folderRows = await tx<DriveFolderRow[]>`
      update drive_folders
      set name = ${name}, updated_at = now()
      where id = ${input.objectId} and org_id = ${input.orgId} and deleted_at is null
      returning *
    `;
    if (folderRows[0] === undefined) return null;
    await appendDriveActivity(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      verb: "drive.folder.renamed",
      objectId: input.objectId,
      payload: { name },
    });
    return mapFolderEntry(folderRows[0]);
  });
}

export async function search(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string;
    readonly folderId?: string | null;
    readonly limit?: number;
  },
): Promise<readonly DriveSearchHit[]> {
  const query = input.query ?? "";
  const rows = await context.sql<DriveSearchRow[]>`
      select o.*, (select max(version_number) from drive_versions v where v.object_id = o.id) as version_number
      from objects o
      where o.org_id = ${input.orgId}
        and o.kind = 'file'
        and o.deleted_at is null
        and coalesce(o.metadata->>'status', 'ready') = 'ready'
        and (${input.folderId ?? null}::uuid is null or o.metadata->>'folderId' = ${input.folderId ?? null})
        and (${query} = '' or coalesce(o.metadata->>'name', o.storage_key) ilike ${`%${query}%`} or o.mime_type ilike ${`%${query}%`})
        and helix_drive_effective_role(
          ${input.orgId}, ${input.actorId}, 'object', o.id
        ) is not null
      order by o.updated_at desc
      limit ${input.limit ?? 50}
    `;
  return rows.map(mapSearchHit);
}

export async function updateFileFolder(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
    readonly verb: string;
    readonly restore: boolean;
  },
): Promise<DriveEntryRecord | null> {
  return context.sql.begin(async (tx) => {
    const current = await requireReadyObjectRole(
      tx,
      input.orgId,
      input.actorId,
      input.objectId,
      "editor",
    );
    if (input.restore) assertDriveRestoreAllowed(current);
    if (input.folderId !== undefined && input.folderId !== null) {
      await requireFolderAddChildren(tx, input.orgId, input.actorId, input.folderId);
    }
    const rows = await tx<DriveSearchRow[]>`
        update objects
        set
          deleted_at = ${input.restore ? null : current.deleted_at},
          metadata = ${tx.json(
            toSqlJson({
              ...withoutMetadataKey(current.metadata, "trashRootFolderId"),
              folderId: input.folderId ?? null,
            }),
          )},
          updated_at = now()
        where id = ${input.objectId}
          and org_id = ${input.orgId}
          and kind = 'file'
        returning *, (select max(version_number) from drive_versions v where v.object_id = objects.id) as version_number
      `;
    await appendDriveActivity(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      verb: input.verb,
      objectId: input.objectId,
      payload: { folderId: input.folderId ?? null },
    });
    return rows[0] === undefined ? null : mapObjectEntry(rows[0]);
  });
}
