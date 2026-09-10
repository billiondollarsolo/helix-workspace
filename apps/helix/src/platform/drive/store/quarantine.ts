import { withTenantIoSagaPostgresContext as withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { isDriveBlobStorageKey } from "../core/dedup.js";
import { appendDriveActivity } from "./activity.js";
import { driveBlobStorageIsReferenced } from "./blobs.js";
import { type DriveStoreContext } from "./context.js";
import { type DriveQuarantineDeleteErrorEvent } from "./contracts.js";
import { type DriveQuarantineDeletionRow, type SqlLike } from "./rows.js";
import { DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS } from "./scan-claims.js";
import { virusScanErrorMessage } from "./scan-content.js";
import { storageForOrg } from "./storage.js";
export async function insertDriveQuarantineDeletion(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly objectId: string;
    readonly actorId: string | null;
    readonly storageKey: string;
    readonly error?: string;
  },
): Promise<DriveQuarantineDeletionRow> {
  const rows = await sql<DriveQuarantineDeletionRow[]>`
    insert into drive_quarantine_deletions (
      org_id, object_id, actor_id, storage_key, last_error
    )
    values (
      ${input.orgId}, ${input.objectId}, ${input.actorId}, ${input.storageKey}, ${input.error ?? null}
    )
    on conflict (org_id, storage_key) do update
    set object_id = excluded.object_id,
        actor_id = coalesce(excluded.actor_id, drive_quarantine_deletions.actor_id),
        status = 'pending',
        next_attempt_at = now(),
        lease_expires_at = null,
        completed_at = null,
        last_error = coalesce(excluded.last_error, drive_quarantine_deletions.last_error),
        updated_at = now()
    returning id, org_id, object_id, actor_id, storage_key, status, attempt_count, next_attempt_at
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("Failed to persist Drive quarantine cleanup state.");
  return row;
}

export async function claimDriveQuarantineDeletions(
  sql: SqlLike,
  input: {
    readonly limit: number;
    readonly now: Date;
    readonly leaseExpiresAt: Date;
  },
): Promise<readonly DriveQuarantineDeletionRow[]> {
  return await sql<DriveQuarantineDeletionRow[]>`
    with candidates as (
      select id
      from drive_quarantine_deletions
      where (status = 'pending' and next_attempt_at <= ${input.now})
         or (status = 'processing' and lease_expires_at <= ${input.now})
      order by next_attempt_at asc, created_at asc
      limit ${Math.max(1, Math.trunc(input.limit))}
      for update skip locked
    )
    update drive_quarantine_deletions deletion
    set status = 'processing', lease_expires_at = ${input.leaseExpiresAt}, updated_at = now()
    from candidates
    where deletion.id = candidates.id
    returning deletion.id, deletion.org_id, deletion.object_id, deletion.actor_id,
              deletion.storage_key, deletion.status, deletion.attempt_count,
              deletion.next_attempt_at
  `;
}

async function completeDriveQuarantineDeletion(
  sql: SqlLike,
  deletion: Pick<DriveQuarantineDeletionRow, "id" | "org_id" | "status">,
): Promise<DriveQuarantineDeletionRow | null> {
  const rows = await sql<DriveQuarantineDeletionRow[]>`
    update drive_quarantine_deletions
    set status = 'completed', lease_expires_at = null, completed_at = now(),
        last_error = null, updated_at = now()
    where id = ${deletion.id} and org_id = ${deletion.org_id} and status = ${deletion.status}
    returning id, org_id, object_id, actor_id, storage_key, status, attempt_count,
      next_attempt_at, completed_at
  `;
  return rows[0] ?? null;
}

async function releaseDriveQuarantineDeletion(
  sql: SqlLike,
  input: {
    readonly id: string;
    readonly orgId: string;
    readonly status: "pending" | "processing";
    readonly error: string;
    readonly retryDelayMs: number;
  },
): Promise<DriveQuarantineDeletionRow | null> {
  const rows = await sql<DriveQuarantineDeletionRow[]>`
    update drive_quarantine_deletions
    set status = 'pending',
        attempt_count = attempt_count + 1,
        next_attempt_at = ${new Date(Date.now() + Math.max(1, input.retryDelayMs))},
        lease_expires_at = null,
        last_error = ${input.error},
        updated_at = now()
    where id = ${input.id} and org_id = ${input.orgId} and status = ${input.status}
    returning id, org_id, object_id, actor_id, storage_key, status, attempt_count, next_attempt_at
  `;
  return rows[0] ?? null;
}

export async function deleteQuarantinedBytes(
  context: DriveStoreContext,
  deletion: DriveQuarantineDeletionRow,
): Promise<boolean> {
  if (deletion.status === "completed") return true;
  const deletionStatus = deletion.status;
  try {
    const storage = await storageForOrg(context, deletion.org_id);
    if (storage === undefined) {
      throw new Error("Drive upload content storage is not configured.");
    }
    const retained =
      isDriveBlobStorageKey(deletion.storage_key) &&
      (await withTenantPostgresContext(context.sql, { orgId: deletion.org_id }, (tx) =>
        driveBlobStorageIsReferenced(tx, deletion.org_id, deletion.storage_key),
      ));
    if (!retained) await storage.delete(deletion.storage_key);
    await withTenantPostgresContext(context.sql, { orgId: deletion.org_id }, async (tx) => {
      const completed = await completeDriveQuarantineDeletion(tx, deletion);
      if (!retained) {
        await tx`
            delete from drive_blobs blob
            where blob.org_id = ${deletion.org_id}
              and blob.storage_key = ${deletion.storage_key}
              and blob.refcount = 0
              and not exists (
                select 1 from drive_blob_reservations reservation
                where reservation.org_id = blob.org_id
                  and reservation.storage_key = blob.storage_key
                  and reservation.expires_at > now()
              )
          `;
      }
      if (completed?.actor_id !== null && completed?.actor_id !== undefined) {
        await appendDriveActivity(tx, {
          orgId: completed.org_id,
          actorId: completed.actor_id,
          verb: retained
            ? "drive.upload.quarantine_bytes_retained"
            : "drive.upload.quarantine_bytes_deleted",
          objectId: completed.object_id,
          payload: { storageKey: completed.storage_key },
        });
      }
    });
    return true;
  } catch (error) {
    const errorMessage = virusScanErrorMessage(error);
    let released: DriveQuarantineDeletionRow | null;
    try {
      released = await withTenantPostgresContext(context.sql, { orgId: deletion.org_id }, (tx) =>
        releaseDriveQuarantineDeletion(tx, {
          id: deletion.id,
          orgId: deletion.org_id,
          status: deletionStatus,
          error: errorMessage,
          retryDelayMs: context.options.virusScanRetryDelayMs ?? DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS,
        }),
      );
    } catch (persistError) {
      emitQuarantineDeleteError(context, {
        orgId: deletion.org_id,
        objectId: deletion.object_id,
        storageKey: deletion.storage_key,
        attempts: deletion.attempt_count + 1,
        error: `${errorMessage}; cleanup state update failed: ${virusScanErrorMessage(persistError)}`,
      });
      return false;
    }
    emitQuarantineDeleteError(context, {
      orgId: deletion.org_id,
      objectId: deletion.object_id,
      storageKey: deletion.storage_key,
      attempts: released?.attempt_count ?? deletion.attempt_count + 1,
      error: errorMessage,
    });
    return false;
  }
}

export async function discardOrphanedQuarantineCopy(
  context: DriveStoreContext,
  orphan: DriveQuarantineDeletionRow,
): Promise<void> {
  const storage = await storageForOrg(context, orphan.org_id);
  try {
    if (storage === undefined) throw new Error("Drive upload content storage is not configured.");
    await storage.delete(orphan.storage_key);
  } catch (error) {
    const errorMessage = virusScanErrorMessage(error);
    try {
      await withTenantPostgresContext(context.sql, { orgId: orphan.org_id }, (tx) =>
        insertDriveQuarantineDeletion(tx, {
          orgId: orphan.org_id,
          objectId: orphan.object_id,
          actorId: orphan.actor_id,
          storageKey: orphan.storage_key,
          error: errorMessage,
        }),
      );
      emitQuarantineDeleteError(context, {
        orgId: orphan.org_id,
        objectId: orphan.object_id,
        storageKey: orphan.storage_key,
        attempts: 1,
        error: errorMessage,
      });
    } catch (persistError) {
      emitQuarantineDeleteError(context, {
        orgId: orphan.org_id,
        objectId: orphan.object_id,
        storageKey: orphan.storage_key,
        attempts: 1,
        error: `${errorMessage}; cleanup state insert failed: ${virusScanErrorMessage(persistError)}`,
      });
    }
  }
}

export function emitQuarantineDeleteError(
  context: DriveStoreContext,
  event: DriveQuarantineDeleteErrorEvent,
): void {
  try {
    context.options.onQuarantineDeleteError?.(event);
  } catch {
    // Reporting must never roll back or release quarantined content.
  }
}
