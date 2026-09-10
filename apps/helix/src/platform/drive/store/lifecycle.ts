import { withTenantIoSagaPostgresContext as withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { isDriveBlobStorageKey, shouldDeleteBlobStorage } from "../core/dedup.js";
import { bytesFromDatabase } from "../core/mappers.js";
import { distinctStoredBytes } from "../core/quota.js";
import { DriveConflictError, DriveNotFoundError } from "../errors.js";
import type { DriveEntryRecord } from "../types.js";
import { appendDriveActivity } from "./activity.js";
import { canReadObjectSql, requireObjectRole } from "./authz.js";
import { decrementDriveBlobRef } from "./blobs.js";
import { type DriveStoreContext } from "./context.js";
import { updateFileFolder } from "./entries.js";
import { deleteFolder, restoreFolder, trashFolder } from "./folders.js";
import { mapObjectEntry } from "./mappers.js";
import { deleteQuarantinedBytes, insertDriveQuarantineDeletion } from "./quarantine.js";
import { commitStorageUsage } from "./quotas.js";
import {
  type DriveQuarantineDeletionRow,
  type DriveSearchRow,
  type ObjectRow,
  type SqlLike,
} from "./rows.js";
import { storageForOrg } from "./storage.js";
async function assertRecordingPurgeAllowed(
  sql: SqlLike,
  orgId: string,
  objectId: string,
): Promise<void> {
  const rows = await sql<
    {
      readonly blocked: boolean;
    }[]
  >`
    select exists (
      select 1 from meet_recording_governance
      where org_id = ${orgId} and object_id = ${objectId}
        and (legal_hold or retention_until > now())
    ) as blocked
  `;
  if (rows[0]?.blocked === true) {
    throw new DriveConflictError("Meet recording is protected by retention or legal hold.");
  }
}

export function assertDriveRestoreAllowed(object: ObjectRow): void {
  if (object.deleted_at === null) {
    throw new DriveConflictError("Drive object is not in trash.");
  }
  if (object.trash_purge_after === null || object.trash_purge_after <= new Date()) {
    throw new DriveConflictError("Drive object recovery window has expired.");
  }
}

async function assertDriveObjectPurgeAllowed(sql: SqlLike, object: ObjectRow): Promise<void> {
  if (object.deleted_at === null) {
    throw new DriveConflictError("Move the Drive object to trash before purging it.");
  }
  if (object.trash_purge_after === null || object.trash_purge_after > new Date()) {
    throw new DriveConflictError("Drive object is still within its recovery window.");
  }
  if (object.retain_until !== null && object.retain_until > new Date()) {
    throw new DriveConflictError("Drive object is protected by retention policy.");
  }
  const rows = await sql<
    {
      readonly blocked: boolean;
    }[]
  >`
    select exists (
      select 1 from drive_retention_holds hold
      where hold.org_id = ${object.org_id}
        and hold.resource_type = 'object'
        and hold.resource_id = ${object.id}
        and hold.released_at is null
        and (hold.expires_at is null or hold.expires_at > now())
    ) or exists (
      select 1 from drive_share_links link
      where link.org_id = ${object.org_id} and link.object_id = ${object.id}
        and link.revoked_at is null
        and (link.expires_at is null or link.expires_at > now())
    ) or exists (
      select 1 from drive_scan_jobs job
      where job.org_id = ${object.org_id} and job.object_id = ${object.id}
        and job.status in ('pending', 'processing')
    ) as blocked
  `;
  if (rows[0]?.blocked === true) {
    throw new DriveConflictError(
      "Drive object is protected by a retention hold, active share, or pending scan.",
    );
  }
}

export async function trash(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  },
): Promise<DriveEntryRecord | null> {
  try {
    return await withTenantPostgresContext(
      context.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "editor");
        const rows = await tx<DriveSearchRow[]>`
        update objects
        set deleted_at = now(), metadata = metadata - 'trashRootFolderId', updated_at = now()
        where id = ${input.objectId}
          and org_id = ${input.orgId}
          and kind = 'file'
          and deleted_at is null
          and ${canReadObjectSql(tx, input.orgId, input.actorId)}
        returning *, (select max(version_number) from drive_versions v where v.object_id = objects.id) as version_number
      `;
        if (rows[0] !== undefined) {
          await appendDriveActivity(tx, {
            orgId: input.orgId,
            actorId: input.actorId,
            verb: "drive.object.trashed",
            objectId: input.objectId,
            payload: {},
          });
        }
        return rows[0] === undefined ? null : mapObjectEntry(rows[0]);
      },
    );
  } catch (error) {
    if (!(error instanceof DriveNotFoundError)) throw error;
    return trashFolder(context, {
      orgId: input.orgId,
      actorId: input.actorId,
      folderId: input.objectId,
    });
  }
}

export async function restore(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
  },
): Promise<DriveEntryRecord | null> {
  try {
    return await updateFileFolder(context, {
      ...input,
      verb: "drive.object.restored",
      restore: true,
    });
  } catch (error) {
    if (!(error instanceof DriveNotFoundError)) throw error;
    return restoreFolder(context, {
      orgId: input.orgId,
      actorId: input.actorId,
      folderId: input.objectId,
    });
  }
}

export async function deleteEntry(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  },
): Promise<boolean> {
  try {
    const hasStorage = (await storageForOrg(context, input.orgId)) !== undefined;
    const result = await withTenantPostgresContext(
      context.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        const object = await requireObjectRole(
          tx,
          input.orgId,
          input.actorId,
          input.objectId,
          "owner",
        );
        await assertDriveObjectPurgeAllowed(tx, object);
        await assertRecordingPurgeAllowed(tx, input.orgId, input.objectId);
        const versionRows = await tx<
          {
            readonly storage_key: string;
            readonly byte_size: string | number;
          }[]
        >`
        select storage_key, byte_size from drive_versions
        where object_id = ${input.objectId} and org_id = ${input.orgId}
      `;
        await tx`
        delete from permissions
        where resource_type = 'object' and resource_id = ${input.objectId} and org_id = ${input.orgId}
      `;
        await tx`
        delete from drive_versions
        where object_id = ${input.objectId} and org_id = ${input.orgId}
      `;
        const deleted = await tx`
        delete from objects
        where id = ${input.objectId} and org_id = ${input.orgId} and kind in ('file', 'recording')
      `;
        let storageDelta = 0;
        const deletions: DriveQuarantineDeletionRow[] = [];
        if (deleted.count > 0) {
          const stored = [
            { storageKey: object.storage_key, byteSize: bytesFromDatabase(object.byte_size) },
            ...versionRows.map((row) => ({
              storageKey: row.storage_key,
              byteSize: bytesFromDatabase(row.byte_size),
            })),
          ];
          storageDelta = -distinctStoredBytes(stored);
          const bytesByKey = new Map<string, number>();
          for (const entry of stored) {
            bytesByKey.set(
              entry.storageKey,
              Math.max(bytesByKey.get(entry.storageKey) ?? 0, entry.byteSize),
            );
          }
          const uniqueKeys = new Set([
            object.storage_key,
            ...versionRows.map((row) => row.storage_key),
          ]);
          const versionReferences = new Map<string, number>();
          for (const version of versionRows) {
            versionReferences.set(
              version.storage_key,
              (versionReferences.get(version.storage_key) ?? 0) + 1,
            );
          }
          for (const storageKey of uniqueKeys) {
            if (
              context.options.contentAddressedDedup === true &&
              isDriveBlobStorageKey(storageKey)
            ) {
              const removedReferences = versionReferences.get(storageKey) ?? 0;
              if (removedReferences === 0) continue;
              const refcountAfter = await decrementDriveBlobRef(tx, {
                orgId: input.orgId,
                storageKey,
                amount: removedReferences,
              });
              if (refcountAfter > 0) {
                storageDelta += bytesByKey.get(storageKey) ?? 0;
              }
              if (shouldDeleteBlobStorage(refcountAfter) && hasStorage) {
                deletions.push(
                  await insertDriveQuarantineDeletion(tx, {
                    orgId: input.orgId,
                    objectId: input.objectId,
                    actorId: input.actorId,
                    storageKey,
                  }),
                );
              }
            } else if (hasStorage) {
              deletions.push(
                await insertDriveQuarantineDeletion(tx, {
                  orgId: input.orgId,
                  objectId: input.objectId,
                  actorId: input.actorId,
                  storageKey,
                }),
              );
            }
          }
          await appendDriveActivity(tx, {
            orgId: input.orgId,
            actorId: input.actorId,
            verb: "drive.object.deleted",
            objectId: input.objectId,
            payload: {},
          });
        }
        if (deleted.count > 0) {
          await commitStorageUsage(tx, input.orgId, input.objectId, storageDelta, "drive");
        }
        return { deleted: deleted.count > 0, deletions };
      },
    );
    for (const deletion of result.deletions) {
      await deleteQuarantinedBytes(context, deletion);
    }
    return result.deleted;
  } catch (error) {
    if (!(error instanceof DriveNotFoundError)) throw error;
    return deleteFolder(context, {
      orgId: input.orgId,
      actorId: input.actorId,
      folderId: input.objectId,
    });
  }
}
