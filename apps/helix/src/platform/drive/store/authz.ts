import type postgres from "postgres";
import { stringMetadata } from "../core/mappers.js";
import { driveRoleRank, hasRoleAtLeast, parseDriveRole, type DriveRole } from "../core/roles.js";
import { DriveConflictError, DriveForbiddenError, DriveNotFoundError } from "../errors.js";
import { type ObjectRow, type SqlLike } from "./rows.js";
export async function requireObjectAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  objectId: string,
): Promise<ObjectRow> {
  // Drive surfaces 'file' (uploaded files) and
  // 'recording' (meet recordings). Both go through the same /content
  // endpoint, the same permissions table, and the same readObjectBytes
  // path — only the kind differs.
  const rows = await sql<ObjectRow[]>`
    select *
    from objects
    where id = ${objectId}
      and org_id = ${orgId}
      and kind in ('file', 'recording')
      and ${canReadObjectSql(sql, orgId, actorId)}
    limit 1
  `;
  const object = rows[0];
  if (object === undefined) {
    throw new DriveNotFoundError(`Unknown or inaccessible Drive object: ${objectId}`);
  }
  return object;
}

export async function requireObjectRole(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  objectId: string,
  minRole: DriveRole,
): Promise<ObjectRow> {
  const object = await requireObjectAccess(sql, orgId, actorId, objectId);
  if (object.owner_actor_id === actorId) return object;
  const rows = await sql<
    {
      readonly role: string | null;
    }[]
  >`
    select helix_drive_effective_role(${orgId}, ${actorId}, 'object', ${objectId}) as role
  `;
  const best = parseDriveRole(rows[0]?.role ?? "reader");
  if (!hasRoleAtLeast(best, minRole)) {
    throw new DriveForbiddenError(
      `Requires '${minRole}' access on Drive object ${objectId}; actor has '${best}'.`,
    );
  }
  return object;
}

export async function requireReadyObjectAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  objectId: string,
): Promise<ObjectRow> {
  const object = await requireObjectAccess(sql, orgId, actorId, objectId);
  assertDriveObjectReady(object);
  return object;
}

export async function requireReadyObjectRole(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  objectId: string,
  minRole: DriveRole,
): Promise<ObjectRow> {
  const object = await requireObjectRole(sql, orgId, actorId, objectId, minRole);
  assertDriveObjectReady(object);
  return object;
}

export async function requireUploadWriteAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  objectId: string,
): Promise<ObjectRow> {
  const object = await requireObjectRole(sql, orgId, actorId, objectId, "editor");
  const uploadActorId = stringMetadata(object.metadata, "uploadActorId") ?? object.owner_actor_id;
  if (stringMetadata(object.metadata, "status") === "pending_upload" && uploadActorId !== actorId) {
    throw new DriveForbiddenError("Only the actor who prepared this upload may finalize it.");
  }
  return object;
}

export function isDriveObjectReady(object: ObjectRow): boolean {
  const status = stringMetadata(object.metadata, "status");
  return status === undefined || status === "ready";
}

export function assertDriveObjectReady(object: ObjectRow): void {
  if (!isDriveObjectReady(object)) {
    throw new DriveConflictError("Drive object is not ready.");
  }
}

export async function requireFolderAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  folderId: string,
): Promise<{
  readonly id: string;
  readonly owner_actor_id: string | null;
}> {
  const rows = await sql<
    {
      readonly id: string;
      readonly owner_actor_id: string | null;
    }[]
  >`
    select id, owner_actor_id
    from drive_folders
    where id = ${folderId}
      and org_id = ${orgId}
      and deleted_at is null
      and ${canReadFolderSql(sql, orgId, actorId)}
    limit 1
  `;
  const folder = rows[0];
  if (folder === undefined) {
    throw new DriveNotFoundError(`Unknown or inaccessible Drive folder: ${folderId}`);
  }
  return folder;
}

export async function requireFolderRole(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  folderId: string,
  minRole: DriveRole,
): Promise<void> {
  const folder = await requireFolderAccess(sql, orgId, actorId, folderId);
  if (folder.owner_actor_id === actorId) return;
  const rows = await sql<
    {
      readonly role: string | null;
    }[]
  >`
    select helix_drive_effective_role(${orgId}, ${actorId}, 'drive_folder', ${folderId}) as role
  `;
  const best = parseDriveRole(rows[0]?.role ?? "reader");
  if (!hasRoleAtLeast(best, minRole)) {
    throw new DriveForbiddenError(
      `Requires '${minRole}' access on Drive folder ${folderId}; actor has '${best}'.`,
    );
  }
}

export async function requireFolderRoleIncludingDeleted(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  folderId: string,
  minRole: DriveRole,
): Promise<void> {
  const rows = await sql<
    {
      readonly owner_actor_id: string | null;
      readonly permission_rank: number;
    }[]
  >`
    select folder.owner_actor_id, case helix_drive_effective_role(
      ${orgId}, ${actorId}, 'drive_folder', ${folderId}
    ) when 'owner' then 3 when 'editor' then 2 when 'commenter' then 1
      when 'reader' then 0 else -1 end as permission_rank
    from drive_folders folder
    where folder.org_id = ${orgId} and folder.id = ${folderId}
  `;
  const row = rows[0];
  if (row === undefined) throw new DriveNotFoundError(`Unknown Drive folder: ${folderId}`);
  if (row.permission_rank >= driveRoleRank(minRole)) return;
  throw new DriveForbiddenError(`Requires '${minRole}' access on Drive folder ${folderId}.`);
}

export function requireFolderAddChildren(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  folderId: string,
): Promise<void> {
  return requireFolderRole(sql, orgId, actorId, folderId, "commenter");
}

export function canReadObjectSql(
  sql: SqlLike,
  orgId: string,
  actorId: string,
): postgres.PendingQuery<postgres.Row[]> {
  return sql`
    (helix_drive_effective_role(${orgId}, ${actorId}, 'object', objects.id) is not null
      or (
        objects.kind = 'recording'
        and exists (
          select 1
          from meet_recording_governance governance
          join permissions p
            on p.org_id = governance.org_id
           and p.resource_type in ('meet_room', 'thread')
           and p.resource_id in (governance.room_id, governance.thread_id)
          join actors actor on actor.org_id = p.org_id and actor.id = p.actor_id
          where governance.org_id = ${orgId}
            and governance.object_id = objects.id
            and p.actor_id = ${actorId}
            and p.status = 'active'
            and p.revoked_at is null
            and p.valid_from <= now()
            and (p.expires_at is null or p.expires_at > now())
            and actor.disabled_at is null
        )
      )
    )
  `;
}

export function canReadFolderSql(
  sql: SqlLike,
  orgId: string,
  actorId: string,
): postgres.PendingQuery<postgres.Row[]> {
  return sql`
    helix_drive_effective_role(
      ${orgId}, ${actorId}, 'drive_folder', drive_folders.id
    ) is not null
  `;
}
