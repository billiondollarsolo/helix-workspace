import { withTenantIoSagaPostgresContext as withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { appendDriveActivity } from "./activity.js";
import { type DriveStoreContext } from "./context.js";
import { type DrivePreparedUploadSweepRow, type SqlLike } from "./rows.js";
import { DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS } from "./scan-claims.js";
import { isMissingStorageObject, virusScanErrorMessage } from "./scan-content.js";
import { storageForOrg } from "./storage.js";
export async function claimExpiredPreparedUploads(
  sql: SqlLike,
  input: {
    readonly limit: number;
    readonly now: Date;
    readonly leaseExpiresAt: Date;
  },
): Promise<readonly DrivePreparedUploadSweepRow[]> {
  return await sql<DrivePreparedUploadSweepRow[]>`
    with candidates as (
      select object.id
      from objects object
      where object.kind = 'file' and object.deleted_at is null
        and not exists (
          select 1 from drive_multipart_sessions session
          where session.org_id = object.org_id and session.object_id = object.id
        )
        and (
          (
            object.metadata->>'status' = 'pending_upload'
            and (object.metadata->>'uploadExpiresAt')::timestamptz <= ${input.now}
          ) or (
            object.metadata->>'status' = 'upload_expiring'
            and (object.metadata->>'uploadCleanupLeaseExpiresAt')::timestamptz <= ${input.now}
          ) or (
            object.metadata->>'status' = 'scan_processing'
            and object.metadata->>'scanPreviousStatus' = 'pending_upload'
            and (object.metadata->>'uploadExpiresAt')::timestamptz <= ${input.now}
            and (object.metadata->>'scanLeaseExpiresAt')::timestamptz <= ${input.now}
          )
        )
      order by object.created_at asc
      limit ${Math.max(1, Math.trunc(input.limit))}
      for update skip locked
    )
    update objects object
    set metadata = object.metadata || jsonb_build_object(
          'status', 'upload_expiring',
          'uploadCleanupLeaseExpiresAt', ${input.leaseExpiresAt.toISOString()}::text
        ),
        updated_at = now()
    from candidates
    where object.id = candidates.id
    returning object.*
  `;
}

async function releaseExpiredPreparedUpload(
  sql: SqlLike,
  object: DrivePreparedUploadSweepRow,
  error: string,
  retryDelayMs: number,
): Promise<void> {
  const retryAt = new Date(Date.now() + Math.max(1, retryDelayMs)).toISOString();
  await sql`
    update objects
    set metadata = metadata || jsonb_build_object(
          'status', 'upload_expiring',
          'uploadCleanupLeaseExpiresAt', ${retryAt}::text,
          'uploadCleanupError', ${error}::text
        ),
        updated_at = now()
    where org_id = ${object.org_id} and id = ${object.id}
      and metadata->>'status' = 'upload_expiring'
  `;
}

export async function discardPreparedUpload(
  context: DriveStoreContext,
  orgId: string,
  actorId: string,
  objectId: string,
): Promise<void> {
  await withTenantPostgresContext(context.sql, { orgId }, async (tx) => {
    await appendDriveActivity(tx, {
      orgId,
      actorId,
      verb: "drive.upload.prepare_failed",
      objectId,
      payload: {},
    });
    await tx`
        delete from permissions
        where org_id = ${orgId} and resource_type = 'object' and resource_id = ${objectId}
      `;
    await tx`delete from drive_multipart_sessions where org_id = ${orgId} and object_id = ${objectId}`;
    await tx`
        delete from objects
        where org_id = ${orgId} and id = ${objectId}
          and coalesce(metadata->>'status', 'ready') = 'pending_upload'
      `;
  });
}

export async function deleteExpiredPreparedUpload(
  context: DriveStoreContext,
  object: DrivePreparedUploadSweepRow,
): Promise<boolean> {
  try {
    const storage = await storageForOrg(context, object.org_id);
    await storage?.delete(object.storage_key).catch((error: unknown) => {
      if (!isMissingStorageObject(error)) throw error;
    });
    await withTenantPostgresContext(context.sql, { orgId: object.org_id }, async (tx) => {
      if (object.owner_actor_id !== null) {
        await appendDriveActivity(tx, {
          orgId: object.org_id,
          actorId: object.owner_actor_id,
          verb: "drive.upload.expired",
          objectId: object.id,
          payload: {},
        });
      }
      await tx`
          delete from permissions
          where org_id = ${object.org_id} and resource_type = 'object' and resource_id = ${object.id}
        `;
      await tx`
          delete from objects
          where org_id = ${object.org_id} and id = ${object.id}
            and metadata->>'status' = 'upload_expiring'
        `;
    });
    return true;
  } catch (error) {
    await withTenantPostgresContext(context.sql, { orgId: object.org_id }, (tx) =>
      releaseExpiredPreparedUpload(
        tx,
        object,
        virusScanErrorMessage(error),
        context.options.virusScanRetryDelayMs ?? DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS,
      ),
    ).catch(() => undefined);
    return false;
  }
}
