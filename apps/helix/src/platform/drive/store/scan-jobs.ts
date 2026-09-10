import { withTenantIoSagaPostgresContext as withTenantPostgresContext } from "../../tenancy/postgres-roles.js";
import { bytesFromDatabase } from "../core/mappers.js";
import { appendDriveActivity } from "./activity.js";
import { reconcileDriveBlobReferences } from "./blobs.js";
import { type DriveStoreContext } from "./context.js";
import {
  type DriveVirusScanRetryBatchResult,
  type RetryDeadLetteredVirusScanInput,
} from "./contracts.js";
import { abortExpiredMultipart, claimExpiredDriveMultipartSessions } from "./multipart.js";
import { claimDriveQuarantineDeletions, deleteQuarantinedBytes } from "./quarantine.js";
import {
  type DriveMultipartSweepRow,
  type DrivePreparedUploadSweepRow,
  type DriveQuarantineDeletionRow,
  type DriveScanClaimRow,
} from "./rows.js";
import {
  claimDriveScanJobs,
  DEFAULT_VIRUS_SCAN_MAX_ATTEMPTS,
  DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS,
  listDriveScanOrgIds,
  releaseDriveScanClaim,
  updateDriveScanObjectState,
} from "./scan-claims.js";
import { isQuarantineVerdict, virusScanErrorMessage } from "./scan-content.js";
import { claimExpiredPreparedUploads, deleteExpiredPreparedUpload } from "./upload-expiry.js";
import { finalizeUploadForScan } from "./uploads.js";
export async function runVirusScanRetryBatch(
  context: DriveStoreContext,
  input: {
    readonly limit: number;
    readonly leaseMs: number;
    readonly now?: Date;
    readonly includeVirusScans?: boolean;
  },
): Promise<DriveVirusScanRetryBatchResult> {
  const now = input.now ?? new Date();
  const limit = Math.min(100, Math.max(1, Math.trunc(input.limit)));
  const multipartClaims: DriveMultipartSweepRow[] = [];
  const preparedUploadClaims: DrivePreparedUploadSweepRow[] = [];
  const quarantineClaims: DriveQuarantineDeletionRow[] = [];
  const claims: DriveScanClaimRow[] = [];
  // Drop elapsed entries so scheduling state only covers tenants visited within one GC interval.
  for (const [orgId, next] of context.nextBlobReconciliation) {
    if (next <= now.getTime()) context.nextBlobReconciliation.delete(orgId);
  }
  const orgIds = await nextVirusScanOrgPage(context, Math.min(1000, Math.max(50, limit * 5)));
  for (const orgId of orgIds) {
    context.virusScanOrgCursor = orgId;
    await withTenantPostgresContext(context.sql, { orgId }, async (tx) => {
      if (context.options.gc?.enabled !== false && !context.nextBlobReconciliation.has(orgId)) {
        await reconcileDriveBlobReferences(tx, orgId, context.options.gc);
      }
      await tx`select * from helix_reconcile_storage_usage(${orgId})`;
    });
    if (
      context.options.gc !== undefined &&
      context.options.gc.enabled &&
      !context.nextBlobReconciliation.has(orgId)
    ) {
      context.nextBlobReconciliation.set(orgId, now.getTime() + context.options.gc.intervalMs);
    }
    const tenantMultipartClaims = await withTenantPostgresContext(context.sql, { orgId }, (tx) =>
      claimExpiredDriveMultipartSessions(tx, {
        limit:
          limit -
          multipartClaims.length -
          preparedUploadClaims.length -
          quarantineClaims.length -
          claims.length,
        leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
        now,
      }),
    );
    multipartClaims.push(...tenantMultipartClaims);
    if (
      multipartClaims.length +
        preparedUploadClaims.length +
        quarantineClaims.length +
        claims.length >=
      limit
    )
      break;
    const tenantPreparedUploadClaims = await withTenantPostgresContext(
      context.sql,
      { orgId },
      (tx) =>
        claimExpiredPreparedUploads(tx, {
          limit:
            limit -
            multipartClaims.length -
            preparedUploadClaims.length -
            quarantineClaims.length -
            claims.length,
          leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
          now,
        }),
    );
    preparedUploadClaims.push(...tenantPreparedUploadClaims);
    if (
      multipartClaims.length +
        preparedUploadClaims.length +
        quarantineClaims.length +
        claims.length >=
      limit
    )
      break;
    const tenantQuarantineClaims = await withTenantPostgresContext(context.sql, { orgId }, (tx) =>
      claimDriveQuarantineDeletions(tx, {
        limit:
          limit -
          multipartClaims.length -
          preparedUploadClaims.length -
          quarantineClaims.length -
          claims.length,
        leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
        now,
      }),
    );
    quarantineClaims.push(...tenantQuarantineClaims);
    if (
      multipartClaims.length +
        preparedUploadClaims.length +
        quarantineClaims.length +
        claims.length >=
      limit
    )
      break;
    if (input.includeVirusScans !== false) {
      const tenantClaims = await withTenantPostgresContext(context.sql, { orgId }, (tx) =>
        claimDriveScanJobs(tx, {
          limit:
            limit -
            multipartClaims.length -
            preparedUploadClaims.length -
            quarantineClaims.length -
            claims.length,
          leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
          now,
        }),
      );
      claims.push(...tenantClaims);
    }
    if (
      multipartClaims.length +
        preparedUploadClaims.length +
        quarantineClaims.length +
        claims.length >=
      limit
    )
      break;
  }
  let completed = 0;
  let failed = 0;
  for (const claim of multipartClaims) {
    if (await abortExpiredMultipart(context, claim)) completed += 1;
    else failed += 1;
  }
  for (const claim of preparedUploadClaims) {
    if (await deleteExpiredPreparedUpload(context, claim)) completed += 1;
    else failed += 1;
  }
  for (const claim of quarantineClaims) {
    if (await deleteQuarantinedBytes(context, claim)) completed += 1;
    else failed += 1;
  }
  for (const claim of claims) {
    try {
      const actorId = claim.actor_id ?? claim.owner_actor_id;
      if (actorId === null || claim.sha256 === null) {
        throw new Error("Drive scan job is missing its actor or verified digest.");
      }
      await finalizeUploadForScan(
        context,
        {
          orgId: claim.org_id,
          actorId,
          objectId: claim.object_id,
          byteSize: bytesFromDatabase(claim.byte_size),
          sha256: claim.sha256,
          mimeType: claim.mime_type,
          metadata: claim.finalize_metadata,
        },
        true,
      );
      completed += 1;
    } catch (error) {
      if (isQuarantineVerdict(error)) {
        completed += 1;
        continue;
      }
      failed += 1;
      const errorMessage = virusScanErrorMessage(error);
      const failure = await withTenantPostgresContext(
        context.sql,
        { orgId: claim.org_id },
        async (tx) => {
          const released = await releaseDriveScanClaim(tx, {
            id: claim.id,
            orgId: claim.org_id,
            error: errorMessage,
            maxAttempts: context.options.virusScanMaxAttempts ?? DEFAULT_VIRUS_SCAN_MAX_ATTEMPTS,
            retryDelayMs:
              context.options.virusScanRetryDelayMs ?? DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS,
          });
          if (released === null) {
            return null;
          }
          await updateDriveScanObjectState(tx, released);
          const actorId = released.actor_id ?? claim.owner_actor_id;
          if (actorId !== null) {
            await appendDriveActivity(tx, {
              orgId: released.org_id,
              actorId,
              verb:
                released.status === "dead_lettered"
                  ? "drive.upload.scan_dead_lettered"
                  : "drive.upload.scan_retry_scheduled",
              objectId: released.object_id,
              payload: {
                attempts: released.attempt_count,
                error: errorMessage,
                nextAttemptAt: released.next_attempt_at?.toISOString() ?? null,
              },
            });
          }
          return released;
        },
      );
      if (failure !== null) {
        context.options.onVirusScanUnavailable?.({
          orgId: failure.org_id,
          objectId: failure.object_id,
          attempts: failure.attempt_count,
          status: failure.status,
          error: errorMessage,
        });
      }
    }
  }
  return {
    claimed:
      multipartClaims.length +
      preparedUploadClaims.length +
      quarantineClaims.length +
      claims.length,
    completed,
    failed,
  };
}

async function nextVirusScanOrgPage(
  context: DriveStoreContext,
  limit: number,
): Promise<readonly string[]> {
  let rows = await listDriveScanOrgIds(context.sql, context.virusScanOrgCursor, limit);
  if (rows.length === 0 && context.virusScanOrgCursor !== undefined) {
    context.virusScanOrgCursor = undefined;
    rows = await listDriveScanOrgIds(context.sql, undefined, limit);
  }
  if (rows.length < limit) context.virusScanOrgCursor = undefined;
  return rows;
}

export async function retryDeadLetteredVirusScan(
  context: DriveStoreContext,
  input: RetryDeadLetteredVirusScanInput,
): Promise<boolean> {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 1000) {
    throw new TypeError("A specific antivirus retry reason is required.");
  }
  return withTenantPostgresContext(context.sql, { orgId: input.orgId }, async (tx) => {
    const rows = await tx<
      {
        readonly id: string;
      }[]
    >`
        update drive_scan_jobs
        set
          status = 'pending',
          attempt_count = 0,
          next_attempt_at = now(),
          lease_expires_at = null,
          last_error = null,
          override_count = override_count + 1,
          last_override_reason = ${reason},
          last_overridden_by_actor_id = ${input.actorId},
          last_overridden_at = now(),
          updated_at = now()
        where org_id = ${input.orgId}
          and object_id = ${input.objectId}
          and status = 'dead_lettered'
        returning id
      `;
    if (rows[0] === undefined) {
      return false;
    }
    await tx`
        update objects
        set metadata = (metadata - 'avScanLastError' - 'avScanNextAttemptAt') ||
              jsonb_build_object('status', 'scan_pending', 'avScanAttempts', 0),
            updated_at = now()
        where org_id = ${input.orgId} and id = ${input.objectId}
      `;
    await appendDriveActivity(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      verb: "drive.upload.scan_retry_overridden",
      objectId: input.objectId,
      payload: { reason },
    });
    return true;
  });
}
