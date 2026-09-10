import { randomUUID } from "node:crypto";
import { toSqlJson } from "../../util/sql.js";
import { stringMetadata } from "../core/mappers.js";
import { DriveConflictError, DriveForbiddenError } from "../errors.js";
import type { DriveVersionRecord } from "../types.js";
import { appendDriveActivity } from "./activity.js";
import { requireUploadWriteAccess } from "./authz.js";
import { finalizedStorageDelta, releaseDriveBlobReservation, upsertDriveBlobRef } from "./blobs.js";
import { type FinalizeDriveUploadInput, type StorageQuotaExceededEvent } from "./contracts.js";
import { mapVersion } from "./mappers.js";
import {
  withoutDriveDerivedContentMetadata,
  withoutDriveFinalizationMetadata,
  withoutDriveUploadLifecycleMetadata,
  withoutVirusScanFailureMetadata,
} from "./metadata.js";
import { insertDriveQuarantineDeletion } from "./quarantine.js";
import { commitStorageUsage } from "./quotas.js";
import {
  type DriveFinalizationClaim,
  type DriveQuarantineDeletionRow,
  type DriveScanFailureRow,
  type DriveVersionRow,
  type ObjectRow,
  type SqlLike,
} from "./rows.js";
import { recordDriveScanFailure } from "./scan-claims.js";
export const DEFAULT_UPLOAD_LEASE_MS = 120000;

export async function claimDriveUploadFinalization(
  sql: SqlLike,
  input: FinalizeDriveUploadInput,
  fromRetryWorker: boolean,
): Promise<DriveFinalizationClaim> {
  const current = await requireUploadWriteAccess(sql, input.orgId, input.actorId, input.objectId);
  const status = stringMetadata(current.metadata, "status") ?? "ready";
  if (status === "scan_dead_letter") {
    throw new DriveConflictError(
      "Virus scan retries are exhausted; an administrator must authorize another scan.",
    );
  }
  if (status === "infected") {
    throw new DriveConflictError("Drive object is quarantined and cannot be promoted.");
  }
  if (status === "scan_pending" && !fromRetryWorker) {
    throw new DriveConflictError("Virus scanning is queued for retry.");
  }
  const priorToken = stringMetadata(current.metadata, "scanToken");
  const priorLease = stringMetadata(current.metadata, "scanLeaseExpiresAt");
  if (
    status === "scan_processing" &&
    (priorLease === undefined || new Date(priorLease).getTime() > Date.now())
  ) {
    throw new DriveConflictError("Drive upload finalization is already in progress.");
  }
  const previousStatus =
    status === "scan_processing"
      ? (stringMetadata(current.metadata, "scanPreviousStatus") ?? "pending_upload")
      : status;
  if (
    status === "scan_processing" &&
    previousStatus === "pending_upload" &&
    stringMetadata(current.metadata, "scanActorId") !== input.actorId
  ) {
    throw new DriveForbiddenError("Only the actor who started this upload may resume it.");
  }
  const reservedKey = current.storage_key;
  const versionRows = await sql<
    {
      readonly version_number: number;
    }[]
  >`
    select coalesce(max(version_number), 0)::integer + 1 as version_number
    from drive_versions where org_id = ${input.orgId} and object_id = ${input.objectId}
  `;
  const versionNumber = versionRows[0]?.version_number ?? 1;
  const token = randomUUID();
  const metadata = {
    ...withoutDriveFinalizationMetadata(current.metadata),
    status: "scan_processing",
    scanToken: token,
    scanActorId: input.actorId,
    scanPreviousStatus: previousStatus,
    scanLeaseExpiresAt: new Date(Date.now() + DEFAULT_UPLOAD_LEASE_MS).toISOString(),
  };
  const claimedRows = await sql<ObjectRow[]>`
    update objects
    set metadata = ${sql.json(toSqlJson(metadata))}, updated_at = now()
    where id = ${input.objectId} and org_id = ${input.orgId}
      and coalesce(metadata->>'status', 'ready') = ${status}
      and (${status !== "scan_processing"} or metadata->>'scanToken' = ${priorToken ?? ""})
    returning *
  `;
  const object = claimedRows[0];
  if (object === undefined) {
    throw new DriveConflictError("Drive upload finalization raced another request.");
  }
  return { object, token, previousStatus, reservedKey, versionNumber };
}

export async function findIdempotentDriveVersion(
  sql: SqlLike,
  input: FinalizeDriveUploadInput,
): Promise<DriveVersionRecord | null> {
  if (input.idempotencyKey === undefined) return null;
  await requireUploadWriteAccess(sql, input.orgId, input.actorId, input.objectId);
  const rows = await sql<DriveVersionRow[]>`
    select * from drive_versions
    where org_id = ${input.orgId} and object_id = ${input.objectId}
      and idempotency_key = ${input.idempotencyKey}
    limit 1
  `;
  return rows[0] === undefined ? null : mapVersion(rows[0]);
}

async function requireDriveFinalizationClaim(
  sql: SqlLike,
  claim: DriveFinalizationClaim,
  actorId: string,
): Promise<ObjectRow> {
  const object = await requireUploadWriteAccess(sql, claim.object.org_id, actorId, claim.object.id);
  if (
    stringMetadata(object.metadata, "status") !== "scan_processing" ||
    stringMetadata(object.metadata, "scanToken") !== claim.token
  ) {
    throw new DriveConflictError("Drive upload finalization lease was lost.");
  }
  return object;
}

export async function commitDriveScanFailure(
  sql: SqlLike,
  input: {
    readonly claim: DriveFinalizationClaim;
    readonly input: FinalizeDriveUploadInput;
    readonly mimeType: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly error: string;
    readonly maxAttempts: number;
    readonly retryDelayMs: number;
  },
): Promise<DriveScanFailureRow> {
  const current = await requireDriveFinalizationClaim(sql, input.claim, input.input.actorId);
  const failure = await recordDriveScanFailure(sql, {
    orgId: input.input.orgId,
    objectId: input.input.objectId,
    actorId: input.input.actorId,
    error: input.error,
    finalizeMetadata: input.input.metadata ?? {},
    maxAttempts: input.maxAttempts,
    retryDelayMs: input.retryDelayMs,
  });
  const rows = await sql<
    {
      readonly id: string;
    }[]
  >`
    update objects
    set mime_type = ${input.mimeType}, byte_size = ${input.byteSize}, sha256 = ${input.sha256},
        metadata = ${sql.json(
          toSqlJson({
            ...withoutDriveFinalizationMetadata(current.metadata),
            status: failure.status === "dead_lettered" ? "scan_dead_letter" : "scan_pending",
            avScanAttempts: failure.attempt_count,
            avScanLastError: input.error,
            avScanNextAttemptAt: failure.next_attempt_at?.toISOString() ?? null,
          }),
        )}, updated_at = now()
    where id = ${input.input.objectId} and org_id = ${input.input.orgId}
      and metadata->>'scanToken' = ${input.claim.token}
    returning id
  `;
  if (rows[0] === undefined)
    throw new DriveConflictError("Drive upload finalization lease was lost.");
  await appendDriveActivity(sql, {
    orgId: input.input.orgId,
    actorId: input.input.actorId,
    verb:
      failure.status === "dead_lettered"
        ? "drive.upload.scan_dead_lettered"
        : "drive.upload.scan_retry_scheduled",
    objectId: input.input.objectId,
    payload: {
      attempts: failure.attempt_count,
      error: input.error,
      nextAttemptAt: failure.next_attempt_at?.toISOString() ?? null,
    },
  });
  return failure;
}

export async function commitDriveInfectedVerdict(
  sql: SqlLike,
  input: {
    readonly claim: DriveFinalizationClaim;
    readonly input: FinalizeDriveUploadInput;
    readonly mimeType: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly signature: string;
    readonly quarantineSource?: "dlp";
    readonly dlpClassification?: string;
    readonly quarantineKey: string;
    readonly quarantineStored: boolean;
    readonly hasStagedBytes: boolean;
  },
): Promise<readonly DriveQuarantineDeletionRow[]> {
  const current = await requireDriveFinalizationClaim(sql, input.claim, input.input.actorId);
  await sql`
    delete from drive_scan_jobs
    where org_id = ${input.input.orgId} and object_id = ${input.input.objectId}
  `;
  await sql`
    delete from drive_multipart_sessions
    where org_id = ${input.input.orgId} and object_id = ${input.input.objectId}
      and status in ('uploaded', 'completing')
  `;
  const rows = await sql<
    {
      readonly id: string;
    }[]
  >`
    update objects
    set storage_key = ${input.quarantineStored ? input.quarantineKey : current.storage_key},
        mime_type = ${input.mimeType}, byte_size = ${input.byteSize}, sha256 = ${input.sha256},
        metadata = ${sql.json(
          toSqlJson({
            ...withoutDriveDerivedContentMetadata(
              withoutDriveUploadLifecycleMetadata(
                withoutDriveFinalizationMetadata(current.metadata),
              ),
            ),
            status: "infected",
            ...(input.quarantineSource === "dlp"
              ? {
                  dlpVerdict: "quarantined",
                  dlpClassification: input.dlpClassification ?? "restricted",
                }
              : { avSignature: input.signature }),
            quarantinedAt: new Date().toISOString(),
          }),
        )}, updated_at = now()
    where id = ${input.input.objectId} and org_id = ${input.input.orgId}
      and metadata->>'scanToken' = ${input.claim.token}
    returning id
  `;
  if (rows[0] === undefined)
    throw new DriveConflictError("Drive upload finalization lease was lost.");
  const keys = new Set<string>();
  if (input.quarantineStored) keys.add(input.quarantineKey);
  if (input.hasStagedBytes) keys.add(input.claim.reservedKey);
  const deletions: DriveQuarantineDeletionRow[] = [];
  for (const storageKey of keys) {
    deletions.push(
      await insertDriveQuarantineDeletion(sql, {
        orgId: input.input.orgId,
        objectId: input.input.objectId,
        actorId: input.input.actorId,
        storageKey,
      }),
    );
  }
  await appendDriveActivity(sql, {
    orgId: input.input.orgId,
    actorId: input.input.actorId,
    verb: "drive.upload.quarantined",
    objectId: input.input.objectId,
    payload: {
      signature: input.signature,
      source: input.quarantineSource ?? "antivirus",
      ...(input.dlpClassification === undefined ? {} : { classification: input.dlpClassification }),
    },
  });
  return deletions;
}

export async function commitDriveCleanUpload(
  sql: SqlLike,
  input: {
    readonly claim: DriveFinalizationClaim;
    readonly input: FinalizeDriveUploadInput;
    readonly storageKey: string;
    readonly mimeType: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly dedup: boolean;
    readonly blobReservationId?: string;
    readonly emitQuotaExceeded: (
      event: Omit<StorageQuotaExceededEvent, "bucket" | "quota">,
    ) => void;
  },
): Promise<{
  readonly version: DriveVersionRecord;
  readonly stagedDeletion?: DriveQuarantineDeletionRow;
}> {
  const current = await requireDriveFinalizationClaim(sql, input.claim, input.input.actorId);
  const original = {
    ...current,
    metadata: {
      ...withoutDriveFinalizationMetadata(current.metadata),
      status: input.claim.previousStatus,
    },
  };
  let storageDelta = finalizedStorageDelta(original, input.storageKey, input.byteSize);
  if (input.dedup) {
    const newlyReferenced = await upsertDriveBlobRef(sql, {
      orgId: input.input.orgId,
      sha256: input.sha256,
      storageKey: input.storageKey,
      byteSize: input.byteSize,
    });
    storageDelta = newlyReferenced ? input.byteSize : 0;
    if (input.blobReservationId === undefined) {
      throw new Error("Drive blob commit is missing its durable reservation.");
    }
    await releaseDriveBlobReservation(sql, input.input.orgId, input.blobReservationId);
  }
  const versionRows = await sql<DriveVersionRow[]>`
    insert into drive_versions (
      org_id, object_id, version_number, storage_key, mime_type, byte_size, sha256, metadata,
      created_by_actor_id, idempotency_key
    ) values (
      ${input.input.orgId}, ${input.input.objectId}, ${input.claim.versionNumber},
      ${input.storageKey}, ${input.mimeType}, ${input.byteSize}, ${input.sha256},
      ${sql.json(
        toSqlJson({
          ...withoutDriveDerivedContentMetadata(input.input.metadata ?? {}),
        }),
      )},
      ${input.input.actorId}, ${input.input.idempotencyKey ?? null}
    ) returning *
  `;
  const version = mapVersion(versionRows[0]);
  const rows = await sql<
    {
      readonly id: string;
    }[]
  >`
    update objects
    set storage_key = ${input.storageKey}, mime_type = ${input.mimeType}, byte_size = ${input.byteSize},
        sha256 = ${input.sha256},
        metadata = ${sql.json(
          toSqlJson({
            ...withoutDriveUploadLifecycleMetadata(
              withoutDriveDerivedContentMetadata(
                withoutVirusScanFailureMetadata(withoutDriveFinalizationMetadata(current.metadata)),
              ),
            ),
            ...withoutDriveDerivedContentMetadata(input.input.metadata ?? {}),
            status: "ready",
            avScannedAt: new Date().toISOString(),
            latestVersionId: version.id,
            versionNumber: version.versionNumber,
          }),
        )}, updated_at = now()
    where id = ${input.input.objectId} and org_id = ${input.input.orgId}
      and metadata->>'scanToken' = ${input.claim.token}
    returning id
  `;
  if (rows[0] === undefined)
    throw new DriveConflictError("Drive upload finalization lease was lost.");
  await commitStorageUsage(
    sql,
    input.input.orgId,
    input.input.objectId,
    storageDelta,
    "drive",
    input.emitQuotaExceeded,
  );
  await sql`
    update drive_multipart_sessions
    set status = 'completed', version_id = ${version.id}, lease_expires_at = null,
        last_error = null, updated_at = now()
    where org_id = ${input.input.orgId} and object_id = ${input.input.objectId}
      and status = 'uploaded' and completion_hash is not null
  `;
  await sql`
    delete from drive_scan_jobs
    where org_id = ${input.input.orgId} and object_id = ${input.input.objectId}
  `;
  const stagedDeletion =
    input.input.content === undefined &&
    input.claim.previousStatus !== "ready" &&
    input.claim.reservedKey !== input.storageKey
      ? await insertDriveQuarantineDeletion(sql, {
          orgId: input.input.orgId,
          objectId: input.input.objectId,
          actorId: input.input.actorId,
          storageKey: input.claim.reservedKey,
        })
      : undefined;
  await appendDriveActivity(sql, {
    orgId: input.input.orgId,
    actorId: input.input.actorId,
    verb: "drive.upload.finalized",
    objectId: input.input.objectId,
    payload: {
      versionId: version.id,
      versionNumber: version.versionNumber,
      byteSize: input.byteSize,
      sha256: input.sha256,
    },
  });
  return { version, ...(stagedDeletion === undefined ? {} : { stagedDeletion }) };
}

export async function releaseDriveFinalizationClaim(
  sql: SqlLike,
  claim: DriveFinalizationClaim,
): Promise<void> {
  await sql`
    update objects
    set metadata = ${sql.json(
      toSqlJson({
        ...withoutDriveFinalizationMetadata(claim.object.metadata),
        status: claim.previousStatus,
      }),
    )}, updated_at = now()
    where id = ${claim.object.id} and org_id = ${claim.object.org_id}
      and metadata->>'scanToken' = ${claim.token}
  `;
}
