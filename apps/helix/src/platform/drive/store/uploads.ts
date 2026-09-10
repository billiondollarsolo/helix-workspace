import type { JsonObject } from "@helix/sdk-types";
import { randomUUID } from "node:crypto";
import { dlpDecisionError } from "../../dlp.js";
import { grantObjectAccess } from "../../permissions/grant-object-access.js";
import { withTenantIoSagaPostgresContext as withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { toSqlJson } from "../../util/sql.js";
import { isDriveBlobStorageKey, resolveFinalizeStorageKey } from "../core/dedup.js";
import { stringMetadata } from "../core/mappers.js";
import { driveQuarantineStorageKey, driveStorageKey } from "../core/storage-key.js";
import { DriveConflictError } from "../errors.js";
import {
  DEFAULT_MULTIPART_PART_SIZE,
  DEFAULT_MULTIPART_THRESHOLD,
  MAX_MULTIPART_PARTS,
  planMultipartParts,
  shouldUseMultipartUpload,
} from "../multipart.js";
import type { DriveUploadRecord, DriveUploadStatusRecord, DriveVersionRecord } from "../types.js";
import { driveUploadStateFromMetadata, userFacingDriveUploadState } from "../upload-state.js";
import { appendDriveActivity } from "./activity.js";
import { requireFolderAddChildren } from "./authz.js";
import {
  claimDriveBlobDestination,
  driveBlobStorageIsReferenced,
  releaseDriveBlobReservation,
} from "./blobs.js";
import { type DriveStoreContext } from "./context.js";
import { type FinalizeDriveUploadInput, type PrepareDriveUploadInput } from "./contracts.js";
import { mapUpload } from "./mappers.js";
import { driveObjectMetadata } from "./metadata.js";
import {
  activateDriveMultipartSession,
  bindDriveMultipartSession,
  compensatePreparedMultipart,
  insertDriveMultipartSession,
} from "./multipart.js";
import {
  deleteQuarantinedBytes,
  discardOrphanedQuarantineCopy,
  emitQuarantineDeleteError,
} from "./quarantine.js";
import { emitStorageQuotaExceeded, reserveDriveStorageQuota } from "./quotas.js";
import { type ObjectRow } from "./rows.js";
import {
  DEFAULT_VIRUS_SCAN_MAX_ATTEMPTS,
  DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS,
} from "./scan-claims.js";
import { inspectAndScanUpload, virusScanErrorMessage } from "./scan-content.js";
import { presignPutRequest, readStoredUpload, storageForOrg } from "./storage.js";
import {
  claimDriveUploadFinalization,
  commitDriveCleanUpload,
  commitDriveInfectedVerdict,
  commitDriveScanFailure,
  findIdempotentDriveVersion,
  releaseDriveFinalizationClaim,
} from "./upload-commits.js";
import { discardPreparedUpload } from "./upload-expiry.js";
const DEFAULT_MULTIPART_SESSION_TTL_MS = 15 * 60000;

export async function getUploadStatus(
  context: DriveStoreContext,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  },
): Promise<DriveUploadStatusRecord | null> {
  const rows = await context.sql<
    readonly {
      readonly id: string;
      readonly deleted_at: Date | null;
      readonly metadata: JsonObject;
      readonly updated_at: Date;
    }[]
  >`
      select id, updated_at, deleted_at, metadata
      from objects
      where id = ${input.objectId}
        and org_id = ${input.orgId}
        and kind = 'file'
        and (
          owner_actor_id = ${input.actorId}
          or exists (
            select 1 from permissions p
            where p.resource_type = 'object'
              and p.resource_id = objects.id
              and p.org_id = ${input.orgId}
              and p.actor_id = ${input.actorId}
              and (p.expires_at is null or p.expires_at > now())
          )
        )
      limit 1
    `;
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const state = driveUploadStateFromMetadata(row.metadata.status, row.deleted_at);
  const userFacing = userFacingDriveUploadState(state);
  return {
    objectId: row.id,
    state,
    ...userFacing,
    updatedAt: row.updated_at,
  };
}

export async function prepareUpload(
  context: DriveStoreContext,
  input: PrepareDriveUploadInput,
): Promise<DriveUploadRecord> {
  const storage = await storageForOrg(context, input.orgId);
  const threshold = context.options.multipartThresholdBytes ?? DEFAULT_MULTIPART_THRESHOLD;
  const partSize = context.options.multipartPartSizeBytes ?? DEFAULT_MULTIPART_PART_SIZE;
  const multipart =
    shouldUseMultipartUpload(input.byteSize, threshold) &&
    storage?.createMultipartUpload !== undefined &&
    storage.presignUploadPart !== undefined
      ? planMultipartParts(input.byteSize, partSize, MAX_MULTIPART_PARTS)
      : undefined;
  const expiresAt = new Date(
    Date.now() +
      Math.max(1000, context.options.multipartSessionTtlMs ?? DEFAULT_MULTIPART_SESSION_TTL_MS),
  );
  const prepared = await withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    async (tx) => {
      if (input.folderId !== undefined && input.folderId !== null) {
        await requireFolderAddChildren(tx, input.orgId, input.actorId, input.folderId);
      }
      const objectId = randomUUID();
      const storageKey = driveStorageKey(input.orgId, objectId, 1, input.name);
      const metadata = driveObjectMetadata({
        ...(input.metadata ?? {}),
        name: input.name,
        folderId: input.folderId ?? null,
        status: "pending_upload",
        uploadActorId: input.actorId,
        uploadExpiresAt: expiresAt.toISOString(),
      });
      const rows = await tx<ObjectRow[]>`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
        values (
          ${objectId},
          ${input.orgId},
          ${input.actorId},
          'file',
          ${storageKey},
          ${input.mimeType},
          ${input.byteSize},
          ${input.sha256 ?? null},
          ${tx.json(toSqlJson(metadata))}
        )
        returning *
      `;
      await reserveDriveStorageQuota(
        tx,
        input.orgId,
        objectId,
        input.byteSize,
        expiresAt,
        (event) => {
          emitStorageQuotaExceeded(context, input.orgId, event);
        },
      );
      await grantObjectAccess(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        objectId,
        role: rows[0]?.owner_actor_id === null ? "editor" : "owner",
        grantedByActorId: input.actorId,
      });
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.upload.prepared",
        objectId,
        payload: {
          name: input.name,
          folderId: input.folderId ?? null,
          storageKey,
        },
      });
      if (multipart !== undefined) {
        await insertDriveMultipartSession(tx, {
          orgId: input.orgId,
          objectId,
          actorId: input.actorId,
          storageKey,
          byteSize: input.byteSize,
          partSize: multipart.partSize,
          partCount: multipart.partCount,
          expiresAt,
        });
      }
      return mapUpload(rows[0]);
    },
  );
  if (multipart === undefined) {
    try {
      const upload = await presignPutRequest(context, storage, prepared.storageKey, input.mimeType);
      return {
        ...prepared,
        uploadUrl: upload?.url ?? null,
        uploadHeaders: upload?.headers ?? {},
      };
    } catch (error) {
      await discardPreparedUpload(context, input.orgId, input.actorId, prepared.objectId);
      throw error;
    }
  }
  let uploadId: string | undefined;
  try {
    if (storage?.createMultipartUpload === undefined || storage.presignUploadPart === undefined) {
      throw new Error("Drive multipart upload is not configured for this storage client.");
    }
    uploadId = (
      await storage.createMultipartUpload(prepared.storageKey, { contentType: input.mimeType })
    ).uploadId;
    const presignUploadPart = storage.presignUploadPart.bind(storage);
    await withTenantPostgresContext(context.sql, { orgId: input.orgId }, (tx) =>
      bindDriveMultipartSession(tx, input.orgId, prepared.objectId, uploadId as string),
    );
    const expiresSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
    const partUrls = await Promise.all(
      multipart.parts.map((part) =>
        presignUploadPart(prepared.storageKey, uploadId as string, part.partNumber, {
          contentType: input.mimeType,
          expiresSeconds,
        }),
      ),
    );
    await withTenantPostgresContext(context.sql, { orgId: input.orgId }, (tx) =>
      activateDriveMultipartSession(tx, input.orgId, prepared.objectId, uploadId as string),
    );
    return {
      ...prepared,
      uploadUrl: null,
      uploadHeaders: {},
      multipart: {
        uploadId,
        partSize: multipart.partSize,
        partCount: multipart.partCount,
        partUrls,
        expiresAt: expiresAt.toISOString(),
      },
    };
  } catch (error) {
    await compensatePreparedMultipart(context, {
      orgId: input.orgId,
      actorId: input.actorId,
      objectId: prepared.objectId,
      storage,
      storageKey: prepared.storageKey,
      uploadId,
      error,
    });
    throw error;
  }
}

export async function finalizeUpload(
  context: DriveStoreContext,
  input: FinalizeDriveUploadInput,
): Promise<DriveVersionRecord> {
  const startedAt = Date.now();
  try {
    const version = await finalizeUploadForScan(context, input, false);
    context.options.metrics?.recordOperationalEvent({
      capability: "drive",
      operation: "finalize",
      status: "success",
      durationSeconds: (Date.now() - startedAt) / 1000,
    });
    return version;
  } catch (error) {
    context.options.metrics?.recordOperationalEvent({
      capability: "drive",
      operation: "finalize",
      status: "error",
      durationSeconds: (Date.now() - startedAt) / 1000,
    });
    throw error;
  }
}

export async function finalizeUploadForScan(
  context: DriveStoreContext,
  input: FinalizeDriveUploadInput,
  fromRetryWorker: boolean,
): Promise<DriveVersionRecord> {
  if (input.idempotencyKey !== undefined) {
    const replay = await withTenantPostgresContext(
      context.sql,
      { orgId: input.orgId, actorId: input.actorId },
      (tx) => findIdempotentDriveVersion(tx, input),
    );
    if (replay !== null) return replay;
  }
  const claim = await withTenantPostgresContext(
    context.sql,
    { orgId: input.orgId, actorId: input.actorId },
    (tx) => claimDriveUploadFinalization(tx, input, fromRetryWorker),
  );
  let committed = false;
  let writtenStorageKey: string | undefined;
  let blobReservationId: string | undefined;
  try {
    const storage = await storageForOrg(context, input.orgId);
    if (input.content === undefined && storage === undefined) {
      throw new Error("Drive upload content storage is not configured.");
    }
    const inspected = await inspectAndScanUpload({
      open: async () =>
        input.content ?? (await readStoredUpload(storage, claim.reservedKey))?.body ?? null,
      declaredByteSize: input.byteSize,
      declaredMimeType: input.mimeType ?? claim.object.mime_type,
      scanner: context.virusScanner,
    });
    const { actualByteSize, actualSha256, mimeType, scan, bufferedBytes } = inspected;
    if (
      actualByteSize !== input.byteSize ||
      (input.sha256 !== undefined && actualSha256 !== input.sha256.toLowerCase())
    ) {
      throw new DriveConflictError("Drive upload size or sha256 does not match stored bytes.", {
        details: {
          expectedByteSize: input.byteSize,
          actualByteSize,
          expectedSha256: input.sha256 ?? null,
          actualSha256,
        },
      });
    }
    if (scan instanceof Error) {
      context.options.metrics?.recordOperationalEvent({
        capability: "drive",
        operation: "virus_scan",
        status: "error",
      });
      const error = scan;
      const errorMessage = virusScanErrorMessage(error);
      const failure = await withTenantPostgresContext(
        context.sql,
        { orgId: input.orgId, actorId: input.actorId },
        (tx) =>
          commitDriveScanFailure(tx, {
            claim,
            input,
            mimeType,
            byteSize: actualByteSize,
            sha256: actualSha256,
            error: errorMessage,
            maxAttempts: context.options.virusScanMaxAttempts ?? DEFAULT_VIRUS_SCAN_MAX_ATTEMPTS,
            retryDelayMs:
              context.options.virusScanRetryDelayMs ?? DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS,
          }),
      );
      committed = true;
      context.options.onVirusScanUnavailable?.({
        orgId: input.orgId,
        objectId: input.objectId,
        attempts: failure.attempt_count,
        status: failure.status,
        error: errorMessage,
      });
      throw new DriveConflictError("Virus scanning is temporarily unavailable.", {
        details: { attempts: failure.attempt_count, status: failure.status },
        ...(failure.next_attempt_at === null
          ? {}
          : {
              retryAfterSeconds: Math.max(
                1,
                Math.ceil((failure.next_attempt_at.getTime() - Date.now()) / 1000),
              ),
            }),
      });
    }
    const dlpDecision = await context.options.dlp?.evaluate({
      orgId: input.orgId,
      actorId: input.actorId,
      boundary: "drive_upload",
      ...(bufferedBytes === undefined ? { scanIncomplete: true } : { content: bufferedBytes }),
      resources: [{ resourceType: "drive.file", resourceId: input.objectId }],
    });
    if (dlpDecision?.action === "block") throw dlpDecisionError(dlpDecision);
    const dlpQuarantine = dlpDecision?.action === "quarantine";
    if (!scan.clean || dlpQuarantine) {
      context.options.metrics?.recordOperationalEvent({
        capability: "drive",
        operation: "virus_scan",
        status: "blocked",
      });
      context.options.metrics?.addOperationalUnits({
        capability: "drive",
        measure: "quarantined_bytes",
        value: actualByteSize,
      });
      const signature = dlpQuarantine
        ? `DLP.${dlpDecision.classification}`
        : (scan.signature ?? "unknown");
      const quarantineKey = driveQuarantineStorageKey(input.orgId, input.objectId, actualSha256);
      let quarantineStored = false;
      if (storage !== undefined) {
        try {
          if (input.content === undefined && storage.copy !== undefined) {
            await storage.copy(claim.reservedKey, quarantineKey);
          } else {
            const bytes = bufferedBytes ?? input.content;
            if (bytes === undefined) {
              throw new Error("Storage must support server-side copy for streamed quarantine.");
            }
            await storage.put({ key: quarantineKey, body: bytes });
          }
          quarantineStored = true;
          writtenStorageKey = quarantineKey;
        } catch (error) {
          emitQuarantineDeleteError(context, {
            orgId: input.orgId,
            objectId: input.objectId,
            storageKey: quarantineKey,
            attempts: 0,
            error: `Quarantine copy failed: ${virusScanErrorMessage(error)}`,
          });
        }
      }
      const deletions = await withTenantPostgresContext(
        context.sql,
        { orgId: input.orgId, actorId: input.actorId },
        (tx) =>
          commitDriveInfectedVerdict(tx, {
            claim,
            input,
            mimeType,
            byteSize: actualByteSize,
            sha256: actualSha256,
            signature,
            ...(dlpQuarantine
              ? {
                  quarantineSource: "dlp" as const,
                  dlpClassification: dlpDecision.classification,
                }
              : {}),
            quarantineKey,
            quarantineStored,
            hasStagedBytes: input.content === undefined,
          }),
      );
      committed = true;
      writtenStorageKey = undefined;
      for (const deletion of deletions) await deleteQuarantinedBytes(context, deletion);
      throw new DriveConflictError(
        dlpQuarantine ? "File was quarantined by DLP policy." : "File failed virus scan.",
        {
          details: {
            scanOutcome: "quarantined",
            signature,
            ...(dlpQuarantine ? { policy: "dlp" } : {}),
          },
        },
      );
    }
    if (storage === undefined) throw new Error("Drive upload content storage is not configured.");
    const dedup = context.options.contentAddressedDedup === true;
    const objectName = stringMetadata(claim.object.metadata, "name") ?? claim.object.storage_key;
    const inlineOverwriteKey =
      input.content !== undefined && claim.previousStatus === "ready"
        ? driveStorageKey(input.orgId, input.objectId, claim.versionNumber, objectName)
        : claim.reservedKey;
    let storageKey = resolveFinalizeStorageKey({
      dedup,
      orgId: input.orgId,
      sha256: actualSha256,
      reservedKey: inlineOverwriteKey,
    });
    if (dedup) {
      const blob = await withTenantPostgresContext(context.sql, { orgId: input.orgId }, (tx) =>
        claimDriveBlobDestination(tx, input.orgId, input.objectId, actualSha256, storageKey),
      );
      storageKey = blob.storageKey;
      blobReservationId = blob.reservationId;
      if (!blob.referenced) {
        if (input.content === undefined && storage.copy !== undefined) {
          await storage.copy(claim.reservedKey, storageKey);
        } else {
          const bytes = bufferedBytes ?? input.content;
          if (bytes === undefined) {
            throw new Error("Storage must support server-side copy for streamed deduplication.");
          }
          await storage.put({
            key: storageKey,
            body: bytes,
            contentType: mimeType,
            metadata: { objectId: input.objectId, sha256: actualSha256 },
          });
        }
        writtenStorageKey = storageKey;
      }
    } else if (input.content !== undefined) {
      await storage.put({
        key: storageKey,
        body: input.content,
        contentType: mimeType,
        metadata: { objectId: input.objectId, sha256: actualSha256 },
      });
      writtenStorageKey = storageKey;
    }
    const result = await withTenantPostgresContext(
      context.sql,
      { orgId: input.orgId, actorId: input.actorId },
      (tx) =>
        commitDriveCleanUpload(tx, {
          claim,
          input,
          storageKey,
          mimeType,
          byteSize: actualByteSize,
          sha256: actualSha256,
          dedup,
          ...(blobReservationId === undefined ? {} : { blobReservationId }),
          emitQuotaExceeded: (event) => {
            emitStorageQuotaExceeded(context, input.orgId, event);
          },
        }),
    );
    context.options.metrics?.recordOperationalEvent({
      capability: "drive",
      operation: "virus_scan",
      status: "success",
    });
    context.options.metrics?.addOperationalUnits({
      capability: "drive",
      measure: "uploaded_bytes",
      value: actualByteSize,
    });
    committed = true;
    writtenStorageKey = undefined;
    if (result.stagedDeletion !== undefined) {
      await deleteQuarantinedBytes(context, result.stagedDeletion);
    }
    return result.version;
  } catch (error) {
    if (!committed) {
      if (blobReservationId !== undefined) {
        await withTenantPostgresContext(context.sql, { orgId: input.orgId }, (tx) =>
          releaseDriveBlobReservation(tx, input.orgId, blobReservationId as string),
        ).catch(() => undefined);
      }
      for (const key of new Set([writtenStorageKey])) {
        if (key === undefined) continue;
        if (
          key === writtenStorageKey &&
          isDriveBlobStorageKey(key) &&
          (await withTenantPostgresContext(context.sql, { orgId: input.orgId }, (tx) =>
            driveBlobStorageIsReferenced(tx, input.orgId, key),
          ).catch(() => true))
        ) {
          continue;
        }
        await discardOrphanedQuarantineCopy(context, {
          id: "",
          org_id: input.orgId,
          object_id: input.objectId,
          actor_id: input.actorId,
          storage_key: key,
          status: "pending",
          attempt_count: 0,
          next_attempt_at: new Date(),
        });
      }
      await withTenantPostgresContext(context.sql, { orgId: input.orgId }, (tx) =>
        releaseDriveFinalizationClaim(tx, claim),
      ).catch(() => undefined);
    }
    throw error;
  }
}
