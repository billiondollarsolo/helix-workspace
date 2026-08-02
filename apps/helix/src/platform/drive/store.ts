// ponytail: IO adapter still >400 LOC (quota SQL, comments, PDF form, WebDAV read); follow-up split: comments-store, pdf-form-store, share-links-store.
import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import type {
  EventBus,
  JsonObject,
  JsonValue,
  MeteringClient,
  StorageClient,
} from "@helix/sdk-types";
import { computeAuditHash } from "../audit/hash.js";
import { insertNotification } from "../notifications/index.js";
import { grantObjectAccess } from "../permissions/grant-object-access.js";
import type { TenantPresignedPutUpload, TenantStorageResolver } from "../storage/index.js";
import type {
  DriveAccessGrantRecord,
  DriveAutoTagWrite,
  DriveCommentListItem,
  DriveCommentRecord,
  DriveEnrichmentProjectionStore,
  DriveEnrichmentWrite,
  DriveEntryRecord,
  DrivePdfFormStateRecord,
  DrivePreview,
  DriveSearchProjectionStore,
  DriveSearchHit,
  DriveSearchRecord,
  DriveUploadRecord,
  DriveUploadStatusRecord,
  DriveVersionRecord,
} from "./types.js";
import { BadRequestError } from "../../api/api-error.js";
import {
  DriveConflictError,
  DriveForbiddenError,
  DriveNotFoundError,
  DriveStorageQuotaExceededError,
} from "./errors.js";
import { type DriveRole, driveRoleRank, hasRoleAtLeast, normalizeDriveRole } from "./core/roles.js";
import { assertProvidedFinalizeStorageKey, driveStorageKey } from "./core/storage-key.js";
import {
  isDriveBlobStorageKey,
  resolveBlobByteSource,
  resolveFinalizeStorageKey,
  shouldDeleteBlobStorage,
  shouldWriteBlobBytes,
} from "./core/dedup.js";
import {
  DEFAULT_MULTIPART_PART_SIZE,
  DEFAULT_MULTIPART_THRESHOLD,
  planMultipartParts,
  shouldUseMultipartUpload,
  validateCompletedParts,
} from "./multipart.js";
import { distinctStoredBytes, projectQuota } from "./core/quota.js";
import { mentionedActorIds, mentionTokensForComment } from "./core/mentions.js";
import { createDefaultTrashSyncRegistry, type TrashSyncRegistry } from "./core/trash-sync.js";
import {
  bytesFromDatabase,
  isOwnerVisibleProcessingState,
  mapDriveAccessGrant as mapDriveAccessGrantCore,
  mapObjectEntry as mapObjectEntryCore,
  mapSearchHit as mapSearchHitCore,
  mapVersion as mapVersionCore,
  nullableStringMetadata,
  stringMetadata,
} from "./core/mappers.js";
import { officePreviewStorageKey, type OfficePreviewConverter } from "./preview.js";
import { resolveEffectiveMime, sniffMimeType } from "./scanning.js";
import {
  isDriveFileAvailable,
  isDriveUploadState,
  userFacingDriveUploadState,
  type DriveUploadState,
} from "./upload-state.js";
import {
  assertDriveStorageEncryption,
  type DriveStorageEncryptionPolicy,
} from "./storage-policy.js";
import {
  hashDriveSharePassword,
  hashDriveShareToken,
  verifyDriveSharePassword,
} from "./share-link-security.js";
import { driveHardDeleteBlockers } from "./lifecycle.js";

export { DriveStorageQuotaExceededError } from "./errors.js";

export interface DriveStorageClient extends StorageClient {
  headObject?(key: string): Promise<{
    readonly byteSize: number | null;
    readonly etag: string | null;
    readonly serverSideEncryption: string | null;
    readonly serverSideEncryptionAwsKmsKeyId: string | null;
    readonly metadata: Record<string, string>;
  } | null>;
  presignGetUrl?(
    key: string,
    options?: {
      readonly expiresSeconds?: number;
      readonly contentType?: string;
      readonly metadata?: Record<string, string>;
    },
  ): Promise<string>;
  presignPutUrl?(
    key: string,
    options?: {
      readonly expiresSeconds?: number;
      readonly contentType?: string;
      readonly metadata?: Record<string, string>;
    },
  ): Promise<string>;
  presignPutRequest?(
    key: string,
    options?: {
      readonly expiresSeconds?: number;
      readonly contentType?: string;
      readonly metadata?: Record<string, string>;
    },
  ): Promise<TenantPresignedPutUpload>;
  createMultipartUpload?(
    key: string,
    options?: { readonly contentType?: string },
  ): Promise<{ readonly uploadId: string }>;
  presignUploadPart?(
    key: string,
    uploadId: string,
    partNumber: number,
    options?: { readonly contentType?: string },
  ): Promise<string>;
  completeMultipartUpload?(
    key: string,
    uploadId: string,
    parts: readonly { readonly partNumber: number; readonly etag: string }[],
  ): Promise<void>;
  abortMultipartUpload?(key: string, uploadId: string): Promise<void>;
}

export interface PrepareDriveUploadInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly name: string;
  readonly folderId?: string | null;
  readonly mimeType: string;
  readonly byteSize?: number;
  readonly sha256?: string;
  readonly metadata?: JsonObject;
}

export interface FinalizeDriveUploadInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly objectId: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly mimeType?: string;
  readonly storageKey?: string;
  readonly content?: Uint8Array;
  readonly metadata?: JsonObject;
}

export interface CompleteMultipartUploadInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly objectId: string;
  readonly uploadId: string;
  readonly parts: readonly { readonly partNumber: number; readonly etag: string }[];
  readonly byteSize: number;
  readonly sha256: string;
  readonly mimeType?: string;
  readonly metadata?: JsonObject;
}

export interface DriveStore {
  prepareUpload(input: PrepareDriveUploadInput): Promise<DriveUploadRecord>;
  finalizeUpload(input: FinalizeDriveUploadInput): Promise<DriveVersionRecord>;
  completeMultipartUpload?(input: CompleteMultipartUploadInput): Promise<DriveVersionRecord>;
  getUploadStatus?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<DriveUploadStatusRecord | null>;
  list(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId?: string | null;
    readonly includeTrashed?: boolean;
    readonly limit?: number;
    readonly app?: string | null;
    /** Filter by object kind. Defaults to 'file' so existing callers stay
     *  unchanged; pass 'recording' for the Recordings drive surface. */
    readonly kind?: string | null;
    readonly acrossFolders?: boolean;
  }): Promise<readonly DriveEntryRecord[]>;
  share(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly targetActorIds: readonly string[];
    readonly role: string;
    readonly expiresAt?: Date | null;
  }): Promise<{
    readonly objectId: string;
    readonly sharedWithActorIds: readonly string[];
    readonly role: string;
  }>;
  listAccess?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<readonly DriveAccessGrantRecord[]>;
  removeAccess?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly targetActorId: string;
  }): Promise<boolean>;
  updateAccess?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly targetActorId: string;
    readonly role: string;
    readonly expiresAt?: Date | null;
  }): Promise<DriveAccessGrantRecord | null>;
  move(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
  }): Promise<DriveEntryRecord | null>;
  setStarred?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly starred: boolean;
  }): Promise<DriveEntryRecord | null>;
  trash(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<DriveEntryRecord | null>;
  restore(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
  }): Promise<DriveEntryRecord | null>;
  delete(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<boolean>;
  search(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string;
    readonly folderId?: string | null;
    readonly limit?: number;
  }): Promise<readonly DriveSearchHit[]>;
  createFolder(input: DriveFolderCreateInput): Promise<DriveEntryRecord>;
  createComment?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly parentCommentId?: string | undefined;
    readonly body: string;
    readonly anchor?: JsonObject | undefined;
    readonly metadata?: JsonObject | undefined;
  }): Promise<DriveCommentRecord>;
  listComments?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly status?: string | undefined;
  }): Promise<readonly DriveCommentListItem[]>;
  resolveComment?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DriveCommentRecord | null>;
  reopenComment?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DriveCommentRecord | null>;
  updateComment?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
    readonly body: string;
  }): Promise<DriveCommentRecord | null>;
  deleteComment?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DriveCommentRecord | null>;
  getPdfFormState?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<DrivePdfFormStateRecord | null>;
  savePdfFormState?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly fieldValues: readonly JsonObject[];
  }): Promise<DrivePdfFormStateRecord>;
  clearPdfFormState?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<boolean>;
  rename?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly name: string;
  }): Promise<DriveEntryRecord | null>;
  listVersions?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<readonly DriveVersionRecord[]>;
  revertToVersion?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly versionNumber: number;
  }): Promise<DriveVersionRecord>;
  createShareLink?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly role: string;
    readonly expiresAt?: Date | null;
    readonly password?: string;
    readonly maxDownloads?: number | null;
    readonly rateLimitPerHour?: number;
  }): Promise<DriveShareLinkRecord>;
  listShareLinks?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<readonly DriveShareLinkRecord[]>;
  revokeShareLink?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly linkId: string;
  }): Promise<boolean>;
  resolveShareLink?(input: { readonly token: string; readonly password?: string }): Promise<{
    readonly orgId: string;
    readonly objectId: string;
    readonly role: string;
    readonly auditActorId: string | null;
  } | null>;
  /** Anonymous public-link content access (no actor ACL; token is the credential). */
  readFileByShareToken?(input: {
    readonly token: string;
    readonly password?: string;
  }): Promise<DriveFileReadResult | null>;
  collectOrphans?(input: {
    readonly olderThan: Date;
    readonly dryRun: boolean;
    readonly limit?: number;
  }): Promise<{ readonly candidates: number; readonly collected: number }>;
  /** Operator: current storage used bytes vs plan/org quota (D11). */
  getStorageQuotaUsage?(input: { readonly orgId: string }): Promise<DriveStorageQuotaUsageRecord>;
  /** Operator: org trash/orphan lifecycle policy (D11). */
  getLifecyclePolicy?(input: { readonly orgId: string }): Promise<DriveLifecyclePolicyRecord>;
  setLifecyclePolicy?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly trashRetentionDays: number;
    readonly orphanGraceHours: number;
  }): Promise<DriveLifecyclePolicyRecord>;
}

export interface DriveStorageQuotaUsageRecord {
  readonly orgId: string;
  readonly usedBytes: number;
  readonly limitBytes: number | null;
  readonly unlimited: boolean;
  readonly percentUsed: number | null;
}

export interface DriveLifecyclePolicyRecord {
  readonly orgId: string;
  readonly trashRetentionDays: number;
  readonly orphanGraceHours: number;
  readonly updatedByActorId: string | null;
  readonly updatedAt: Date | null;
  readonly configured: boolean;
}

export interface DriveShareLinkRecord {
  readonly id: string;
  readonly orgId: string;
  readonly objectId: string;
  /** Raw token is returned exactly once at creation; list operations return null. */
  readonly token: string | null;
  readonly role: string;
  readonly expiresAt: Date | null;
  readonly createdByActorId: string | null;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
  readonly maxDownloads: number | null;
  readonly downloadCount: number;
  readonly rateLimitPerHour: number;
  readonly lastUsedAt: Date | null;
}

export interface DriveFolderCreateInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly name: string;
  readonly parentFolderId?: string | null;
  readonly metadata?: JsonObject;
}

export interface DriveFileReadInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly objectId: string;
}

export interface DriveFileReadResult {
  readonly entry: DriveEntryRecord;
  readonly content: Uint8Array | null;
  readonly previewContent?: Uint8Array | null;
}

export interface PostgresDriveStoreOptions {
  readonly officePreviewConverter?: OfficePreviewConverter;
  readonly metering?: MeteringClient;
  readonly onMeteringError?: (error: unknown) => void;
  readonly events?: Pick<EventBus, "publish">;
  readonly onQuotaEventError?: (error: unknown) => void;
  readonly storageResolver?: TenantStorageResolver;
  /**
   * Cross-app trash/restore cascade registry (docs/sheets/slides handlers).
   * Defaults to {@link createDefaultTrashSyncRegistry}.
   */
  readonly trashSync?: TrashSyncRegistry;
  /** When true, finalize uses content-addressed blob keys + refcounts. */
  readonly contentAddressedDedup?: boolean;
  /** Multipart threshold in bytes (default 8 MiB). */
  readonly multipartThresholdBytes?: number;
  readonly multipartPartSizeBytes?: number;
  readonly storageEncryptionPolicy?: (
    orgId: string,
  ) => DriveStorageEncryptionPolicy | undefined | Promise<DriveStorageEncryptionPolicy | undefined>;
}

interface ObjectRow {
  readonly id: string;
  readonly org_id: string;
  readonly owner_actor_id: string | null;
  readonly kind: string;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: number;
  readonly sha256: string | null;
  readonly upload_state?: DriveUploadState;
  readonly upload_declared_byte_size?: string | number | null;
  readonly upload_declared_sha256?: string | null;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly drive_legal_hold?: boolean;
  readonly trash_expires_at?: Date | null;
}

interface DriveVersionRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly version_number: number;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: number;
  readonly sha256: string;
  readonly metadata: JsonObject;
  readonly created_by_actor_id: string | null;
  readonly created_at: Date;
}

interface DriveFolderRow {
  readonly id: string;
  readonly org_id: string;
  readonly name: string;
  readonly parent_folder_id: string | null;
  readonly owner_actor_id: string | null;
  readonly created_by_actor_id: string | null;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface DriveSearchRow extends ObjectRow {
  readonly version_number: number | null;
  readonly mine?: boolean | null;
  readonly shared_count?: number | string | null;
}

interface DriveSearchProjectionRow extends ObjectRow {
  readonly owner_display_name: string | null;
  readonly owner_email: string | null;
  readonly folder_path: readonly string[];
}

interface DriveStorageQuotaRow {
  readonly storage_bytes_limit: JsonValue | null;
  readonly storage_used_bytes: string | number;
}

interface DriveAccessGrantRow {
  readonly actor_id: string;
  readonly role: string;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly granted_by_actor_id: string | null;
  readonly expires_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface DriveCommentRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly parent_comment_id: string | null;
  readonly actor_id: string | null;
  readonly anchor: JsonObject;
  readonly body: string;
  readonly status: string;
  readonly metadata: JsonObject;
  readonly resolved_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date | null;
}

interface DriveShareLinkRow {
  readonly id: string;
  readonly org_id: string;
  readonly token: string | null;
  readonly token_hash: Uint8Array;
  readonly password_hash: string | null;
  readonly object_id: string;
  readonly role: string;
  readonly expires_at: Date | null;
  readonly created_by_actor_id: string | null;
  readonly created_at: Date;
  readonly revoked_at: Date | null;
  readonly max_downloads: number | null;
  readonly download_count: number;
  readonly rate_limit_per_hour: number;
  readonly rate_window_started_at: Date;
  readonly rate_window_count: number;
  readonly last_used_at: Date | null;
}

interface DriveCommentProjectionRow extends DriveCommentRow {
  readonly actor_display_name: string | null;
  readonly actor_email: string | null;
}

interface DrivePdfFormStateRow {
  readonly org_id: string;
  readonly object_id: string;
  readonly actor_id: string;
  readonly field_values: readonly JsonObject[];
  readonly source_version_number: number | null;
  readonly source_sha256: string | null;
  readonly source_byte_size: string | number | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly current_source_version_number?: number | null;
  readonly current_source_sha256?: string | null;
  readonly current_source_byte_size?: string | number | null;
}

type SqlLike = postgres.Sql | postgres.TransactionSql;

interface PdfFormSourceMetadata {
  readonly versionNumber: number | null;
  readonly sha256: string | null;
  readonly byteSize: number | null;
}

export class PostgresDriveStore
  implements DriveStore, DriveSearchProjectionStore, DriveEnrichmentProjectionStore
{
  private readonly trashSync: TrashSyncRegistry;

  constructor(
    private readonly sql: postgres.Sql,
    private readonly storage?: DriveStorageClient,
    private readonly options: PostgresDriveStoreOptions = {},
  ) {
    this.trashSync = options.trashSync ?? createDefaultTrashSyncRegistry();
  }

  async prepareUpload(input: PrepareDriveUploadInput): Promise<DriveUploadRecord> {
    return this.sql.begin(async (tx) => {
      if (input.folderId !== undefined && input.folderId !== null) {
        await requireFolderAccess(tx, input.orgId, input.actorId, input.folderId);
      }
      await assertStorageQuotaAvailable(tx, input.orgId, input.byteSize ?? 0, (event) => {
        this.emitStorageQuotaExceeded(input.orgId, event);
      });

      const objectId = randomUUID();
      const storageKey = driveStorageKey(input.orgId, objectId, 1, input.name);
      const metadata = driveObjectMetadata({
        ...(input.metadata ?? {}),
        name: input.name,
        folderId: input.folderId ?? null,
        status: "pending_upload",
      });
      const rows = (await tx`
        insert into objects (
          id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256,
          upload_state, upload_declared_byte_size, upload_declared_sha256, metadata
        )
        values (
          ${objectId},
          ${input.orgId},
          ${input.actorId},
          'file',
          ${storageKey},
          ${input.mimeType},
          ${input.byteSize ?? 0},
          ${input.sha256 ?? null},
          'pending_upload',
          ${input.byteSize ?? null},
          ${input.sha256 ?? null},
          ${tx.json(toSqlJson(metadata))}
        )
        returning *
      `) as unknown as readonly ObjectRow[];

      await grantObjectAccess(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        objectId,
        role: "owner",
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

      const storage = await this.storageForOrg(input.orgId);
      const threshold = this.options.multipartThresholdBytes ?? DEFAULT_MULTIPART_THRESHOLD;
      const partSize = this.options.multipartPartSizeBytes ?? DEFAULT_MULTIPART_PART_SIZE;
      if (
        shouldUseMultipartUpload(input.byteSize, threshold) &&
        storage?.createMultipartUpload !== undefined &&
        storage.presignUploadPart !== undefined &&
        input.byteSize !== undefined
      ) {
        const { uploadId } = await storage.createMultipartUpload(storageKey, {
          contentType: input.mimeType,
        });
        const plan = planMultipartParts(input.byteSize, partSize);
        const partUrls: string[] = [];
        for (const part of plan.parts) {
          partUrls.push(
            await storage.presignUploadPart(storageKey, uploadId, part.partNumber, {
              contentType: input.mimeType,
            }),
          );
        }
        await tx`
          update objects
          set metadata = metadata || ${tx.json(
            toSqlJson({
              multipartUploadId: uploadId,
              multipartInitiatedAt: new Date().toISOString(),
            }),
          )}::jsonb
          where id = ${objectId} and org_id = ${input.orgId}
        `;
        return {
          ...mapUpload(rows[0]),
          uploadUrl: null,
          uploadHeaders: {},
          multipart: {
            uploadId,
            partSize: plan.partSize,
            partCount: plan.partCount,
            partUrls,
          },
        };
      }

      const upload = await this.presignPutRequest(input.orgId, storageKey, input.mimeType);
      return {
        ...mapUpload(rows[0]),
        uploadUrl: upload?.url ?? null,
        uploadHeaders: upload?.headers ?? {},
      };
    });
  }

  async completeMultipartUpload(input: CompleteMultipartUploadInput): Promise<DriveVersionRecord> {
    const storage = await this.storageForOrg(input.orgId);
    if (storage?.completeMultipartUpload === undefined) {
      throw new Error("Drive multipart upload is not configured for this storage client.");
    }
    const object = await requireUploadOwnerAccess(
      this.sql,
      input.orgId,
      input.actorId,
      input.objectId,
    );
    const expectedParts = planMultipartParts(
      input.byteSize,
      this.options.multipartPartSizeBytes ?? DEFAULT_MULTIPART_PART_SIZE,
    ).partCount;
    const validated = validateCompletedParts(input.parts, expectedParts);
    if (!validated.ok) {
      throw new DriveConflictError(validated.reason);
    }
    await storage.completeMultipartUpload(object.storage_key, input.uploadId, input.parts);
    return this.finalizeUpload({
      orgId: input.orgId,
      actorId: input.actorId,
      objectId: input.objectId,
      byteSize: input.byteSize,
      sha256: input.sha256,
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
      storageKey: object.storage_key,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    });
  }

  async finalizeUpload(input: FinalizeDriveUploadInput): Promise<DriveVersionRecord> {
    let storageDelta = 0;
    const version = await this.sql.begin(async (tx) => {
      const current = await requireUploadOwnerAccess(
        tx,
        input.orgId,
        input.actorId,
        input.objectId,
        true,
      );
      const currentState = objectUploadState(current);
      if (currentState !== "pending_upload") {
        const existing = await latestDriveVersion(tx, input.orgId, input.objectId);
        if (
          existing !== null &&
          existing.byte_size === input.byteSize &&
          existing.sha256 === input.sha256
        ) {
          return mapVersion(existing);
        }
        throw new DriveConflictError(
          `Drive upload cannot be finalized from state '${currentState}'.`,
        );
      }

      const declaredByteSize = declaredUploadByteSize(current);
      if (declaredByteSize !== null && declaredByteSize !== input.byteSize) {
        throw new DriveConflictError(
          `Drive upload declared ${String(declaredByteSize)} bytes but finalize supplied ${String(input.byteSize)}.`,
        );
      }
      const declaredSha256 = current.upload_declared_sha256 ?? current.sha256;
      if (declaredSha256 !== null && declaredSha256 !== input.sha256) {
        throw new DriveConflictError("Drive upload SHA-256 differs from the prepared declaration.");
      }

      const dedup = this.options.contentAddressedDedup === true;
      const reservedKey = input.storageKey ?? current.storage_key;
      if (input.storageKey !== undefined && !dedup) {
        assertProvidedFinalizeStorageKey(input.storageKey, current.storage_key);
      }
      // When dedup is on, the immutable version + objects.storage_key point at the shared blob key.
      const storageKey = resolveFinalizeStorageKey({
        dedup,
        orgId: input.orgId,
        sha256: input.sha256,
        reservedKey,
      });
      let mimeType = input.mimeType ?? current.mime_type;
      storageDelta = finalizedStorageDelta(current, storageKey, input.byteSize);
      const storage = await this.storageForOrg(input.orgId);
      if (storage === undefined) {
        throw new Error("Drive upload content storage is not configured.");
      }
      await assertStorageQuotaAvailable(tx, input.orgId, storageDelta, (event) => {
        this.emitStorageQuotaExceeded(input.orgId, event);
      });
      const content = input.content;

      if (dedup) {
        if (content === undefined) {
          await verifyStoredDriveObject(storage, reservedKey, input.byteSize, input.sha256);
        } else {
          assertInlineUploadMatches(content, input.byteSize, input.sha256);
        }
        const inserted = await upsertDriveBlobRef(tx, {
          orgId: input.orgId,
          sha256: input.sha256,
          storageKey,
          byteSize: input.byteSize,
        });
        if (shouldWriteBlobBytes({ dedup: true, blobRowInserted: inserted })) {
          const source = resolveBlobByteSource({ content, reservedKey });
          let body: Uint8Array | AsyncIterable<Uint8Array>;
          if (source.kind === "inline") {
            body = source.content;
          } else if (source.kind === "reserved") {
            const reservedObject = await storage.get(source.reservedKey);
            if (reservedObject === null) {
              throw new Error(
                "Drive upload content not found at reserved key for content-addressed copy.",
              );
            }
            body = reservedObject.body;
          } else {
            throw new Error("Drive upload content is missing for content-addressed blob write.");
          }
          await storage.put({
            key: storageKey,
            body,
            contentType: mimeType,
            metadata: { objectId: input.objectId, sha256: input.sha256 },
          });
        }
      } else if (content !== undefined) {
        assertInlineUploadMatches(content, input.byteSize, input.sha256);
        await storage.put({
          key: storageKey,
          body: content,
          contentType: mimeType,
          metadata: { objectId: input.objectId, sha256: input.sha256 },
        });
      }

      const verified = await verifyStoredDriveObject(
        storage,
        storageKey,
        input.byteSize,
        input.sha256,
      );
      const encryptionPolicy = await this.options.storageEncryptionPolicy?.(input.orgId);
      const encryptionEvidence =
        encryptionPolicy === undefined ? undefined : await storage.headObject?.(storageKey);
      if (encryptionPolicy !== undefined) {
        if (storage.headObject === undefined) {
          throw new DriveConflictError(
            "Drive storage provider cannot evidence the required encryption policy.",
          );
        }
        assertDriveStorageEncryption(encryptionPolicy, encryptionEvidence ?? null);
      }
      mimeType = resolveEffectiveMime(mimeType, sniffMimeType(verified.prefix));
      const versionMetadata = {
        ...(input.metadata ?? {}),
        ...(encryptionEvidence === undefined
          ? {}
          : {
              storageEncryption: {
                mode: encryptionEvidence?.serverSideEncryption,
                kmsKeyId: encryptionEvidence?.serverSideEncryptionAwsKmsKeyId,
                verifiedAt: new Date().toISOString(),
              },
            }),
      };

      const versionRows = (await tx`
        insert into drive_versions (
          org_id, object_id, version_number, storage_key, mime_type, byte_size, sha256, metadata, created_by_actor_id
        )
        values (
          ${input.orgId},
          ${input.objectId},
          coalesce((select max(version_number) + 1 from drive_versions where object_id = ${input.objectId}), 1),
          ${storageKey},
          ${mimeType},
          ${input.byteSize},
          ${input.sha256},
          ${tx.json(toSqlJson(versionMetadata))},
          ${input.actorId}
        )
        returning *
      `) as unknown as readonly DriveVersionRow[];
      const version = mapVersion(versionRows[0]);

      await tx`
        update objects
        set
          storage_key = ${storageKey},
          mime_type = ${mimeType},
          byte_size = ${input.byteSize},
          sha256 = ${input.sha256},
          upload_state = 'uploaded',
          metadata = ${tx.json(
            toSqlJson({
              ...current.metadata,
              status: "uploaded",
              latestVersionId: version.id,
              versionNumber: version.versionNumber,
              multipartUploadId: null,
              multipartInitiatedAt: null,
            }),
          )},
          updated_at = now()
        where id = ${input.objectId} and org_id = ${input.orgId}
      `;
      const jobRows = (await tx`
        insert into drive_scan_jobs (
          org_id, object_id, version_id, requested_by_actor_id, status
        )
        values (
          ${input.orgId}, ${input.objectId}, ${version.id}, ${input.actorId}, 'pending'
        )
        on conflict (version_id) do update
          set updated_at = drive_scan_jobs.updated_at
        returning id
      `) as unknown as readonly { readonly id: string }[];
      const scanJobId = jobRows[0]?.id;
      if (scanJobId === undefined) {
        throw new DriveConflictError("Drive scan job could not be persisted.");
      }
      await tx`
        insert into outbox (subject, payload)
        values (
          'drive.scan.requested',
          ${tx.json(
            toSqlJson({
              jobId: scanJobId,
              orgId: input.orgId,
              objectId: input.objectId,
              versionId: version.id,
            }),
          )}
        )
      `;
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.upload.verified",
        objectId: input.objectId,
        payload: {
          scanJobId,
          versionId: version.id,
          versionNumber: version.versionNumber,
          byteSize: input.byteSize,
          sha256: input.sha256,
        },
      });

      return version;
    });
    this.emitStorageDelta(input.orgId, storageDelta);
    return version;
  }

  async getUploadStatus(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<DriveUploadStatusRecord | null> {
    const rows = (await this.sql`
      select id, upload_state, updated_at
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
    `) as unknown as readonly {
      readonly id: string;
      readonly upload_state: DriveUploadState;
      readonly updated_at: Date;
    }[];
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const userFacing = userFacingDriveUploadState(row.upload_state);
    return {
      objectId: row.id,
      state: row.upload_state,
      ...userFacing,
      updatedAt: row.updated_at,
    };
  }

  async list(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId?: string | null;
    readonly includeTrashed?: boolean;
    readonly limit?: number;
    readonly app?: string | null;
    /** Filter by object kind. Defaults to 'file'; the Recordings drive
     *  scope passes 'recording'. */
    readonly kind?: string | null;
    /** When true, return every visible file regardless of which folder
     *  it lives in. Used by the typed surfaces (`/docs`, `/sheets`,
     *  `/slides`) which present a cross-folder app-shaped list. Folder
     *  rows are suppressed in this mode — the result is a flat file list. */
    readonly acrossFolders?: boolean;
  }): Promise<readonly DriveEntryRecord[]> {
    // When filtering for non-file kinds (e.g. 'recording'), the folder
    // hierarchy doesn't apply — those objects don't live in user-managed
    // folders. Force acrossFolders=true so we skip the folder rows and the
    // folderId metadata match.
    const kind = input.kind ?? "file";
    const acrossFolders = input.acrossFolders === true || kind !== "file";
    if (input.folderId !== undefined && input.folderId !== null && !acrossFolders) {
      await requireFolderAccess(this.sql, input.orgId, input.actorId, input.folderId);
    }
    const folderRows = acrossFolders
      ? ([] as readonly DriveFolderRow[])
      : ((await this.sql`
          select *
          from drive_folders
          where org_id = ${input.orgId}
            and (
              (${input.folderId ?? null}::uuid is null and parent_folder_id is null)
              or parent_folder_id = ${input.folderId ?? null}
            )
            and (${input.includeTrashed ?? false} or deleted_at is null)
            and ${canReadFolderSql(this.sql, input.orgId, input.actorId)}
          order by name asc
          limit ${input.limit ?? 100}
        `) as unknown as readonly DriveFolderRow[]);

    const fileRows = (await this.sql`
      select
        o.*,
        (select max(version_number) from drive_versions v where v.object_id = o.id) as version_number,
        (o.owner_actor_id = ${input.actorId}) as mine,
        (
          select count(distinct p.actor_id)
          from permissions p
          where p.org_id = ${input.orgId}
            and p.resource_type = 'object'
            and p.resource_id = o.id
            and (o.owner_actor_id is null or p.actor_id <> o.owner_actor_id)
            and (p.expires_at is null or p.expires_at > now())
        ) as shared_count
      from objects o
      where o.org_id = ${input.orgId}
        and o.kind = ${kind}
        and (
          o.upload_state = 'active'
          or (${input.includeTrashed ?? false} and o.upload_state = 'trashed')
          or (
            o.owner_actor_id = ${input.actorId}
            and o.upload_state in ('uploaded', 'scanning', 'quarantined', 'scan_failed')
          )
        )
        and (
          ${acrossFolders}
          or coalesce(o.metadata->>'folderId', '') = coalesce(${input.folderId ?? null}::text, '')
        )
        and (${input.includeTrashed ?? false} or o.deleted_at is null)
        and (
          ${input.app ?? null}::text is null
          or coalesce(o.metadata->>'app', 'file') = ${input.app ?? null}
          or (
            ${input.app ?? null}::text = 'docs'
            and (
              o.mime_type ilike '%wordprocessingml%'
              or o.mime_type = 'application/msword'
              or o.mime_type ilike '%opendocument.text%'
              or o.mime_type = 'application/rtf'
              or lower(coalesce(o.metadata->>'name', o.storage_key)) ~ '\\.(docx?|docm|dotx?|dotm|rtf|odt|helixdoc)$'
            )
          )
          or (
            ${input.app ?? null}::text = 'sheets'
            and (
              o.mime_type ilike '%spreadsheetml%'
              or o.mime_type = 'application/vnd.ms-excel'
              or o.mime_type = 'application/vnd.oasis.opendocument.spreadsheet'
              or o.mime_type like 'text/csv%'
              or o.mime_type = 'text/tab-separated-values'
              or lower(coalesce(o.metadata->>'name', o.storage_key)) ~ '\\.(xlsx?|xlsm|xlsb|xltx?|xltm|csv|tsv|ods|helixsheet)$'
            )
          )
          or (
            ${input.app ?? null}::text = 'slides'
            and (
              o.mime_type ilike '%presentationml%'
              or o.mime_type = 'application/vnd.ms-powerpoint'
              or o.mime_type = 'application/vnd.oasis.opendocument.presentation'
              or lower(coalesce(o.metadata->>'name', o.storage_key)) ~ '\\.(pptx?|pptm|ppsx?|ppsm|potx?|potm|odp|helixdeck)$'
            )
          )
        )
        and (
          o.owner_actor_id = ${input.actorId}
          or exists (
            select 1 from permissions p
            where p.resource_type = 'object'
              and p.resource_id = o.id
              and p.org_id = ${input.orgId}
              and p.actor_id = ${input.actorId}
              and (p.expires_at is null or p.expires_at > now())
          )
        )
      order by coalesce(o.metadata->>'name', o.storage_key) asc
      limit ${input.limit ?? 100}
    `) as unknown as readonly DriveSearchRow[];

    return [
      ...folderRows.map(mapFolderEntry),
      ...fileRows
        .filter((row) => {
          const state = objectUploadState(row);
          // Active (and optional trash) are broadly visible. Processing /
          // quarantine / scan_failed appear only for the owner so the Drive UI
          // can show honest badges — never treated as available content.
          const ownedByCaller = row.owner_actor_id === input.actorId;
          return (
            isDriveFileAvailable(state) ||
            (input.includeTrashed === true && state === "trashed") ||
            (ownedByCaller && isOwnerVisibleProcessingState(state))
          );
        })
        .map(mapObjectEntry),
    ].slice(0, input.limit ?? 100);
  }

  async createFolder(input: DriveFolderCreateInput): Promise<DriveEntryRecord> {
    return this.sql.begin(async (tx) => {
      if (input.parentFolderId !== undefined && input.parentFolderId !== null) {
        await requireFolderAccess(tx, input.orgId, input.actorId, input.parentFolderId);
      }
      const rows = (await tx`
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
      `) as unknown as readonly DriveFolderRow[];
      const folder = mapFolderEntry(rows[0] ?? missingFolderRow());
      await grantFolderAccess(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        folderId: folder.id,
        role: "owner",
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

  async trashFolder(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
  }): Promise<DriveEntryRecord | null> {
    return this.sql.begin(async (tx) => {
      const rows = (await tx`
        with recursive folder_tree as (
          select *
          from drive_folders
          where id = ${input.folderId}
            and org_id = ${input.orgId}
            and deleted_at is null
            and ${canReadFolderSql(tx, input.orgId, input.actorId)}
          union all
          select child.*
          from drive_folders child
          join folder_tree parent on child.parent_folder_id = parent.id
          where child.org_id = ${input.orgId}
            and child.deleted_at is null
        ),
        trashed_files as (
          update objects
          set deleted_at = now(), upload_state = 'trashed', updated_at = now()
          where org_id = ${input.orgId}
            and kind = 'file'
            and deleted_at is null
            and metadata->>'folderId' in (select id::text from folder_tree)
          returning id, metadata
        ),
        trashed_docs as (
          update docs_documents
          set deleted_at = now(), updated_at = now()
          where org_id = ${input.orgId}
            and id in (
              select id
              from trashed_files
              where metadata->>'app' = 'docs'
            )
          returning id
        ),
        trashed_folders as (
          update drive_folders
          set deleted_at = now(), updated_at = now()
          where id in (select id from folder_tree)
          returning *
        )
        select *
        from trashed_folders
        where id = ${input.folderId}
        limit 1
      `) as unknown as readonly DriveFolderRow[];
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.folder.trashed",
        objectId: input.folderId,
        payload: { name: row.name, parentFolderId: row.parent_folder_id },
      });
      return mapFolderEntry(row);
    });
  }

  async readFile(input: DriveFileReadInput): Promise<DriveFileReadResult | null> {
    const object = await requireObjectAccess(this.sql, input.orgId, input.actorId, input.objectId);
    if (object.deleted_at !== null) {
      return null;
    }
    const versionRows = (await this.sql`
      select max(version_number) as version_number
      from drive_versions
      where object_id = ${input.objectId}
    `) as unknown as readonly { readonly version_number: number | null }[];
    const content = await this.readObjectBytes(input.orgId, object.storage_key);
    const entry = mapObjectEntry({
      ...object,
      version_number: versionRows[0]?.version_number ?? null,
    });
    const previewContent =
      entry.preview?.kind === "pdf" &&
      entry.preview.status === "available" &&
      entry.preview.storageKey !== undefined
        ? ((await this.readObjectBytes(input.orgId, entry.preview.storageKey)) ?? null)
        : null;
    await appendDriveActivity(this.sql, {
      orgId: input.orgId,
      actorId: input.actorId,
      verb: "drive.object.downloaded",
      objectId: input.objectId,
      payload: {
        versionNumber: entry.versionNumber ?? null,
        byteSize: entry.byteSize ?? 0,
      },
    });
    return {
      entry,
      content: content ?? null,
      previewContent,
    };
  }

  async share(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly targetActorIds: readonly string[];
    readonly role: string;
    readonly expiresAt?: Date | null;
  }): Promise<{
    readonly objectId: string;
    readonly sharedWithActorIds: readonly string[];
    readonly role: string;
  }> {
    return this.sql.begin(async (tx) => {
      await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "owner");
      const role = normalizeDriveRole(input.role);
      const sharedWithActorIds = [...new Set(input.targetActorIds)];
      for (const targetActorId of sharedWithActorIds) {
        const actorRows = (await tx`
          select id
          from actors
          where id = ${targetActorId}
            and org_id = ${input.orgId}
            and disabled_at is null
          limit 1
        `) as unknown as readonly { readonly id: string }[];
        if (actorRows.length === 0) {
          throw new DriveNotFoundError("One or more Drive share recipients are unavailable.");
        }
        await tx`
          insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id, expires_at)
          values (${input.orgId}, ${targetActorId}, 'object', ${input.objectId}, ${role}, ${input.actorId}, ${input.expiresAt ?? null})
          on conflict do nothing
        `;
      }
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.object.shared",
        objectId: input.objectId,
        payload: { sharedWithActorIds, role },
      });
      return { objectId: input.objectId, sharedWithActorIds, role };
    });
  }

  async listAccess(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<readonly DriveAccessGrantRecord[]> {
    await requireObjectAccess(this.sql, input.orgId, input.actorId, input.objectId);
    const rows = (await this.sql`
      select distinct on (p.actor_id)
        p.actor_id,
        p.role,
        a.display_name,
        a.email,
        p.granted_by_actor_id,
        p.expires_at,
        p.created_at,
        p.updated_at
      from permissions p
      join objects o
        on o.org_id = p.org_id
        and o.id = p.resource_id
        and o.kind in ('file', 'recording')
        and o.upload_state = 'active'
        and o.deleted_at is null
      left join actors a on a.id = p.actor_id and a.org_id = p.org_id
      where p.org_id = ${input.orgId}
        and p.resource_type = 'object'
        and p.resource_id = ${input.objectId}
        and p.actor_id <> o.owner_actor_id
        and (p.expires_at is null or p.expires_at > now())
      order by p.actor_id, p.updated_at desc, p.created_at desc
    `) as unknown as readonly DriveAccessGrantRow[];
    return rows.map(mapDriveAccessGrant);
  }

  async removeAccess(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly targetActorId: string;
  }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      // Self-removal is allowed for any grantee; removing others requires owner.
      if (input.targetActorId !== input.actorId) {
        await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "owner");
      } else {
        await requireObjectAccess(tx, input.orgId, input.actorId, input.objectId);
      }
      const rows = (await tx`
        with target_object as (
          select id, owner_actor_id
          from objects
          where id = ${input.objectId}
            and org_id = ${input.orgId}
            and kind in ('file', 'recording')
            and deleted_at is null
        ),
        deleted as (
          delete from permissions p
          using target_object o
          where p.org_id = ${input.orgId}
            and p.resource_type = 'object'
            and p.resource_id = o.id
            and p.actor_id = ${input.targetActorId}
            and p.actor_id <> o.owner_actor_id
            and (
              o.owner_actor_id = ${input.actorId}
              or p.actor_id = ${input.actorId}
            )
          returning p.actor_id
        )
        select count(*)::int as removed_count from deleted
      `) as unknown as readonly { readonly removed_count: number | string }[];
      const removed = Number(rows[0]?.removed_count ?? 0) > 0;
      if (removed) {
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "drive.object.access_removed",
          objectId: input.objectId,
          payload: { targetActorId: input.targetActorId },
        });
      }
      return removed;
    });
  }

  async updateAccess(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly targetActorId: string;
    readonly role: string;
    readonly expiresAt?: Date | null;
  }): Promise<DriveAccessGrantRecord | null> {
    return this.sql.begin(async (tx) => {
      await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "owner");
      const role = normalizeDriveRole(input.role);
      const rows = (await tx`
        with target_object as (
          select id, owner_actor_id
          from objects
          where id = ${input.objectId}
            and org_id = ${input.orgId}
            and kind in ('file', 'recording')
            and deleted_at is null
        ),
        updated as (
          update permissions p
          set role = ${role},
              expires_at = ${input.expiresAt ?? null},
              granted_by_actor_id = ${input.actorId},
              updated_at = now()
          from target_object o
          where p.org_id = ${input.orgId}
            and p.resource_type = 'object'
            and p.resource_id = o.id
            and p.actor_id = ${input.targetActorId}
            and p.actor_id <> o.owner_actor_id
            and o.owner_actor_id = ${input.actorId}
          returning
            p.actor_id,
            p.role,
            p.granted_by_actor_id,
            p.expires_at,
            p.created_at,
            p.updated_at
        )
        select distinct on (u.actor_id)
          u.actor_id,
          u.role,
          a.display_name,
          a.email,
          u.granted_by_actor_id,
          u.expires_at,
          u.created_at,
          u.updated_at
        from updated u
        left join actors a on a.id = u.actor_id and a.org_id = ${input.orgId}
        order by u.actor_id, u.updated_at desc, u.created_at desc
      `) as unknown as readonly DriveAccessGrantRow[];
      const grant = rows[0] === undefined ? null : mapDriveAccessGrant(rows[0]);
      if (grant !== null) {
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "drive.object.access_updated",
          objectId: input.objectId,
          payload: { targetActorId: input.targetActorId, role: input.role },
        });
      }
      return grant;
    });
  }

  async move(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
  }): Promise<DriveEntryRecord | null> {
    return this.updateFileFolder({
      ...input,
      verb: "drive.object.moved",
      restore: false,
    });
  }

  async setStarred(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly starred: boolean;
  }): Promise<DriveEntryRecord | null> {
    return this.sql.begin(async (tx) => {
      const rows = (await tx`
        update objects
        set metadata = case
              when ${input.starred}
                then metadata || ${tx.json(toSqlJson({ starred: true }))}::jsonb
              else metadata - 'starred'
            end
        where id = ${input.objectId}
          and org_id = ${input.orgId}
          and kind = 'file'
          and deleted_at is null
          and ${canReadObjectSql(tx, input.orgId, input.actorId)}
        returning *, (select max(version_number) from drive_versions v where v.object_id = objects.id) as version_number
      `) as unknown as readonly DriveSearchRow[];
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
    });
  }

  async rename(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly name: string;
  }): Promise<DriveEntryRecord | null> {
    return this.sql.begin(async (tx) => {
      await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "editor");
      const name = input.name.trim();
      if (name.length === 0) {
        throw new BadRequestError("Drive rename requires a non-empty name.");
      }
      const rows = (await tx`
        update objects
        set metadata = metadata || ${tx.json(toSqlJson({ name }))}::jsonb,
            updated_at = now()
        where id = ${input.objectId}
          and org_id = ${input.orgId}
          and kind in ('file', 'recording')
          and deleted_at is null
        returning *, (select max(version_number) from drive_versions v where v.object_id = objects.id) as version_number
      `) as unknown as readonly DriveSearchRow[];
      if (rows[0] !== undefined) {
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "drive.object.renamed",
          objectId: input.objectId,
          payload: { name },
        });
      }
      return rows[0] === undefined ? null : mapObjectEntry(rows[0]);
    });
  }

  async listVersions(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<readonly DriveVersionRecord[]> {
    await requireObjectRole(this.sql, input.orgId, input.actorId, input.objectId, "reader");
    const rows = (await this.sql`
      select *
      from drive_versions
      where org_id = ${input.orgId}
        and object_id = ${input.objectId}
      order by version_number desc
    `) as unknown as readonly DriveVersionRow[];
    return rows.map((row) => mapVersion(row));
  }

  async revertToVersion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly versionNumber: number;
  }): Promise<DriveVersionRecord> {
    return this.sql.begin(async (tx) => {
      await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "editor");
      const targetRows = (await tx`
        select *
        from drive_versions
        where org_id = ${input.orgId}
          and object_id = ${input.objectId}
          and version_number = ${input.versionNumber}
        limit 1
      `) as unknown as readonly DriveVersionRow[];
      const target = targetRows[0];
      if (target === undefined) {
        throw new DriveNotFoundError(
          `Unknown Drive version ${String(input.versionNumber)} for object ${input.objectId}.`,
        );
      }
      const maxRows = (await tx`
        select coalesce(max(version_number), 0)::int as max_version
        from drive_versions
        where org_id = ${input.orgId}
          and object_id = ${input.objectId}
      `) as unknown as readonly { readonly max_version: number }[];
      const nextVersion = (maxRows[0]?.max_version ?? 0) + 1;
      const inserted = (await tx`
        insert into drive_versions (
          org_id, object_id, version_number, storage_key, mime_type, byte_size, sha256, metadata, created_by_actor_id
        )
        values (
          ${input.orgId},
          ${input.objectId},
          ${nextVersion},
          ${target.storage_key},
          ${target.mime_type},
          ${target.byte_size},
          ${target.sha256},
          ${tx.json(toSqlJson({ ...target.metadata, revertedFromVersion: input.versionNumber }))},
          ${input.actorId}
        )
        returning *
      `) as unknown as readonly DriveVersionRow[];
      await tx`
        update objects
        set storage_key = ${target.storage_key},
            mime_type = ${target.mime_type},
            byte_size = ${target.byte_size},
            sha256 = ${target.sha256},
            metadata = metadata || ${tx.json(
              toSqlJson({
                status: "ready",
                versionNumber: nextVersion,
                latestVersionId: inserted[0]?.id,
              }),
            )}::jsonb,
            updated_at = now()
        where id = ${input.objectId}
          and org_id = ${input.orgId}
      `;
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.version.reverted",
        objectId: input.objectId,
        payload: { fromVersion: input.versionNumber, toVersion: nextVersion },
      });
      return mapVersion(inserted[0]);
    });
  }

  async createShareLink(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly role: string;
    readonly expiresAt?: Date | null;
    readonly password?: string;
    readonly maxDownloads?: number | null;
    readonly rateLimitPerHour?: number;
  }): Promise<DriveShareLinkRecord> {
    return this.sql.begin(async (tx) => {
      await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "owner");
      const role = normalizeDriveRole(input.role);
      if (role === "owner") {
        throw new DriveForbiddenError("Anonymous share links cannot grant owner role.");
      }
      const token = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
      const tokenHash = hashDriveShareToken(token);
      const passwordHash =
        input.password === undefined ? null : await hashDriveSharePassword(input.password);
      const rows = (await tx`
        insert into drive_share_links (
          org_id, token_hash, password_hash, object_id, role, expires_at,
          max_downloads, rate_limit_per_hour, created_by_actor_id
        )
        values (
          ${input.orgId},
          decode(${tokenHash}, 'hex'),
          ${passwordHash},
          ${input.objectId},
          ${role},
          ${input.expiresAt ?? null},
          ${input.maxDownloads ?? null},
          ${input.rateLimitPerHour ?? 120},
          ${input.actorId}
        )
        returning *
      `) as unknown as readonly DriveShareLinkRow[];
      const row = rows[0];
      if (row === undefined) {
        throw new DriveConflictError("Expected drive_share_links row.");
      }
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.link.created",
        objectId: input.objectId,
        payload: { linkId: row.id, role },
      });
      return { ...mapShareLink(row), token };
    });
  }

  async listShareLinks(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<readonly DriveShareLinkRecord[]> {
    await requireObjectRole(this.sql, input.orgId, input.actorId, input.objectId, "owner");
    const rows = (await this.sql`
      select *
      from drive_share_links
      where org_id = ${input.orgId}
        and object_id = ${input.objectId}
        and revoked_at is null
      order by created_at desc
    `) as unknown as readonly DriveShareLinkRow[];
    return rows.map(mapShareLink);
  }

  async revokeShareLink(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly linkId: string;
  }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const existing = (await tx`
        select *
        from drive_share_links
        where id = ${input.linkId}
          and org_id = ${input.orgId}
        limit 1
      `) as unknown as readonly DriveShareLinkRow[];
      const link = existing[0];
      if (link === undefined) {
        return false;
      }
      await requireObjectRole(tx, input.orgId, input.actorId, link.object_id, "owner");
      const rows = (await tx`
        update drive_share_links
        set revoked_at = now()
        where id = ${input.linkId}
          and org_id = ${input.orgId}
          and revoked_at is null
        returning id
      `) as unknown as readonly { readonly id: string }[];
      const revoked = rows.length > 0;
      if (revoked) {
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "drive.link.revoked",
          objectId: link.object_id,
          payload: { linkId: input.linkId },
        });
      }
      return revoked;
    });
  }

  async resolveShareLink(input: { readonly token: string; readonly password?: string }): Promise<{
    readonly orgId: string;
    readonly objectId: string;
    readonly role: string;
    readonly auditActorId: string | null;
  } | null> {
    const candidates = (await this.sql`
      select *
      from drive_share_links
      where token_hash = decode(${hashDriveShareToken(input.token)}, 'hex')
        and revoked_at is null
        and (expires_at is null or expires_at > now())
      limit 1
    `) as unknown as readonly DriveShareLinkRow[];
    const candidate = candidates[0];
    if (candidate === undefined) {
      return null;
    }

    // Consume the per-link attempt budget before password verification. Failed
    // and missing passwords therefore cannot bypass throttling, and the KDF
    // cannot be invoked after the hourly window is exhausted.
    const admitted = (await this.sql`
      update drive_share_links
      set
        rate_window_count = case
          when rate_window_started_at <= now() - interval '1 hour' then 1
          else rate_window_count + 1
        end,
        rate_window_started_at = case
          when rate_window_started_at <= now() - interval '1 hour' then now()
          else rate_window_started_at
        end
      where id = ${candidate.id}
        and revoked_at is null
        and (expires_at is null or expires_at > now())
        and (max_downloads is null or download_count < max_downloads)
        and (
          rate_window_started_at <= now() - interval '1 hour'
          or rate_window_count < rate_limit_per_hour
        )
      returning password_hash
    `) as unknown as readonly { readonly password_hash: string | null }[];
    const admittedCandidate = admitted[0];
    if (
      admittedCandidate === undefined ||
      (admittedCandidate.password_hash !== null &&
        (input.password === undefined ||
          !(await verifyDriveSharePassword(input.password, admittedCandidate.password_hash))))
    ) {
      return null;
    }

    const rows = (await this.sql`
      update drive_share_links
      set
        download_count = download_count + 1,
        last_used_at = now()
      where id = ${candidate.id}
        and revoked_at is null
        and (expires_at is null or expires_at > now())
        and (max_downloads is null or download_count < max_downloads)
      returning org_id, object_id, role, created_by_actor_id
    `) as unknown as readonly {
      readonly org_id: string;
      readonly object_id: string;
      readonly role: string;
      readonly created_by_actor_id: string | null;
    }[];
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const role = normalizeDriveRole(row.role);
    if (role === "owner") {
      return {
        orgId: row.org_id,
        objectId: row.object_id,
        role: "reader",
        auditActorId: row.created_by_actor_id,
      };
    }
    return {
      orgId: row.org_id,
      objectId: row.object_id,
      role,
      auditActorId: row.created_by_actor_id,
    };
  }

  async readFileByShareToken(input: {
    readonly token: string;
    readonly password?: string;
  }): Promise<DriveFileReadResult | null> {
    const resolved = await this.resolveShareLink(input);
    if (resolved === null) {
      return null;
    }
    const rows = (await this.sql`
      select *
      from objects
      where id = ${resolved.objectId}
        and org_id = ${resolved.orgId}
        and kind in ('file', 'recording')
        and upload_state = 'active'
        and deleted_at is null
      limit 1
    `) as unknown as readonly ObjectRow[];
    const object = rows[0];
    if (object === undefined || !isDriveFileAvailable(objectUploadState(object))) {
      return null;
    }
    const versionRows = (await this.sql`
      select max(version_number) as version_number
      from drive_versions
      where object_id = ${resolved.objectId}
    `) as unknown as readonly { readonly version_number: number | null }[];
    const content = await this.readObjectBytes(resolved.orgId, object.storage_key);
    const stillActive = (await this.sql`
      select 1
      from drive_share_links
      where token_hash = decode(${hashDriveShareToken(input.token)}, 'hex')
        and revoked_at is null
        and (expires_at is null or expires_at > now())
      limit 1
    `) as unknown as readonly unknown[];
    if (stillActive.length === 0) {
      return null;
    }
    if (resolved.auditActorId !== null) {
      await appendDriveActivity(this.sql, {
        orgId: resolved.orgId,
        actorId: resolved.auditActorId,
        verb: "drive.link.downloaded",
        objectId: resolved.objectId,
        payload: {},
      });
    }
    const entry = mapObjectEntry({
      ...object,
      version_number: versionRows[0]?.version_number ?? null,
    });
    return {
      entry,
      content: content ?? null,
    };
  }

  async trash(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<DriveEntryRecord | null> {
    return this.sql.begin(async (tx) => {
      await requireObjectRole(tx, input.orgId, input.actorId, input.objectId, "editor");
      const rows = (await tx`
        update objects
        set
          deleted_at = now(),
          trash_expires_at = now() + make_interval(days => coalesce(
            (
              select trash_retention_days
              from drive_lifecycle_policies
              where org_id = ${input.orgId}
            ),
            30
          )),
          upload_state = 'trashed',
          updated_at = now()
        where id = ${input.objectId}
          and org_id = ${input.orgId}
          and kind = 'file'
          and deleted_at is null
          and ${canReadObjectSql(tx, input.orgId, input.actorId)}
        returning *, (select max(version_number) from drive_versions v where v.object_id = objects.id) as version_number
      `) as unknown as readonly DriveSearchRow[];
      if (rows[0] !== undefined) {
        await syncTargetDeletedAt(tx, input.orgId, input.objectId, "trash", this.trashSync);
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "drive.object.trashed",
          objectId: input.objectId,
          payload: {},
        });
      }
      return rows[0] === undefined ? null : mapObjectEntry(rows[0]);
    });
  }

  async restore(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
  }): Promise<DriveEntryRecord | null> {
    return this.updateFileFolder({
      ...input,
      verb: "drive.object.restored",
      restore: true,
    });
  }

  async delete(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<boolean> {
    let storageDelta = 0;
    const deletedObject = await this.sql.begin(async (tx) => {
      const object = await requireObjectRole(
        tx,
        input.orgId,
        input.actorId,
        input.objectId,
        "owner",
        true,
      );
      await assertDriveHardDeleteAllowed(tx, input.orgId, input.objectId, object);
      const versionRows = (await tx`
        select storage_key, byte_size from drive_versions
        where object_id = ${input.objectId} and org_id = ${input.orgId}
      `) as unknown as readonly { readonly storage_key: string; readonly byte_size: number }[];
      await tx`
        delete from permissions
        where resource_type = 'object' and resource_id = ${input.objectId} and org_id = ${input.orgId}
      `;
      await tx`
        delete from drive_versions
        where object_id = ${input.objectId} and org_id = ${input.orgId}
      `;
      // syncTargetDeletedAt no-ops when the object has no linked app, so it is
      // called unconditionally here — matching the trash and restore paths.
      await syncTargetDeletedAt(tx, input.orgId, input.objectId, "trash", this.trashSync);
      const deleted = await tx`
        delete from objects
        where id = ${input.objectId} and org_id = ${input.orgId} and kind = 'file'
      `;
      if (deleted.count > 0) {
        storageDelta = -distinctStoredBytes([
          { storageKey: object.storage_key, byteSize: object.byte_size },
          ...versionRows.map((row) => ({
            storageKey: row.storage_key,
            byteSize: row.byte_size,
          })),
        ]);
        const storage = await this.storageForOrg(input.orgId);
        const uniqueKeys = new Set([
          object.storage_key,
          ...versionRows.map((row) => row.storage_key),
        ]);
        for (const storageKey of uniqueKeys) {
          if (this.options.contentAddressedDedup === true && isDriveBlobStorageKey(storageKey)) {
            // Shared blobs: decrement refcount; only delete storage at zero.
            const refcountAfter = await decrementDriveBlobRef(tx, {
              orgId: input.orgId,
              storageKey,
            });
            if (shouldDeleteBlobStorage(refcountAfter) && storage !== undefined) {
              await storage.delete(storageKey);
            }
          } else if (storage !== undefined) {
            await storage.delete(storageKey);
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
      return deleted.count > 0;
    });
    if (deletedObject) {
      this.emitStorageDelta(input.orgId, storageDelta);
    }
    return deletedObject;
  }

  async collectOrphans(input: {
    readonly olderThan: Date;
    readonly dryRun: boolean;
    readonly limit?: number;
  }): Promise<{ readonly candidates: number; readonly collected: number }> {
    return this.sql.begin(async (tx) => {
      const rows = (await tx`
        (
          select
            o.id::text as id,
            o.org_id,
            o.storage_key,
            case
              when o.metadata->>'multipartUploadId' is null then 'single'
              else 'multipart'
            end as kind,
            o.metadata->>'multipartUploadId' as upload_id
          from objects o
          where o.kind = 'file'
            and o.upload_state = 'pending_upload'
            and o.updated_at < ${input.olderThan}
          order by o.updated_at
          limit ${Math.min(Math.max(input.limit ?? 100, 1), 1_000)}
          for update skip locked
        )
        union all
        (
          select
            b.sha256 as id,
            b.org_id,
            b.storage_key,
            'blob'::text as kind,
            null::text as upload_id
          from drive_blobs b
          where b.refcount <= 0
            and b.updated_at < ${input.olderThan}
          order by b.updated_at
          limit ${Math.min(Math.max(input.limit ?? 100, 1), 1_000)}
          for update skip locked
        )
      `) as unknown as readonly {
        readonly id: string;
        readonly org_id: string;
        readonly storage_key: string;
        readonly kind: "blob" | "multipart" | "single";
        readonly upload_id: string | null;
      }[];
      if (input.dryRun) {
        return { candidates: rows.length, collected: 0 };
      }
      let collected = 0;
      for (const row of rows) {
        const storage = await this.storageForOrg(row.org_id);
        if (storage === undefined) continue;
        if (row.kind === "multipart") {
          if (row.upload_id === null || storage.abortMultipartUpload === undefined) continue;
          await storage.abortMultipartUpload(row.storage_key, row.upload_id);
          await tx`
            update objects
            set
              upload_state = 'scan_failed',
              metadata = (metadata - 'multipartUploadId' - 'multipartInitiatedAt')
                || '{"status":"scan_failed","failureReason":"orphaned_upload"}'::jsonb,
              updated_at = now()
            where id = ${row.id}::uuid
              and org_id = ${row.org_id}
              and upload_state = 'pending_upload'
          `;
        } else if (row.kind === "single") {
          await storage.delete(row.storage_key);
          await tx`
            update objects
            set
              upload_state = 'scan_failed',
              metadata = metadata
                || '{"status":"scan_failed","failureReason":"orphaned_upload"}'::jsonb,
              updated_at = now()
            where id = ${row.id}::uuid
              and org_id = ${row.org_id}
              and upload_state = 'pending_upload'
          `;
        } else {
          await storage.delete(row.storage_key);
          await tx`
            delete from drive_blobs
            where org_id = ${row.org_id}
              and sha256 = ${row.id}
              and refcount <= 0
          `;
        }
        collected += 1;
      }
      return { candidates: rows.length, collected };
    });
  }

  async search(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string;
    readonly folderId?: string | null;
    readonly limit?: number;
  }): Promise<readonly DriveSearchHit[]> {
    const query = input.query ?? "";
    const rows = (await this.sql`
      select o.*, (select max(version_number) from drive_versions v where v.object_id = o.id) as version_number
      from objects o
      where o.org_id = ${input.orgId}
        and o.kind = 'file'
        and o.upload_state = 'active'
        and o.deleted_at is null
        and (${input.folderId ?? null}::uuid is null or o.metadata->>'folderId' = ${input.folderId ?? null})
        and (${query} = '' or coalesce(o.metadata->>'name', o.storage_key) ilike ${`%${query}%`} or o.mime_type ilike ${`%${query}%`})
        and (
          o.owner_actor_id = ${input.actorId}
          or exists (
            select 1 from permissions p
            where p.resource_type = 'object'
              and p.resource_id = o.id
              and p.org_id = ${input.orgId}
              and p.actor_id = ${input.actorId}
              and (p.expires_at is null or p.expires_at > now())
          )
        )
      order by o.updated_at desc
      limit ${input.limit ?? 50}
    `) as unknown as readonly DriveSearchRow[];
    return rows.filter((row) => isDriveFileAvailable(objectUploadState(row))).map(mapSearchHit);
  }

  async createComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly parentCommentId?: string | undefined;
    readonly body: string;
    readonly anchor?: JsonObject | undefined;
    readonly metadata?: JsonObject | undefined;
  }): Promise<DriveCommentRecord> {
    return this.sql.begin(async (tx) => {
      const object = await requireObjectAccess(tx, input.orgId, input.actorId, input.objectId);
      if (input.parentCommentId !== undefined) {
        await requireDriveCommentParent(tx, {
          orgId: input.orgId,
          objectId: input.objectId,
          parentCommentId: input.parentCommentId,
        });
      }
      const rows = (await tx`
        insert into drive_comments
          (org_id, object_id, parent_comment_id, actor_id, anchor, body, metadata)
        values (
          ${input.orgId},
          ${input.objectId},
          ${input.parentCommentId ?? null},
          ${input.actorId},
          ${tx.json(toSqlJson(input.anchor ?? {}))},
          ${input.body},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly DriveCommentRow[];
      const comment = mapDriveComment(rows[0]);
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.comment.created",
        objectId: input.objectId,
        payload: { commentId: comment.id, parentCommentId: comment.parentCommentId },
      });
      await notifyDriveCommentMentions(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        object,
        commentId: comment.id,
        parentCommentId: comment.parentCommentId,
        anchor: comment.anchor,
        body: input.body,
        metadata: comment.metadata,
      });
      return comment;
    });
  }

  async listComments(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly status?: string | undefined;
  }): Promise<readonly DriveCommentListItem[]> {
    await requireObjectAccess(this.sql, input.orgId, input.actorId, input.objectId);
    const rows = (await this.sql`
      select
        c.*,
        a.display_name as actor_display_name,
        a.email as actor_email
      from drive_comments c
      left join actors a on a.id = c.actor_id and a.org_id = c.org_id
      where c.org_id = ${input.orgId}
        and c.object_id = ${input.objectId}
        ${
          input.status === undefined || input.status === "all"
            ? this.sql``
            : this.sql`and c.status = ${input.status}`
        }
      order by c.created_at asc, c.id asc
    `) as unknown as readonly DriveCommentProjectionRow[];
    return rows.map(mapDriveCommentListItem);
  }

  async resolveComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DriveCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = (await tx`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        limit 1
      `) as unknown as readonly DriveCommentRow[];
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireObjectAccess(tx, input.orgId, input.actorId, existing.object_id);
      if (existing.status === "resolved") {
        return mapDriveComment(existing);
      }
      const rows = (await tx`
        update drive_comments
        set status = 'resolved', resolved_at = now(), updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly DriveCommentRow[];
      const comment = mapDriveComment(rows[0]);
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.comment.resolved",
        objectId: comment.objectId,
        payload: { commentId: comment.id },
      });
      return comment;
    });
  }

  async reopenComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DriveCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = (await tx`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        limit 1
      `) as unknown as readonly DriveCommentRow[];
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireObjectAccess(tx, input.orgId, input.actorId, existing.object_id);
      if (existing.status === "open") {
        return mapDriveComment(existing);
      }
      const rows = (await tx`
        update drive_comments
        set status = 'open', resolved_at = null, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly DriveCommentRow[];
      const comment = mapDriveComment(rows[0]);
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.comment.reopened",
        objectId: comment.objectId,
        payload: { commentId: comment.id },
      });
      return comment;
    });
  }

  async updateComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
    readonly body: string;
  }): Promise<DriveCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = (await tx`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        limit 1
      `) as unknown as readonly DriveCommentRow[];
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireObjectAccess(tx, input.orgId, input.actorId, existing.object_id);
      const rows = (await tx`
        update drive_comments
        set body = ${input.body}, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly DriveCommentRow[];
      const comment = mapDriveComment(rows[0]);
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.comment.updated",
        objectId: comment.objectId,
        payload: { commentId: comment.id },
      });
      return comment;
    });
  }

  async deleteComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DriveCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = (await tx`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        limit 1
      `) as unknown as readonly DriveCommentRow[];
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireObjectAccess(tx, input.orgId, input.actorId, existing.object_id);
      const rows = (await tx`
        delete from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly DriveCommentRow[];
      const comment = mapDriveComment(rows[0]);
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.comment.deleted",
        objectId: comment.objectId,
        payload: { commentId: comment.id },
      });
      return comment;
    });
  }

  async getPdfFormState(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<DrivePdfFormStateRecord | null> {
    await requireObjectAccess(this.sql, input.orgId, input.actorId, input.objectId);
    const rows = (await this.sql`
      with latest_version as (
        select version_number, sha256, byte_size
        from drive_versions
        where org_id = ${input.orgId}
          and object_id = ${input.objectId}
        order by version_number desc
        limit 1
      )
      select
        s.*,
        latest_version.version_number as current_source_version_number,
        latest_version.sha256 as current_source_sha256,
        latest_version.byte_size as current_source_byte_size
      from drive_pdf_form_states s
      left join latest_version on true
      where s.org_id = ${input.orgId}
        and s.object_id = ${input.objectId}
        and s.actor_id = ${input.actorId}
      limit 1
    `) as unknown as readonly DrivePdfFormStateRow[];
    const row = rows[0];
    return row === undefined ? null : mapDrivePdfFormState(row);
  }

  async savePdfFormState(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly fieldValues: readonly JsonObject[];
  }): Promise<DrivePdfFormStateRecord> {
    return this.sql.begin(async (tx) => {
      const object = await requireObjectAccess(tx, input.orgId, input.actorId, input.objectId);
      const source = await pdfFormSourceMetadata(tx, object);
      const rows = (await tx`
        insert into drive_pdf_form_states
          (org_id, object_id, actor_id, field_values, source_version_number, source_sha256, source_byte_size)
        values (
          ${input.orgId},
          ${input.objectId},
          ${input.actorId},
          ${tx.json(toSqlJson(input.fieldValues))},
          ${source.versionNumber},
          ${source.sha256},
          ${source.byteSize}
        )
        on conflict (org_id, object_id, actor_id)
        do update set
          field_values = excluded.field_values,
          source_version_number = excluded.source_version_number,
          source_sha256 = excluded.source_sha256,
          source_byte_size = excluded.source_byte_size,
          updated_at = now()
        returning *
      `) as unknown as readonly DrivePdfFormStateRow[];
      const state = mapDrivePdfFormState(rows[0], source);
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.pdf_form_state.saved",
        objectId: input.objectId,
        payload: {
          fieldCount: input.fieldValues.length,
          sourceVersionNumber: source.versionNumber,
        },
      });
      return state;
    });
  }

  async clearPdfFormState(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      await requireObjectAccess(tx, input.orgId, input.actorId, input.objectId);
      const rows = (await tx`
        delete from drive_pdf_form_states
        where org_id = ${input.orgId}
          and object_id = ${input.objectId}
          and actor_id = ${input.actorId}
        returning object_id
      `) as unknown as readonly { readonly object_id: string }[];
      const cleared = rows.length > 0;
      if (cleared) {
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "drive.pdf_form_state.cleared",
          objectId: input.objectId,
          payload: {},
        });
      }
      return cleared;
    });
  }

  async getDriveSearchRecord(fileId: string): Promise<DriveSearchRecord | null> {
    const rows = (await this.sql`
      with recursive target as (
        select *
        from objects
        where id = ${fileId}
          and kind = 'file'
          and upload_state = 'active'
        limit 1
      ),
      folder_path as (
        select f.id, f.parent_folder_id, array[f.name]::text[] as path
        from drive_folders f
        join target t on f.id::text = t.metadata->>'folderId'
        union all
        select f.id, f.parent_folder_id, array[f.name]::text[] || fp.path
        from drive_folders f
        join folder_path fp on fp.parent_folder_id = f.id
      )
      select
        t.*,
        a.display_name as owner_display_name,
        a.email as owner_email,
        coalesce(
          (select fp.path from folder_path fp where fp.parent_folder_id is null limit 1),
          array[]::text[]
        ) as folder_path
      from target t
      left join actors a on a.id = t.owner_actor_id and a.org_id = t.org_id
    `) as unknown as readonly DriveSearchProjectionRow[];
    const row = rows[0];
    return row === undefined || !isDriveFileAvailable(objectUploadState(row))
      ? null
      : mapDriveSearchRecord(row);
  }

  getDriveEnrichmentRecord(fileId: string): Promise<DriveSearchRecord | null> {
    return this.getDriveSearchRecord(fileId);
  }

  async recordDriveEnrichment(input: DriveEnrichmentWrite): Promise<void> {
    await this.sql`
      update objects
      set
        metadata = jsonb_set(
          metadata,
          '{enrichments}',
          coalesce(metadata->'enrichments', '{}'::jsonb) ||
            jsonb_build_object(${input.feature}::text, ${this.sql.json(toSqlJson(input.data))}::jsonb),
          true
        ),
        updated_at = now()
      where id = ${input.fileId}
        and kind = 'file'
    `;
  }

  async setDriveAutoTags(input: DriveAutoTagWrite): Promise<void> {
    const tags = uniqueStrings(input.tags);
    await this.sql`
      update objects
      set
        metadata = metadata || ${this.sql.json(
          toSqlJson({
            tags,
            autoTag: {
              source: input.source,
              tags,
              updatedAt: new Date().toISOString(),
            },
          }),
        )}::jsonb,
        updated_at = now()
      where id = ${input.fileId}
        and kind = 'file'
    `;
  }

  private async storageForOrg(orgId: string): Promise<DriveStorageClient | undefined> {
    const resolved = await this.options.storageResolver?.({ orgId });
    return resolved?.client ?? this.storage;
  }

  private async presignPutRequest(
    orgId: string,
    storageKey: string,
    mimeType: string,
  ): Promise<TenantPresignedPutUpload | null> {
    const storage = await this.storageForOrg(orgId);
    const options = {
      contentType: mimeType,
      expiresSeconds: 900,
    };
    if (storage?.presignPutRequest !== undefined) {
      return storage.presignPutRequest(storageKey, options);
    }
    if (storage?.presignPutUrl === undefined) {
      return null;
    }
    return {
      url: await storage.presignPutUrl(storageKey, options),
      headers: { "content-type": mimeType },
    };
  }

  private async presignGetUrl(orgId: string, storageKey: string): Promise<string | undefined> {
    const storage = await this.storageForOrg(orgId);
    return storage?.presignGetUrl?.(storageKey, { expiresSeconds: 3600 });
  }

  private async generatePreview(input: {
    readonly orgId: string;
    readonly objectId: string;
    readonly name: string;
    readonly storageKey: string;
    readonly mimeType: string;
    readonly versionNumber: number;
    readonly inlineContent?: Uint8Array;
  }): Promise<{ readonly preview: DrivePreview } | Record<string, never>> {
    if (!isOfficePreviewCandidate(input.mimeType, input.name)) {
      return {};
    }

    const converter = this.options.officePreviewConverter;
    const storage = await this.storageForOrg(input.orgId);
    if (converter === undefined || storage === undefined) {
      return {
        preview: unsupportedOfficePreview(
          input.mimeType,
          "Office preview conversion requires the LibreOffice preview service.",
        ),
      };
    }

    const content =
      input.inlineContent ?? (await this.readObjectBytes(input.orgId, input.storageKey));
    if (content === undefined) {
      return {
        preview: unsupportedOfficePreview(
          input.mimeType,
          "Office preview conversion could not read the uploaded object bytes.",
        ),
      };
    }

    try {
      const converted = await converter.convert({
        objectId: input.objectId,
        name: input.name,
        storageKey: input.storageKey,
        sourceMimeType: input.mimeType,
        content,
      });
      const previewStorageKey = officePreviewStorageKey(
        input.orgId,
        input.objectId,
        input.versionNumber,
      );
      await storage.put({
        key: previewStorageKey,
        body: converted.pdf,
        contentType: "application/pdf",
        metadata: { objectId: input.objectId, sourceStorageKey: input.storageKey },
      });
      const previewUrl = await this.presignGetUrl(input.orgId, previewStorageKey);
      return {
        preview: {
          kind: "pdf",
          status: "available",
          mimeType: "application/pdf",
          storageKey: previewStorageKey,
          ...(previewUrl === undefined ? {} : { url: previewUrl }),
          ...(converted.pageCount === undefined ? {} : { pageCount: converted.pageCount }),
          generatedAt: converted.generatedAt,
        },
      };
    } catch (error) {
      return {
        preview: unsupportedOfficePreview(
          input.mimeType,
          error instanceof Error ? error.message : "Office preview conversion failed.",
        ),
      };
    }
  }

  private async readObjectBytes(
    orgId: string,
    storageKey: string,
  ): Promise<Uint8Array | undefined> {
    const object = await (await this.storageForOrg(orgId))?.get(storageKey);
    if (object === null || object === undefined) {
      return undefined;
    }
    return toUint8Array(object.body);
  }

  private emitStorageDelta(orgId: string, byteDelta: number): void {
    if (byteDelta === 0) {
      return;
    }

    void this.options.metering
      ?.emit(orgId, {
        type: "storage.delta",
        quantity: byteDelta,
        metadata: {
          bucket: "drive",
          byte_delta: byteDelta,
        },
      })
      .catch((error: unknown) => {
        this.options.onMeteringError?.(error);
      });
  }

  private emitStorageQuotaExceeded(
    orgId: string,
    event: Omit<StorageQuotaExceededEvent, "bucket" | "quota">,
  ): void {
    void this.options.events
      ?.publish("quota.storage.exceeded", {
        quota: "storage_bytes_limit",
        bucket: "drive",
        ...event,
      })
      .catch((error: unknown) => {
        this.options.onQuotaEventError?.(error);
      });
  }

  private async updateFileFolder(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
    readonly verb: string;
    readonly restore: boolean;
  }): Promise<DriveEntryRecord | null> {
    return this.sql.begin(async (tx) => {
      await requireObjectRole(
        tx,
        input.orgId,
        input.actorId,
        input.objectId,
        "editor",
        input.restore,
      );
      if (input.folderId !== undefined && input.folderId !== null) {
        await requireFolderAccess(tx, input.orgId, input.actorId, input.folderId);
      }
      /* `allowTrashed` has to be threaded here too, not just into the role
         check above. Trashing sets `upload_state = 'trashed'`, and this lookup
         filters on `upload_state = 'active'` unless told otherwise — so
         restore, the one operation whose subject is always trashed, could
         never find its own object and every restore raised
         DriveNotFoundError. */
      const current = await requireObjectAccess(
        tx,
        input.orgId,
        input.actorId,
        input.objectId,
        input.restore,
      );
      const rows = (await tx`
        update objects
        set
          deleted_at = ${input.restore ? null : current.deleted_at},
          trash_expires_at = case
            when ${input.restore} then null
            else trash_expires_at
          end,
          upload_state = ${input.restore ? "active" : objectUploadState(current)},
          metadata = ${tx.json(
            toSqlJson({
              ...current.metadata,
              folderId: input.folderId ?? null,
            }),
          )},
          updated_at = now()
        where id = ${input.objectId}
          and org_id = ${input.orgId}
          and kind = 'file'
        returning *, (select max(version_number) from drive_versions v where v.object_id = objects.id) as version_number
      `) as unknown as readonly DriveSearchRow[];
      if (rows[0] !== undefined && input.restore) {
        await syncTargetDeletedAt(tx, input.orgId, input.objectId, "restore", this.trashSync);
      }
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

  /** D11 operator: used storage vs effective plan/org limit (no mutation lock). */
  async getStorageQuotaUsage(input: {
    readonly orgId: string;
  }): Promise<DriveStorageQuotaUsageRecord> {
    const rows = (await this.sql`
      select
        case
          when o.quotas ? 'storage_bytes_limit' then o.quotas -> 'storage_bytes_limit'
          when p.quotas_default ? 'storage_bytes_limit' then p.quotas_default -> 'storage_bytes_limit'
          else '5000000000'::jsonb
        end as storage_bytes_limit,
        (
          select coalesce(sum(distinct_drive_storage.byte_size), 0)::bigint
          from (
            select distinct on (stored.storage_key) stored.storage_key, stored.byte_size
            from (
              select obj.storage_key, obj.byte_size, 0 as source_rank
              from objects obj
              where obj.org_id = ${input.orgId}
                and obj.kind in ('file', 'recording')
                and obj.deleted_at is null
                and (
                  coalesce(obj.metadata->>'status', 'ready') = 'ready'
                  or obj.upload_state = 'pending_upload'
                )
              union all
              select v.storage_key, v.byte_size, 1 as source_rank
              from drive_versions v
              join objects obj on obj.id = v.object_id and obj.org_id = v.org_id
              where v.org_id = ${input.orgId}
                and obj.kind in ('file', 'recording')
                and obj.deleted_at is null
                and coalesce(obj.metadata->>'status', 'ready') = 'ready'
            ) stored
            order by stored.storage_key, stored.source_rank
          ) distinct_drive_storage
        ) as storage_used_bytes
      from orgs o
      left join plans p on p.id = o.plan_id
      where o.id = ${input.orgId}
      limit 1
    `) as unknown as readonly DriveStorageQuotaRow[];
    const row = rows[0];
    const usedBytes = row === undefined ? 0 : bytesFromDatabase(row.storage_used_bytes);
    const limitBytes =
      row === undefined ? 5_000_000_000 : storageLimitFromJson(row.storage_bytes_limit);
    const unlimited = limitBytes === null;
    const percentUsed =
      unlimited || limitBytes === 0
        ? null
        : Math.min(100, Math.round((usedBytes / limitBytes) * 10_000) / 100);
    return {
      orgId: input.orgId,
      usedBytes,
      limitBytes,
      unlimited,
      percentUsed,
    };
  }

  async getLifecyclePolicy(input: { readonly orgId: string }): Promise<DriveLifecyclePolicyRecord> {
    const rows = (await this.sql`
      select org_id, trash_retention_days, orphan_grace_hours, updated_by_actor_id, updated_at
      from drive_lifecycle_policies
      where org_id = ${input.orgId}
      limit 1
    `) as unknown as readonly {
      readonly org_id: string;
      readonly trash_retention_days: number;
      readonly orphan_grace_hours: number;
      readonly updated_by_actor_id: string | null;
      readonly updated_at: Date;
    }[];
    const row = rows[0];
    if (row === undefined) {
      return {
        orgId: input.orgId,
        trashRetentionDays: 30,
        orphanGraceHours: 24,
        updatedByActorId: null,
        updatedAt: null,
        configured: false,
      };
    }
    return {
      orgId: row.org_id,
      trashRetentionDays: row.trash_retention_days,
      orphanGraceHours: row.orphan_grace_hours,
      updatedByActorId: row.updated_by_actor_id,
      updatedAt: row.updated_at,
      configured: true,
    };
  }

  async setLifecyclePolicy(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly trashRetentionDays: number;
    readonly orphanGraceHours: number;
  }): Promise<DriveLifecyclePolicyRecord> {
    if (
      !Number.isInteger(input.trashRetentionDays) ||
      input.trashRetentionDays < 1 ||
      input.trashRetentionDays > 3650
    ) {
      throw new DriveConflictError("trash_retention_days must be an integer from 1 to 3650.");
    }
    if (
      !Number.isInteger(input.orphanGraceHours) ||
      input.orphanGraceHours < 1 ||
      input.orphanGraceHours > 720
    ) {
      throw new DriveConflictError("orphan_grace_hours must be an integer from 1 to 720.");
    }
    const rows = (await this.sql`
      insert into drive_lifecycle_policies (
        org_id, trash_retention_days, orphan_grace_hours, updated_by_actor_id, updated_at
      )
      values (
        ${input.orgId},
        ${input.trashRetentionDays},
        ${input.orphanGraceHours},
        ${input.actorId},
        now()
      )
      on conflict (org_id) do update set
        trash_retention_days = excluded.trash_retention_days,
        orphan_grace_hours = excluded.orphan_grace_hours,
        updated_by_actor_id = excluded.updated_by_actor_id,
        updated_at = now()
      returning org_id, trash_retention_days, orphan_grace_hours, updated_by_actor_id, updated_at
    `) as unknown as readonly {
      readonly org_id: string;
      readonly trash_retention_days: number;
      readonly orphan_grace_hours: number;
      readonly updated_by_actor_id: string | null;
      readonly updated_at: Date;
    }[];
    const row = rows[0];
    if (row === undefined) {
      throw new DriveConflictError("Expected drive_lifecycle_policies row.");
    }
    await appendDriveActivity(this.sql, {
      orgId: input.orgId,
      actorId: input.actorId,
      // Org-scoped policy: record against the org id as the activity object.
      objectId: input.orgId,
      verb: "drive.lifecycle.policy_updated",
      payload: {
        trashRetentionDays: row.trash_retention_days,
        orphanGraceHours: row.orphan_grace_hours,
      },
    });
    return {
      orgId: row.org_id,
      trashRetentionDays: row.trash_retention_days,
      orphanGraceHours: row.orphan_grace_hours,
      updatedByActorId: row.updated_by_actor_id,
      updatedAt: row.updated_at,
      configured: true,
    };
  }
}

interface StorageQuotaExceededEvent {
  readonly quota: "storage_bytes_limit";
  readonly bucket: "drive";
  readonly used_bytes: number;
  readonly limit_bytes: number;
  readonly byte_delta: number;
  readonly projected_bytes: number;
}

async function assertStorageQuotaAvailable(
  sql: SqlLike,
  orgId: string,
  byteDelta: number,
  onExceeded?: (event: Omit<StorageQuotaExceededEvent, "bucket" | "quota">) => void,
): Promise<void> {
  if (byteDelta <= 0) {
    return;
  }

  const rows = (await sql`
    select
      case
        when o.quotas ? 'storage_bytes_limit' then o.quotas -> 'storage_bytes_limit'
        when p.quotas_default ? 'storage_bytes_limit' then p.quotas_default -> 'storage_bytes_limit'
        else '5000000000'::jsonb
      end as storage_bytes_limit,
      (
        select coalesce(sum(distinct_drive_storage.byte_size), 0)::bigint
        from (
          select distinct on (stored.storage_key) stored.storage_key, stored.byte_size
          from (
            select obj.storage_key, obj.byte_size, 0 as source_rank
            from objects obj
            where obj.org_id = ${orgId}
              and obj.kind in ('file', 'recording')
              and obj.deleted_at is null
              and (
                coalesce(obj.metadata->>'status', 'ready') = 'ready'
                or obj.upload_state = 'pending_upload'
              )
            union all
            select v.storage_key, v.byte_size, 1 as source_rank
            from drive_versions v
            join objects obj on obj.id = v.object_id and obj.org_id = v.org_id
            where v.org_id = ${orgId}
              and obj.kind in ('file', 'recording')
              and obj.deleted_at is null
              and coalesce(obj.metadata->>'status', 'ready') = 'ready'
          ) stored
          order by stored.storage_key, stored.source_rank
        ) distinct_drive_storage
      ) as storage_used_bytes
    from orgs o
    left join plans p on p.id = o.plan_id
    where o.id = ${orgId}
    limit 1
    for update of o
  `) as unknown as readonly DriveStorageQuotaRow[];
  const row = rows[0];
  if (row === undefined) {
    return;
  }

  const limit = storageLimitFromJson(row.storage_bytes_limit);
  if (limit === null) {
    return;
  }

  const used = bytesFromDatabase(row.storage_used_bytes);
  const { projectedBytes, exceeded } = projectQuota({
    usedBytes: used,
    limitBytes: limit,
    byteDelta,
  });
  if (exceeded) {
    onExceeded?.({
      used_bytes: used,
      limit_bytes: limit,
      byte_delta: byteDelta,
      projected_bytes: projectedBytes,
    });
    throw new DriveStorageQuotaExceededError(orgId, limit, projectedBytes);
  }
}

async function assertDriveHardDeleteAllowed(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  object: ObjectRow,
): Promise<void> {
  const rows = (await sql`
    select
      (
        select count(*)::int
        from permissions
        where org_id = ${orgId}
          and resource_type = 'object'
          and resource_id = ${objectId}
          and (expires_at is null or expires_at > now())
      ) + (
        select count(*)::int
        from drive_share_links
        where org_id = ${orgId}
          and object_id = ${objectId}
          and revoked_at is null
          and (expires_at is null or expires_at > now())
      ) as active_share_count,
      (
        select count(*)::int
        from drive_scan_jobs
        where org_id = ${orgId}
          and object_id = ${objectId}
          and status in ('pending', 'leased')
      ) as pending_job_count
  `) as unknown as readonly {
    readonly active_share_count: number | string;
    readonly pending_job_count: number | string;
  }[];
  const blockers = driveHardDeleteBlockers(
    {
      trashedAt: object.deleted_at,
      trashExpiresAt: object.trash_expires_at ?? null,
      legalHold: object.drive_legal_hold === true,
      activeShareCount: Number(rows[0]?.active_share_count ?? 0),
      pendingJobCount: Number(rows[0]?.pending_job_count ?? 0),
    },
    new Date(),
  );
  if (blockers.length > 0) {
    throw new DriveConflictError(`Drive hard delete blocked: ${blockers.join(", ")}.`);
  }
}

async function requireObjectAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  objectId: string,
  allowTrashed = false,
): Promise<ObjectRow> {
  // Drive surfaces 'file' (uploaded files / app-created docs) and
  // 'recording' (meet recordings). Both go through the same /content
  // endpoint, the same permissions table, and the same readObjectBytes
  // path — only the kind differs.
  const rows = (await sql`
    select *
    from objects
    where id = ${objectId}
      and org_id = ${orgId}
      and kind in ('file', 'recording')
      and (upload_state = 'active' or (${allowTrashed} and upload_state = 'trashed'))
      and ${canReadObjectSql(sql, orgId, actorId)}
    limit 1
  `) as unknown as readonly ObjectRow[];
  const object = rows[0];
  const state = object === undefined ? undefined : objectUploadState(object);
  if (
    object === undefined ||
    (state !== undefined && !isDriveFileAvailable(state) && !(allowTrashed && state === "trashed"))
  ) {
    throw new DriveNotFoundError(`Unknown or inaccessible Drive object: ${objectId}`);
  }
  return object;
}

async function requireUploadOwnerAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  objectId: string,
  lock = false,
): Promise<ObjectRow> {
  const rows = lock
    ? ((await sql`
        select *
        from objects
        where id = ${objectId}
          and org_id = ${orgId}
          and kind in ('file')
          and owner_actor_id = ${actorId}
        limit 1
        for update
      `) as unknown as readonly ObjectRow[])
    : ((await sql`
        select *
        from objects
        where id = ${objectId}
          and org_id = ${orgId}
          and kind in ('file')
          and owner_actor_id = ${actorId}
        limit 1
      `) as unknown as readonly ObjectRow[]);
  const object = rows[0];
  if (object === undefined) {
    throw new DriveNotFoundError(`Unknown or inaccessible Drive upload: ${objectId}`);
  }
  return object;
}

async function latestDriveVersion(
  sql: SqlLike,
  orgId: string,
  objectId: string,
): Promise<DriveVersionRow | null> {
  const rows = (await sql`
    select *
    from drive_versions
    where org_id = ${orgId}
      and object_id = ${objectId}
    order by version_number desc
    limit 1
  `) as unknown as readonly DriveVersionRow[];
  return rows[0] ?? null;
}

/**
 * Least-privilege gate: requires read access first (404 to strangers), then a
 * role at least `minRole`. Owners always pass. Throws DriveForbiddenError (403)
 * when the actor can read but lacks the mutation privilege.
 */
async function requireObjectRole(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  objectId: string,
  minRole: DriveRole,
  allowTrashed = false,
): Promise<ObjectRow> {
  const object = await requireObjectAccess(sql, orgId, actorId, objectId, allowTrashed);
  if (object.owner_actor_id === actorId) return object;
  const rows = (await sql`
    select role
    from permissions
    where org_id = ${orgId}
      and resource_type = 'object'
      and resource_id = ${objectId}
      and actor_id = ${actorId}
      and (expires_at is null or expires_at > now())
  `) as unknown as readonly { readonly role: string }[];
  const best = rows.reduce<DriveRole>((acc, r) => {
    const norm = normalizeDriveRole(r.role);
    return driveRoleRank(norm) > driveRoleRank(acc) ? norm : acc;
  }, "reader");
  if (!hasRoleAtLeast(best, minRole)) {
    throw new DriveForbiddenError(
      `Requires '${minRole}' access on Drive object ${objectId}; actor has '${best}'.`,
    );
  }
  return object;
}

async function requireFolderAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  folderId: string,
): Promise<void> {
  const rows = (await sql`
    select id
    from drive_folders
    where id = ${folderId}
      and org_id = ${orgId}
      and deleted_at is null
      and ${canReadFolderSql(sql, orgId, actorId)}
    limit 1
  `) as unknown as readonly { readonly id: string }[];
  if (rows[0] === undefined) {
    throw new Error(`Unknown or inaccessible Drive folder: ${folderId}`);
  }
}

async function requireDriveCommentParent(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly objectId: string;
    readonly parentCommentId: string;
  },
): Promise<void> {
  const rows = (await sql`
    select id
    from drive_comments
    where id = ${input.parentCommentId}
      and org_id = ${input.orgId}
      and object_id = ${input.objectId}
    limit 1
  `) as unknown as readonly { readonly id: string }[];
  if (rows[0] === undefined) {
    throw new Error(`Unknown parent Drive comment: ${input.parentCommentId}`);
  }
}

async function pdfFormSourceMetadata(
  sql: SqlLike,
  object: ObjectRow,
): Promise<PdfFormSourceMetadata> {
  const rows = (await sql`
    select version_number, sha256, byte_size
    from drive_versions
    where org_id = ${object.org_id}
      and object_id = ${object.id}
    order by version_number desc
    limit 1
  `) as unknown as readonly {
    readonly version_number: number;
    readonly sha256: string;
    readonly byte_size: string | number;
  }[];
  const latest = rows[0];
  if (latest === undefined) {
    return {
      versionNumber: null,
      sha256: object.sha256,
      byteSize: numberFromBigIntLike(object.byte_size),
    };
  }
  return {
    versionNumber: latest.version_number,
    sha256: latest.sha256,
    byteSize: numberFromBigIntLike(latest.byte_size),
  };
}

function canReadObjectSql(
  sql: SqlLike,
  orgId: string,
  actorId: string,
): postgres.PendingQuery<postgres.Row[]> {
  return sql`
    (
      objects.owner_actor_id = ${actorId}
      or exists (
        select 1 from permissions p
        where p.resource_type = 'object'
          and p.resource_id = objects.id
          and p.org_id = ${orgId}
          and p.actor_id = ${actorId}
          and (p.expires_at is null or p.expires_at > now())
      )
    )
  `;
}

/**
 * Upsert drive_blobs refcount. Returns true when this call created the row
 * (first reference → storage write required).
 */
async function upsertDriveBlobRef(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly sha256: string;
    readonly storageKey: string;
    readonly byteSize: number;
  },
): Promise<boolean> {
  const rows = (await sql`
    insert into drive_blobs (org_id, sha256, storage_key, byte_size, refcount)
    values (${input.orgId}, ${input.sha256}, ${input.storageKey}, ${input.byteSize}, 1)
    on conflict (org_id, sha256) do update
      set refcount = drive_blobs.refcount + 1,
          updated_at = now()
    returning (xmax = 0) as inserted
  `) as unknown as readonly { readonly inserted: boolean }[];
  return rows[0]?.inserted === true;
}

/**
 * Decrement drive_blobs.refcount for a blob storage key.
 * Returns the refcount after decrement (0 if row was removed / already gone).
 */
async function decrementDriveBlobRef(
  sql: SqlLike,
  input: { readonly orgId: string; readonly storageKey: string },
): Promise<number> {
  const rows = (await sql`
    update drive_blobs
    set refcount = refcount - 1,
        updated_at = now()
    where org_id = ${input.orgId}
      and storage_key = ${input.storageKey}
      and refcount > 0
    returning refcount
  `) as unknown as readonly { readonly refcount: number }[];
  const refcount = rows[0]?.refcount;
  if (refcount === undefined) {
    return 0;
  }
  if (refcount <= 0) {
    await sql`
      delete from drive_blobs
      where org_id = ${input.orgId}
        and storage_key = ${input.storageKey}
        and refcount <= 0
    `;
    return 0;
  }
  return refcount;
}

async function syncTargetDeletedAt(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  action: "restore" | "trash",
  trashSync: TrashSyncRegistry,
): Promise<void> {
  const deletedAt = action === "restore" ? null : new Date();
  const rows = (await sql`
    select metadata->>'app' as app from objects
    where id = ${objectId} and org_id = ${orgId}
  `) as unknown as readonly { readonly app: string | null }[];
  const app = rows[0]?.app ?? null;
  await trashSync.run(app, {
    sql: sql,
    orgId,
    objectId,
    deletedAt,
  });
}

function canReadFolderSql(
  sql: SqlLike,
  orgId: string,
  actorId: string,
): postgres.PendingQuery<postgres.Row[]> {
  return sql`
    (
      drive_folders.owner_actor_id = ${actorId}
      or exists (
        select 1 from permissions p
        where p.resource_type = 'drive_folder'
          and p.resource_id = drive_folders.id
          and p.org_id = ${orgId}
          and p.actor_id = ${actorId}
          and (p.expires_at is null or p.expires_at > now())
      )
    )
  `;
}

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

export async function appendDriveActivity(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly objectId: string;
    readonly payload: JsonObject;
  },
): Promise<void> {
  const previousRows = (await sql`
    select this_hash from activity
    where org_id = ${input.orgId}
    order by created_at desc, id desc
    limit 1
    for update
  `) as unknown as readonly { readonly this_hash: string }[];
  const prevHash = previousRows[0]?.this_hash ?? null;
  const createdAt = new Date();
  const { thisHash } = computeAuditHash(
    {
      actorId: input.actorId,
      verb: input.verb,
      objectType: "drive.object",
      objectId: input.objectId,
      metadata: input.payload,
      createdAt: createdAt.toISOString(),
    },
    prevHash,
  );
  await sql`
    insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash, created_at)
    values (${input.orgId}, ${input.actorId}, ${input.verb}, 'drive.object', ${input.objectId}, ${sql.json(toSqlJson(input.payload))}, ${prevHash}, ${thisHash}, ${createdAt})
  `;
  await sql`
    insert into outbox (subject, payload)
    values (${`activity.${input.verb}`}, ${sql.json(
      toSqlJson({
        orgId: input.orgId,
        actorId: input.actorId,
        objectId: input.objectId,
        ...input.payload,
      }),
    )})
  `;
}

async function notifyDriveCommentMentions(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly object: ObjectRow;
    readonly commentId: string;
    readonly parentCommentId: string | null;
    readonly anchor: JsonObject;
    readonly body: string;
    readonly metadata: JsonObject;
  },
): Promise<void> {
  const tokens = mentionTokensForComment(input.metadata, input.body);
  if (tokens.length === 0) {
    return;
  }
  const actorRows = (await sql`
    select id, display_name, email
    from actors
    where org_id = ${input.orgId}
      and disabled_at is null
      and type = 'user'
      and (
        id = ${input.object.owner_actor_id}
        or exists (
          select 1 from permissions p
          where p.org_id = ${input.orgId}
            and p.actor_id = actors.id
            and p.resource_type = 'object'
            and p.resource_id = ${input.object.id}
            and (p.expires_at is null or p.expires_at > now())
        )
      )
  `) as unknown as readonly {
    readonly id: string;
    readonly display_name: string;
    readonly email: string | null;
  }[];
  const recipients = mentionedActorIds({
    actors: actorRows,
    authorActorId: input.actorId,
    tokens,
  });
  if (recipients.length === 0) {
    return;
  }
  const authorName =
    actorRows.find((actor) => actor.id === input.actorId)?.display_name ?? "Someone";
  const title = driveObjectNotificationTitle(input.object);
  const app = stringMetadata(input.object.metadata, "app");
  for (const recipientId of recipients) {
    await insertNotification(sql, {
      orgId: input.orgId,
      actorId: recipientId,
      verb: "drive.comment.mention",
      objectType: "drive.object",
      objectId: input.object.id,
      summary: `${authorName} mentioned you in "${title}".`,
      body: input.body,
      payload: {
        objectId: input.object.id,
        commentId: input.commentId,
        ...(input.parentCommentId === null ? {} : { parentCommentId: input.parentCommentId }),
        anchor: input.anchor,
        mentionedByActorId: input.actorId,
        mentionsText: tokens,
        ...(app === undefined ? {} : { app }),
      },
    });
  }
}

function driveObjectNotificationTitle(object: ObjectRow): string {
  return (
    stringMetadata(object.metadata, "title") ??
    stringMetadata(object.metadata, "name") ??
    stringMetadata(object.metadata, "filename") ??
    object.storage_key.split("/").at(-1) ??
    "Drive object"
  );
}

function mapUpload(
  row: ObjectRow | undefined,
): Omit<DriveUploadRecord, "uploadUrl" | "uploadHeaders"> {
  if (row === undefined) {
    throw new Error("Expected Drive object row.");
  }
  const metadata = row.metadata;
  return {
    objectId: row.id,
    orgId: row.org_id,
    ownerActorId: row.owner_actor_id ?? "",
    name: stringMetadata(metadata, "name") ?? row.storage_key,
    folderId: nullableStringMetadata(metadata, "folderId"),
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    status: objectUploadState(row),
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function objectUploadState(row: ObjectRow): DriveUploadState {
  if (isDriveUploadState(row.upload_state)) {
    return row.upload_state;
  }
  const legacy = stringMetadata(row.metadata, "status");
  if (legacy === "pending_upload") return "pending_upload";
  if (legacy === "uploaded") return "uploaded";
  if (legacy === "scanning") return "scanning";
  if (legacy === "infected" || legacy === "quarantined") return "quarantined";
  if (legacy === "scan_failed") return "scan_failed";
  if (row.deleted_at !== null) return "trashed";
  return "active";
}

function mapVersion(row: DriveVersionRow | undefined): DriveVersionRecord {
  if (row === undefined) {
    throw new DriveNotFoundError("Expected Drive version row.");
  }
  return mapVersionCore(row);
}

function mapShareLink(row: DriveShareLinkRow): DriveShareLinkRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    objectId: row.object_id,
    token: row.token,
    role: row.role,
    expiresAt: row.expires_at,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    maxDownloads: row.max_downloads,
    downloadCount: row.download_count,
    rateLimitPerHour: row.rate_limit_per_hour,
    lastUsedAt: row.last_used_at,
  };
}

function mapFolderEntry(row: DriveFolderRow): DriveEntryRecord {
  return {
    id: row.id,
    type: "folder",
    name: row.name,
    folderId: row.parent_folder_id,
    ownerActorId: row.owner_actor_id,
    app: null,
    metadata: row.metadata,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function missingFolderRow(): DriveFolderRow {
  throw new Error("Expected Drive folder row.");
}

function mapObjectEntry(row: DriveSearchRow): DriveEntryRecord {
  const preview = drivePreviewFromMetadata(row.mime_type, row.metadata);
  return mapObjectEntryCore({
    id: row.id,
    owner_actor_id: row.owner_actor_id,
    storage_key: row.storage_key,
    mime_type: row.mime_type,
    byte_size: row.byte_size,
    sha256: row.sha256,
    metadata: row.metadata,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version_number: row.version_number ?? null,
    upload_state: objectUploadState(row),
    ...(typeof row.mine === "boolean" ? { mine: row.mine } : {}),
    ...(row.shared_count === undefined || row.shared_count === null
      ? {}
      : { shared_count: row.shared_count }),
    ...(preview === undefined ? {} : { preview }),
  });
}

function mapDriveAccessGrant(row: DriveAccessGrantRow): DriveAccessGrantRecord {
  return mapDriveAccessGrantCore(row);
}

function mapSearchHit(row: DriveSearchRow): DriveSearchHit {
  const previewMetadata = drivePreviewFromMetadata(row.mime_type, row.metadata);
  return mapSearchHitCore({
    id: row.id,
    storage_key: row.storage_key,
    mime_type: row.mime_type,
    byte_size: row.byte_size,
    sha256: row.sha256,
    metadata: row.metadata,
    updated_at: row.updated_at,
    ...(previewMetadata === undefined ? {} : { previewMetadata }),
  });
}

function mapDriveComment(row: DriveCommentRow | undefined): DriveCommentRecord {
  if (row === undefined) {
    throw new Error("Expected Drive comment row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    objectId: row.object_id,
    parentCommentId: row.parent_comment_id,
    actorId: row.actor_id,
    anchor: row.anchor,
    body: row.body,
    status: row.status,
    metadata: row.metadata,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDriveCommentListItem(row: DriveCommentProjectionRow): DriveCommentListItem {
  const comment = mapDriveComment(row);
  return {
    ...comment,
    ...(row.actor_id === null
      ? {}
      : {
          author: {
            id: row.actor_id,
            ...(row.actor_display_name === null ? {} : { displayName: row.actor_display_name }),
            ...(row.actor_email === null ? {} : { email: row.actor_email }),
          },
        }),
  };
}

function mapDrivePdfFormState(
  row: DrivePdfFormStateRow | undefined,
  currentSource?: PdfFormSourceMetadata,
): DrivePdfFormStateRecord {
  if (row === undefined) {
    throw new Error("Expected Drive PDF form state row.");
  }
  const currentVersionNumber =
    currentSource?.versionNumber ?? row.current_source_version_number ?? null;
  const currentSha256 = currentSource?.sha256 ?? row.current_source_sha256 ?? null;
  return {
    orgId: row.org_id,
    objectId: row.object_id,
    actorId: row.actor_id,
    fieldValues: jsonObjectArray(row.field_values),
    sourceVersionNumber: row.source_version_number,
    sourceSha256: row.source_sha256,
    sourceByteSize: numberFromBigIntLike(row.source_byte_size),
    sourceChanged:
      (row.source_version_number !== null &&
        currentVersionNumber !== null &&
        row.source_version_number !== currentVersionNumber) ||
      (row.source_sha256 !== null && currentSha256 !== null && row.source_sha256 !== currentSha256),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDriveSearchRecord(row: DriveSearchProjectionRow): DriveSearchRecord {
  const metadata = row.metadata;
  const name = stringMetadata(metadata, "name") ?? row.storage_key;
  const parentFolderId = nullableStringMetadata(metadata, "folderId");
  return {
    id: row.id,
    orgId: row.org_id,
    kind: "file",
    name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    storageKey: row.storage_key,
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
    ...(parentFolderId === null ? {} : { parentFolderId }),
    path: [...row.folder_path, name],
    ...(row.owner_actor_id === null
      ? {}
      : {
          owner: {
            id: row.owner_actor_id,
            ...(row.owner_display_name === null ? {} : { displayName: row.owner_display_name }),
            ...(row.owner_email === null ? {} : { email: row.owner_email }),
          },
        }),
    ...metadataStringArrayProperty(metadata, "tags"),
    ...metadataStringProperty(metadata, "summary"),
    ...metadataStringProperty(metadata, "description"),
    ...metadataStringProperty(metadata, "textContent"),
    ...metadataClassificationProperty(metadata),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.deleted_at === null
      ? {}
      : { trashedAt: row.deleted_at.toISOString(), deletedAt: row.deleted_at.toISOString() }),
    metadata,
  };
}

function driveObjectMetadata(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function finalizedStorageDelta(current: ObjectRow, storageKey: string, byteSize: number): number {
  if (!isDriveFileAvailable(objectUploadState(current))) {
    return byteSize;
  }
  if (storageKey === current.storage_key) {
    return byteSize - current.byte_size;
  }
  return byteSize;
}

function declaredUploadByteSize(current: ObjectRow): number | null {
  if (current.upload_declared_byte_size === null) {
    return null;
  }
  if (current.upload_declared_byte_size !== undefined) {
    return bytesFromDatabase(current.upload_declared_byte_size);
  }
  return current.byte_size;
}

function assertInlineUploadMatches(
  content: Uint8Array,
  expectedByteSize: number,
  expectedSha256: string,
): void {
  if (content.byteLength !== expectedByteSize) {
    throw new DriveConflictError(
      `Drive upload has ${String(content.byteLength)} bytes; expected ${String(expectedByteSize)}.`,
    );
  }
  const actualSha256 = createHash("sha256").update(content).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new DriveConflictError("Drive upload SHA-256 does not match stored content.");
  }
}

async function verifyStoredDriveObject(
  storage: DriveStorageClient,
  storageKey: string,
  expectedByteSize: number,
  expectedSha256: string,
): Promise<{ readonly prefix: Uint8Array }> {
  const object = await storage.get(storageKey);
  if (object === null) {
    throw new DriveConflictError("Drive upload object does not exist in storage.");
  }
  const hash = createHash("sha256");
  const prefix = new Uint8Array(Math.min(expectedByteSize, 512));
  let prefixLength = 0;
  let byteSize = 0;
  const chunks =
    object.body instanceof Uint8Array ? ([object.body] as readonly Uint8Array[]) : object.body;
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) {
      throw new DriveConflictError("Drive storage returned an invalid byte stream.");
    }
    byteSize += chunk.byteLength;
    if (byteSize > expectedByteSize) {
      throw new DriveConflictError(
        `Drive upload exceeds its declared size of ${String(expectedByteSize)} bytes.`,
      );
    }
    hash.update(chunk);
    if (prefixLength < prefix.byteLength) {
      const length = Math.min(chunk.byteLength, prefix.byteLength - prefixLength);
      prefix.set(chunk.subarray(0, length), prefixLength);
      prefixLength += length;
    }
  }
  if (byteSize !== expectedByteSize) {
    throw new DriveConflictError(
      `Drive upload has ${String(byteSize)} stored bytes; expected ${String(expectedByteSize)}.`,
    );
  }
  if (hash.digest("hex") !== expectedSha256) {
    throw new DriveConflictError("Drive upload SHA-256 does not match stored content.");
  }
  return { prefix: prefix.subarray(0, prefixLength) };
}

function storageLimitFromJson(value: JsonValue | null): number | null {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 5_000_000_000;
}

function numberFromBigIntLike(value: string | number | null): number | null {
  return value === null ? null : bytesFromDatabase(value);
}

function jsonObjectArray(value: unknown): readonly JsonObject[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: JsonObject[] = [];
  for (const item of value) {
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      result.push(item as JsonObject);
    }
  }
  return result;
}

function metadataStringProperty(metadata: JsonObject, key: string): Record<string, string> {
  const value = metadata[key];
  return typeof value === "string" ? { [key]: value } : {};
}

function metadataStringArrayProperty(
  metadata: JsonObject,
  key: string,
): { readonly tags?: readonly string[] } {
  const value = metadata[key];
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string")
    ? { tags: value }
    : {};
}

function metadataClassificationProperty(
  metadata: JsonObject,
): Pick<DriveSearchRecord, "classification"> {
  const value = metadata.classification;
  return value === "public" ||
    value === "standard" ||
    value === "confidential" ||
    value === "restricted"
    ? { classification: value }
    : {};
}

function drivePreviewFromMetadata(
  mimeType: string,
  metadata: JsonObject,
): DrivePreview | undefined {
  const preview = metadata.preview;
  if (isJsonObject(preview)) {
    const kind = stringMetadata(preview, "kind");
    const status = stringMetadata(preview, "status");
    const text = stringMetadata(preview, "text");
    const url = stringMetadata(preview, "url") ?? stringMetadata(preview, "previewUrl");
    const storageKey = stringMetadata(preview, "storageKey");
    const blocker = stringMetadata(preview, "blocker");
    const generatedAt = stringMetadata(preview, "generatedAt");
    if (
      (kind === "text" ||
        kind === "image" ||
        kind === "pdf" ||
        kind === "office" ||
        kind === "unsupported") &&
      (status === "available" || status === "unsupported")
    ) {
      return {
        kind,
        status,
        mimeType: stringMetadata(preview, "mimeType") ?? mimeType,
        ...(text === undefined ? {} : { text }),
        ...(url === undefined ? {} : { url }),
        ...(storageKey === undefined ? {} : { storageKey }),
        ...numberPreviewProperty(preview, "pageCount"),
        ...numberPreviewProperty(preview, "width"),
        ...numberPreviewProperty(preview, "height"),
        ...(blocker === undefined ? {} : { blocker }),
        ...(generatedAt === undefined ? {} : { generatedAt }),
      };
    }
  }

  const previewText =
    stringMetadata(metadata, "previewText") ?? stringMetadata(metadata, "textContent");
  if (previewText !== undefined && isTextPreviewMime(mimeType)) {
    return { kind: "text", status: "available", mimeType, text: previewText };
  }

  const previewUrl =
    stringMetadata(metadata, "previewUrl") ?? stringMetadata(metadata, "contentUrl");
  if (previewUrl !== undefined && mimeType.startsWith("image/")) {
    return {
      kind: "image",
      status: "available",
      mimeType,
      url: previewUrl,
      ...numberPreviewProperty(metadata, "width"),
      ...numberPreviewProperty(metadata, "height"),
    };
  }
  if (previewUrl !== undefined && mimeType === "application/pdf") {
    return {
      kind: "pdf",
      status: "available",
      mimeType,
      url: previewUrl,
      ...numberPreviewProperty(metadata, "pageCount"),
    };
  }
  if (isOfficeMime(mimeType)) {
    return unsupportedOfficePreview(
      mimeType,
      "Office preview conversion requires the LibreOffice preview service.",
    );
  }

  return undefined;
}

function unsupportedOfficePreview(mimeType: string, blocker: string): DrivePreview {
  return {
    kind: "office",
    status: "unsupported",
    mimeType,
    blocker,
  };
}

function isTextPreviewMime(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/xml"
  );
}

function isOfficePreviewCandidate(mimeType: string, filename: string): boolean {
  const normalizedMime = mimeType.toLowerCase();
  const normalizedName = filename.toLowerCase();
  if (
    [
      "application/msword",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
      "application/vnd.oasis.opendocument.text",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/vnd.oasis.opendocument.presentation",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
      "application/vnd.ms-word.document.macroenabled.12",
      "application/vnd.ms-word.template.macroenabled.12",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
      "application/vnd.ms-excel.sheet.macroenabled.12",
      "application/vnd.ms-excel.sheet.binary.macroenabled.12",
      "application/vnd.ms-excel.template.macroenabled.12",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
      "application/vnd.openxmlformats-officedocument.presentationml.template",
      "application/vnd.ms-powerpoint.presentation.macroenabled.12",
      "application/vnd.ms-powerpoint.slideshow.macroenabled.12",
      "application/vnd.ms-powerpoint.template.macroenabled.12",
    ].includes(normalizedMime)
  ) {
    return true;
  }
  return /\.(docx|docm|dotx|dotm|doc|odt|xlsx|xlsm|xltx|xltm|xls|xlsb|ods|pptx|pptm|ppsx|ppsm|potx|potm|ppt|pps|odp)$/iu.test(
    normalizedName,
  );
}

function isOfficeMime(mimeType: string): boolean {
  return [
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ].includes(mimeType);
}

function numberPreviewProperty(
  metadata: JsonObject,
  key: "height" | "pageCount" | "width",
): Partial<Pick<DrivePreview, "height" | "pageCount" | "width">> {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? { [key]: value } : {};
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function toUint8Array(body: AsyncIterable<Uint8Array> | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      output.push(trimmed);
    }
  }
  return output;
}

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
