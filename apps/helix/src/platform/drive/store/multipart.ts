import { createHash } from "node:crypto";
import { canonicalizeJson } from "../../audit.js";
import { withTenantIoSagaPostgresContext as withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { stringMetadata } from "../core/mappers.js";
import { DriveConflictError, DriveForbiddenError } from "../errors.js";
import { validateCompletedParts } from "../multipart.js";
import type { DriveVersionRecord } from "../types.js";
import { appendDriveActivity } from "./activity.js";
import { requireUploadWriteAccess } from "./authz.js";
import { type DriveStoreContext } from "./context.js";
import { type CompleteMultipartUploadInput, type DriveStorageClient } from "./contracts.js";
import { mapVersion, numberFromBigIntLike } from "./mappers.js";
import {
  type DriveMultipartClaim,
  type DriveMultipartSessionRow,
  type DriveMultipartSweepRow,
  type DriveVersionRow,
  type SqlLike,
} from "./rows.js";
import { DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS } from "./scan-claims.js";
import { isMissingStorageObject, virusScanErrorMessage } from "./scan-content.js";
import { storageForOrg } from "./storage.js";
import { DEFAULT_UPLOAD_LEASE_MS } from "./upload-commits.js";
import { discardPreparedUpload } from "./upload-expiry.js";
import { finalizeUpload } from "./uploads.js";
import { getLatestDriveVersion } from "./versions.js";
export async function insertDriveMultipartSession(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly objectId: string;
    readonly actorId: string;
    readonly storageKey: string;
    readonly byteSize: number;
    readonly partSize: number;
    readonly partCount: number;
    readonly expiresAt: Date;
  },
): Promise<void> {
  await sql`
    insert into drive_multipart_sessions (
      org_id, object_id, actor_id, storage_key, byte_size, part_size, part_count, expires_at
    ) values (
      ${input.orgId}, ${input.objectId}, ${input.actorId}, ${input.storageKey}, ${input.byteSize},
      ${input.partSize}, ${input.partCount}, ${input.expiresAt}
    )
  `;
}

export async function bindDriveMultipartSession(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  uploadId: string,
): Promise<void> {
  const rows = await sql<
    {
      readonly id: string;
    }[]
  >`
    update drive_multipart_sessions
    set upload_id = ${uploadId}, updated_at = now()
    where org_id = ${orgId} and object_id = ${objectId} and status = 'provisioning'
    returning id
  `;
  if (rows[0] === undefined)
    throw new DriveConflictError("Multipart upload session is unavailable.");
}

export async function activateDriveMultipartSession(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  uploadId: string,
): Promise<void> {
  const rows = await sql<
    {
      readonly id: string;
    }[]
  >`
    update drive_multipart_sessions
    set status = 'pending', next_attempt_at = expires_at, updated_at = now()
    where org_id = ${orgId} and object_id = ${objectId}
      and upload_id = ${uploadId} and status = 'provisioning'
    returning id
  `;
  if (rows[0] === undefined)
    throw new DriveConflictError("Multipart upload session is unavailable.");
}

async function scheduleDriveMultipartAbort(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly objectId: string;
    readonly uploadId: string;
    readonly error: string;
  },
): Promise<void> {
  await sql`
    update drive_multipart_sessions
    set upload_id = ${input.uploadId}, status = 'aborting', lease_expires_at = now(), next_attempt_at = now(),
        last_error = ${input.error}, updated_at = now()
    where org_id = ${input.orgId} and object_id = ${input.objectId}
      and status in ('provisioning', 'pending')
      and (upload_id is null or upload_id = ${input.uploadId})
  `;
}

function multipartCompletionHash(input: CompleteMultipartUploadInput): string {
  return createHash("sha256")
    .update(
      canonicalizeJson({
        objectId: input.objectId,
        uploadId: input.uploadId,
        parts: [...input.parts].sort((a, b) => a.partNumber - b.partNumber),
        byteSize: input.byteSize,
        sha256: input.sha256?.toLowerCase() ?? null,
        mimeType: input.mimeType ?? null,
        metadata: input.metadata ?? {},
      }),
    )
    .digest("hex");
}

async function claimDriveMultipartCompletion(
  sql: SqlLike,
  input: CompleteMultipartUploadInput,
  completionHash: string,
): Promise<DriveMultipartClaim> {
  const object = await requireUploadWriteAccess(sql, input.orgId, input.actorId, input.objectId);
  const rows = await sql<DriveMultipartSessionRow[]>`
    select * from drive_multipart_sessions
    where org_id = ${input.orgId} and object_id = ${input.objectId} and upload_id = ${input.uploadId}
    limit 1 for update
  `;
  const session = rows[0];
  if (session === undefined) throw new DriveConflictError("Unknown multipart upload session.");
  if (session.actor_id !== input.actorId) {
    throw new DriveForbiddenError(
      "Only the actor who prepared this multipart upload may complete it.",
    );
  }
  if (numberFromBigIntLike(session.byte_size) !== input.byteSize) {
    throw new DriveConflictError("Multipart upload size does not match its prepared plan.");
  }
  const validated = validateCompletedParts(input.parts, session.part_count);
  if (!validated.ok) throw new DriveConflictError(validated.reason);
  if (session.completion_hash !== null && session.completion_hash !== completionHash) {
    throw new DriveConflictError("Multipart completion payload does not match the first attempt.");
  }
  if (session.status === "completed") {
    const version = await getDriveMultipartVersion(sql, session);
    if (version === null)
      throw new DriveConflictError("Completed multipart version is unavailable.");
    return { session, object, version, completeStorage: false };
  }
  if (session.status === "uploaded" && stringMetadata(object.metadata, "status") === "ready") {
    const version = await getLatestDriveVersion(sql, input.orgId, input.objectId);
    if (version === null)
      throw new DriveConflictError("Completed multipart version is unavailable.");
    await markDriveMultipartCompleted(sql, session, completionHash, version.id);
    return { session, object, version, completeStorage: false };
  }
  if (session.status === "provisioning" || session.status === "aborting") {
    throw new DriveConflictError("Multipart upload session is not ready for completion.");
  }
  const now = Date.now();
  if (session.status === "pending" && session.expires_at.getTime() <= now) {
    throw new DriveConflictError("Multipart upload session has expired.");
  }
  if (
    session.status === "completing" &&
    (session.lease_expires_at?.getTime() ?? Number.POSITIVE_INFINITY) > now
  ) {
    throw new DriveConflictError("Multipart upload completion is already in progress.");
  }
  if (session.status === "uploaded") {
    return { session, object, completeStorage: false };
  }
  const claimedRows = await sql<DriveMultipartSessionRow[]>`
    update drive_multipart_sessions
    set status = 'completing', completion_hash = ${completionHash},
        lease_expires_at = ${new Date(now + DEFAULT_UPLOAD_LEASE_MS)}, updated_at = now()
    where id = ${session.id} and org_id = ${session.org_id}
      and status = ${session.status}
    returning *
  `;
  const claimed = claimedRows[0];
  if (claimed === undefined)
    throw new DriveConflictError("Multipart upload completion raced another request.");
  return { session: claimed, object, completeStorage: true };
}

async function markDriveMultipartUploaded(
  sql: SqlLike,
  session: DriveMultipartSessionRow,
  completionHash: string,
): Promise<void> {
  await sql`
    update drive_multipart_sessions
    set status = 'uploaded', completion_hash = ${completionHash}, lease_expires_at = null,
        last_error = null, updated_at = now()
    where id = ${session.id} and org_id = ${session.org_id}
      and status in ('completing', 'uploaded')
  `;
}

async function markDriveMultipartCompleted(
  sql: SqlLike,
  session: DriveMultipartSessionRow,
  completionHash: string,
  versionId: string,
): Promise<void> {
  await sql`
    update drive_multipart_sessions
    set status = 'completed', completion_hash = ${completionHash}, version_id = ${versionId},
        lease_expires_at = null, last_error = null, updated_at = now()
    where id = ${session.id} and org_id = ${session.org_id}
      and completion_hash = ${completionHash} and status in ('uploaded', 'completed')
  `;
}

async function releaseDriveMultipartCompletion(
  sql: SqlLike,
  session: DriveMultipartSessionRow,
  error: string,
): Promise<void> {
  await sql`
    update drive_multipart_sessions
    set status = 'pending', lease_expires_at = null, next_attempt_at = expires_at,
        last_error = ${error}, updated_at = now()
    where id = ${session.id} and org_id = ${session.org_id} and status = 'completing'
  `;
}

export async function claimExpiredDriveMultipartSessions(
  sql: SqlLike,
  input: {
    readonly limit: number;
    readonly now: Date;
    readonly leaseExpiresAt: Date;
  },
): Promise<readonly DriveMultipartSweepRow[]> {
  return await sql<DriveMultipartSweepRow[]>`
    with candidates as materialized (
      select id, status as prior_status
      from drive_multipart_sessions
      where expires_at <= ${input.now}
        and (
          status in ('provisioning', 'pending')
          or (status in ('completing', 'aborting') and lease_expires_at <= ${input.now})
          or (
            status = 'uploaded'
            and not exists (
              select 1 from drive_scan_jobs jobs
              where jobs.org_id = drive_multipart_sessions.org_id
                and jobs.object_id = drive_multipart_sessions.object_id
            )
          )
        )
        and next_attempt_at <= ${input.now}
        and exists (
          select 1 from objects object
          where object.org_id = drive_multipart_sessions.org_id
            and object.id = drive_multipart_sessions.object_id
            and coalesce(object.metadata->>'status', 'ready') <> 'ready'
            and (
              object.metadata->>'status' <> 'scan_processing'
              or (object.metadata->>'scanLeaseExpiresAt')::timestamptz <= ${input.now}
            )
        )
      order by expires_at asc, created_at asc
      limit ${Math.max(1, Math.trunc(input.limit))}
      for update skip locked
    ), claimed as (
      update drive_multipart_sessions session
      set status = 'aborting', lease_expires_at = ${input.leaseExpiresAt}, updated_at = now()
      from candidates
      where session.id = candidates.id
      returning session.*
    )
    select claimed.*, candidates.prior_status
    from claimed join candidates on candidates.id = claimed.id
  `;
}

async function releaseDriveMultipartAbort(
  sql: SqlLike,
  session: DriveMultipartSessionRow,
  error: string,
  retryDelayMs: number,
): Promise<void> {
  const retryAt = new Date(Date.now() + Math.max(1, retryDelayMs));
  await sql`
    update drive_multipart_sessions
    set status = 'aborting', next_attempt_at = ${retryAt}, lease_expires_at = ${retryAt},
        last_error = ${error}, updated_at = now()
    where id = ${session.id} and org_id = ${session.org_id} and status = 'aborting'
  `;
}

async function getDriveMultipartVersion(
  sql: SqlLike,
  session: DriveMultipartSessionRow,
): Promise<DriveVersionRecord | null> {
  if (session.version_id === null) return null;
  const rows = await sql<DriveVersionRow[]>`
    select * from drive_versions
    where id = ${session.version_id} and org_id = ${session.org_id} and object_id = ${session.object_id}
    limit 1
  `;
  return rows[0] === undefined ? null : mapVersion(rows[0]);
}

export async function completeMultipartUpload(
  context: DriveStoreContext,
  input: CompleteMultipartUploadInput,
): Promise<DriveVersionRecord> {
  const validated = validateCompletedParts(input.parts, input.parts.length);
  if (!validated.ok) {
    throw new DriveConflictError(validated.reason);
  }
  const completionHash = multipartCompletionHash(input);
  const claim = await withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    (tx) => claimDriveMultipartCompletion(tx, input, completionHash),
  );
  if (claim.version !== undefined) return claim.version;
  const storage = await storageForOrg(context, input.orgId);
  if (storage?.completeMultipartUpload === undefined) {
    await releaseMultipartCompletion(context, claim.session, "Multipart storage is unavailable.");
    throw new Error("Drive multipart upload is not configured for this storage client.");
  }
  if (claim.completeStorage) {
    try {
      await storage.completeMultipartUpload(claim.session.storage_key, input.uploadId, input.parts);
    } catch (error) {
      const uploaded = await storage.get(claim.session.storage_key).catch(() => null);
      if (uploaded === null) {
        await releaseMultipartCompletion(context, claim.session, virusScanErrorMessage(error));
        throw error;
      }
    }
    await withTenantPostgresContext(context.sql, { orgId: input.orgId }, (tx) =>
      markDriveMultipartUploaded(tx, claim.session, completionHash),
    );
  }
  const version = await finalizeUpload(context, {
    orgId: input.orgId,
    actorId: input.actorId,
    objectId: input.objectId,
    byteSize: input.byteSize,
    ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
    ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    idempotencyKey: completionHash,
  });
  await withTenantPostgresContext(context.sql, { orgId: input.orgId }, (tx) =>
    markDriveMultipartCompleted(tx, claim.session, completionHash, version.id),
  );
  return version;
}

export async function compensatePreparedMultipart(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly storage: DriveStorageClient | undefined;
    readonly storageKey: string;
    readonly uploadId: string | undefined;
    readonly error: unknown;
  },
): Promise<void> {
  if (input.uploadId === undefined) {
    await discardPreparedUpload(context, input.orgId, input.actorId, input.objectId);
    return;
  }
  try {
    if (input.storage?.abortMultipartUpload === undefined) {
      throw new Error("Multipart abort is not configured.");
    }
    await input.storage.abortMultipartUpload(input.storageKey, input.uploadId);
    await discardPreparedUpload(context, input.orgId, input.actorId, input.objectId);
  } catch (abortError) {
    await withTenantPostgresContext(context.sql, { orgId: input.orgId }, (tx) =>
      scheduleDriveMultipartAbort(tx, {
        orgId: input.orgId,
        objectId: input.objectId,
        uploadId: input.uploadId as string,
        error: `${virusScanErrorMessage(input.error)}; abort: ${virusScanErrorMessage(abortError)}`,
      }),
    );
  }
}

async function releaseMultipartCompletion(
  context: DriveStoreContext,
  session: DriveMultipartSessionRow,
  error: string,
): Promise<void> {
  await withTenantPostgresContext(context.sql, { orgId: session.org_id }, (tx) =>
    releaseDriveMultipartCompletion(tx, session, error),
  );
}

export async function abortExpiredMultipart(
  context: DriveStoreContext,
  session: DriveMultipartSweepRow,
): Promise<boolean> {
  try {
    const storage = await storageForOrg(context, session.org_id);
    if (session.upload_id !== null) {
      if (storage?.abortMultipartUpload === undefined) {
        throw new Error("Multipart abort is not configured.");
      }
      await storage
        .abortMultipartUpload(session.storage_key, session.upload_id)
        .catch((error: unknown) => {
          if (!isMissingStorageObject(error)) throw error;
        });
    }
    if (storage !== undefined) {
      await storage.delete(session.storage_key).catch((error: unknown) => {
        if (!isMissingStorageObject(error)) throw error;
      });
    }
    await withTenantPostgresContext(context.sql, { orgId: session.org_id }, async (tx) => {
      if (session.actor_id !== null) {
        await appendDriveActivity(tx, {
          orgId: session.org_id,
          actorId: session.actor_id,
          verb: "drive.upload.multipart_expired",
          objectId: session.object_id,
          payload: { priorStatus: session.prior_status },
        });
      }
      await tx`
          delete from permissions
          where org_id = ${session.org_id} and resource_type = 'object'
            and resource_id = ${session.object_id}
        `;
      await tx`
          delete from objects
          where org_id = ${session.org_id} and id = ${session.object_id}
            and coalesce(metadata->>'status', 'ready') <> 'ready'
        `;
      await tx`
          delete from drive_multipart_sessions
          where id = ${session.id} and org_id = ${session.org_id} and status = 'aborting'
        `;
    });
    return true;
  } catch (error) {
    await withTenantPostgresContext(context.sql, { orgId: session.org_id }, (tx) =>
      releaseDriveMultipartAbort(
        tx,
        session,
        virusScanErrorMessage(error),
        context.options.virusScanRetryDelayMs ?? DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS,
      ),
    ).catch(() => undefined);
    return false;
  }
}
