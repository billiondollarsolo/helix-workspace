// ponytail: IO adapter still >400 LOC (quota SQL, comments, PDF form, WebDAV read); follow-up split: comments-store, pdf-form-store, share-links-store.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { Actor, EventBus, JsonObject, StorageClient, StorageObject } from "@helix/sdk-types";
import { RateLimitedError } from "../../api/api-error.js";
import { env } from "../../config/env.js";
import { sensitivityClassificationFromMetadata } from "../ai/classification/index.js";
import { canonicalizeJson } from "../audit.js";
import { computeAuditHash } from "../audit/hash.js";
import { hashSecret, verifySecret } from "../auth/oauth.js";
import { insertNotification } from "../notifications/index.js";
import { grantObjectAccess } from "../permissions/grant-object-access.js";
import type { TenantPresignedPutUpload, TenantStorageResolver } from "../storage/index.js";
import { withTenantIoSagaPostgresContext as withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import type {
  AcquireDriveWebDavLockInput,
  DriveAccessGrantRecord,
  DriveAutoTagWrite,
  DriveCommentListItem,
  DriveCommentPage,
  DriveCommentRecord,
  DriveCommentRevisionPage,
  DriveCommentRevisionRecord,
  DriveEnrichmentProjectionStore,
  DriveEnrichmentWrite,
  DriveEntryPage,
  DriveEntryRecord,
  DrivePdfFormStateRecord,
  DrivePreview,
  DriveSearchProjectionStore,
  DriveSearchHit,
  DriveSearchRecord,
  DriveUploadRecord,
  DriveVersionRecord,
  DriveWebDavChangePage,
  DriveWebDavLock,
} from "./types.js";
import { BadRequestError } from "../../api/api-error.js";
import {
  DriveConflictError,
  DriveForbiddenError,
  DriveNotFoundError,
  DriveStorageQuotaExceededError,
} from "./errors.js";
import { type DriveRole, driveRoleRank, hasRoleAtLeast, parseDriveRole } from "./core/roles.js";
import { driveQuarantineStorageKey, driveStorageKey } from "./core/storage-key.js";
import {
  isDriveBlobStorageKey,
  resolveFinalizeStorageKey,
  shouldDeleteBlobStorage,
} from "./core/dedup.js";
import {
  DEFAULT_MULTIPART_PART_SIZE,
  DEFAULT_MULTIPART_THRESHOLD,
  MAX_MULTIPART_PARTS,
  planMultipartParts,
  shouldUseMultipartUpload,
  validateCompletedParts,
} from "./multipart.js";
import { distinctStoredBytes } from "./core/quota.js";
import { mentionedActorIds, mentionTokensForComment } from "./core/mentions.js";
import { createDefaultTrashSyncRegistry, type TrashSyncRegistry } from "./core/trash-sync.js";
import {
  bytesFromDatabase,
  mapDriveAccessGrant as mapDriveAccessGrantCore,
  mapObjectEntry as mapObjectEntryCore,
  mapSearchHit as mapSearchHitCore,
  mapVersion as mapVersionCore,
  nullableStringMetadata,
  stringMetadata,
} from "./core/mappers.js";
import { officePreviewStorageKey, type OfficePreviewConverter } from "./preview.js";
import {
  createNoopVirusScanner,
  isNoopVirusScanner,
  resolveEffectiveMime,
  sniffMimeType,
  type VirusScanResult,
  type VirusScanner,
} from "./scanning.js";
import { dlpDecisionError, type DlpGuard } from "../dlp.js";

export { DriveStorageQuotaExceededError } from "./errors.js";

export interface DriveStorageClient extends StorageClient {
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
    options?: { readonly contentType?: string; readonly expiresSeconds?: number },
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
  readonly byteSize: number;
  readonly sha256?: string;
  readonly metadata?: JsonObject;
}

export interface FinalizeDriveUploadInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly objectId: string;
  readonly byteSize: number;
  readonly sha256?: string;
  readonly mimeType?: string;
  readonly content?: Uint8Array;
  readonly metadata?: JsonObject;
  readonly idempotencyKey?: string;
}

export interface CompleteMultipartUploadInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly objectId: string;
  readonly uploadId: string;
  readonly parts: readonly { readonly partNumber: number; readonly etag: string }[];
  readonly byteSize: number;
  readonly sha256?: string;
  readonly mimeType?: string;
  readonly metadata?: JsonObject;
}

export type DriveDocumentSurfaceView = "grid" | "list";

export interface DriveStore {
  prepareUpload(input: PrepareDriveUploadInput): Promise<DriveUploadRecord>;
  finalizeUpload(input: FinalizeDriveUploadInput): Promise<DriveVersionRecord>;
  openFile?(input: DriveFileReadInput): Promise<DriveFileStreamResult | null>;
  completeMultipartUpload?(input: CompleteMultipartUploadInput): Promise<DriveVersionRecord>;
  list(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId?: string | null;
    readonly includeTrashed?: boolean;
    readonly limit?: number;
    readonly cursor?: string;
    readonly app?: string | null;
    /** Filter by object kind. Defaults to 'file' so existing callers stay
     *  unchanged; pass 'recording' for the Recordings drive surface. */
    readonly kind?: string | null;
    readonly acrossFolders?: boolean;
  }): Promise<DriveEntryPage>;
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
  moveFolder?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
    readonly parentFolderId?: string | null;
  }): Promise<DriveEntryRecord | null>;
  setStarred?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly starred: boolean;
  }): Promise<DriveEntryRecord | null>;
  getDocumentSurfaceView?(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<DriveDocumentSurfaceView>;
  setDocumentSurfaceView?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly view: DriveDocumentSurfaceView;
  }): Promise<DriveDocumentSurfaceView>;
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
  trashFolder?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
  }): Promise<DriveEntryRecord | null>;
  restoreFolder?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
  }): Promise<DriveEntryRecord | null>;
  deleteFolder?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
  }): Promise<boolean>;
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
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<DriveCommentPage>;
  listCommentRevisions?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<DriveCommentRevisionPage>;
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
    readonly idempotencyKey?: string;
  }): Promise<DriveVersionRecord>;
  createShareLink?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly password?: string | undefined;
    readonly expiresAt?: Date | null;
    readonly oneTime?: boolean | undefined;
    readonly allowedDomains?: readonly string[] | undefined;
    readonly allowDownload?: boolean | undefined;
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
  resolveShareLink?(input: DriveShareAccessInput): Promise<{
    readonly orgId: string;
    readonly objectId: string;
  } | null>;
  /** Public-link content access. The raw token is never persisted. */
  openFileByShareToken?(input: DriveShareAccessInput): Promise<DriveFileStreamResult | null>;
}

export interface DriveShareAccessInput {
  readonly token: string;
  readonly clientKey: string;
  readonly password?: string | undefined;
  readonly actor?: Pick<Actor, "id" | "orgId" | "email"> | undefined;
  readonly download?: boolean | undefined;
}

export interface DriveShareLinkRecord {
  readonly id: string;
  readonly orgId: string;
  readonly objectId: string;
  readonly token: string | null;
  readonly role: "reader";
  readonly expiresAt: Date | null;
  readonly passwordProtected: boolean;
  readonly oneTime: boolean;
  readonly allowedDomains: readonly string[];
  readonly allowDownload: boolean;
  readonly consumedAt: Date | null;
  readonly createdByActorId: string | null;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
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

export interface DriveObjectStream {
  readonly byteSize: number;
  readonly etag: string;
  readonly open: (range?: {
    readonly start: number;
    readonly end: number;
  }) => Promise<StorageObject["body"] | null>;
}

export interface DriveFileStreamResult extends DriveObjectStream {
  readonly orgId?: string;
  readonly entry: DriveEntryRecord;
  readonly preview?: DriveObjectStream;
}

export interface PostgresDriveStoreOptions {
  readonly officePreviewConverter?: OfficePreviewConverter;
  readonly events?: Pick<EventBus, "publish">;
  readonly onQuotaEventError?: (error: unknown) => void;
  readonly metrics?:
    | {
        recordOperationalEvent(input: {
          readonly capability: "drive";
          readonly operation: "finalize" | "download" | "virus_scan" | "quota";
          readonly status: "success" | "error" | "retry" | "blocked" | "dry_run";
          readonly durationSeconds?: number;
        }): void;
        addOperationalUnits(input: {
          readonly capability: "drive";
          readonly measure: "uploaded_bytes" | "downloaded_bytes" | "quarantined_bytes";
          readonly value?: number;
        }): void;
      }
    | undefined;
  readonly storageResolver?: TenantStorageResolver;
  /** Pluggable AV. Production construction fails closed when this is omitted or no-op. */
  readonly virusScanner?: VirusScanner;
  /** Require a real scanner even outside NODE_ENV=production (all secure tiers). */
  readonly requireVirusScanner?: boolean;
  readonly virusScanMaxAttempts?: number;
  readonly virusScanRetryDelayMs?: number;
  readonly onVirusScanUnavailable?: (event: DriveVirusScanUnavailableEvent) => void;
  readonly onQuarantineDeleteError?: (event: DriveQuarantineDeleteErrorEvent) => void;
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
  /** Lifetime for a prepared multipart plan and its presigned URLs (default 15 minutes). */
  readonly multipartSessionTtlMs?: number;
  readonly dlp?: DlpGuard;
}

export interface DriveVirusScanUnavailableEvent {
  readonly orgId: string;
  readonly objectId: string;
  readonly attempts: number;
  readonly status: "pending" | "dead_lettered";
  readonly error: string;
}

export interface DriveQuarantineDeleteErrorEvent {
  readonly orgId: string;
  readonly objectId: string;
  readonly storageKey: string;
  readonly attempts: number;
  readonly error: string;
}

export interface DriveVirusScanRetryBatchResult {
  readonly claimed: number;
  readonly completed: number;
  readonly failed: number;
}

export interface RetryDeadLetteredVirusScanInput {
  readonly orgId: string;
  readonly objectId: string;
  readonly actorId: string;
  readonly reason: string;
}

interface ObjectRow {
  readonly id: string;
  readonly org_id: string;
  readonly owner_actor_id: string | null;
  readonly kind: string;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: string | number;
  readonly sha256: string | null;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly trash_purge_after: Date | null;
  readonly retain_until: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface DriveVersionRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly version_number: number;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: string | number;
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
  readonly trash_purge_after: Date | null;
  readonly retain_until: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface DriveSearchRow extends ObjectRow {
  readonly version_number: number | null;
  readonly mine?: boolean | null;
  readonly shared_count?: number | string | null;
  readonly starred?: boolean | null;
}

interface DriveListRow {
  readonly entry_type: "file" | "folder";
  readonly id: string;
  readonly name: string;
  readonly folder_id: string | null;
  readonly owner_actor_id: string | null;
  readonly app: string | null;
  readonly mime_type: string | null;
  readonly byte_size: string | number | null;
  readonly sha256: string | null;
  readonly storage_key: string | null;
  readonly version_number: number | null;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly mine: boolean | null;
  readonly shared_count: string | number | null;
  readonly starred: boolean | null;
  readonly sort_name: string;
  readonly sort_type: number;
  readonly snapshot_at: Date;
}

interface DriveSearchProjectionRow extends ObjectRow {
  readonly owner_display_name: string | null;
  readonly owner_email: string | null;
  readonly folder_path: readonly string[];
  readonly allowed_actor_ids: readonly string[];
}

interface StorageQuotaDecisionRow {
  readonly accepted: boolean;
  readonly used_bytes: string | number;
  readonly reserved_bytes: string | number;
  readonly limit_bytes: string | number | null;
  readonly projected_bytes: string | number;
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
  readonly revision: string | number;
  readonly changed_by_actor_id: string | null;
  readonly resolved_by_actor_id: string | null;
  readonly deleted_by_actor_id: string | null;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date | null;
}

interface DriveCommentRevisionRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly comment_id: string;
  readonly revision: string | number;
  readonly change_kind: DriveCommentRevisionRecord["changeKind"];
  readonly parent_comment_id: string | null;
  readonly comment_actor_id: string | null;
  readonly anchor: JsonObject;
  readonly body: string;
  readonly status: DriveCommentRevisionRecord["status"];
  readonly metadata: JsonObject;
  readonly resolved_at: Date | null;
  readonly resolved_by_actor_id: string | null;
  readonly deleted_at: Date | null;
  readonly deleted_by_actor_id: string | null;
  readonly changed_by_actor_id: string;
  readonly captured_at: Date;
}

interface DriveShareLinkRow {
  readonly id: string;
  readonly org_id: string;
  readonly token_hash: string;
  readonly object_id: string;
  readonly role: "reader";
  readonly password_hash: string | null;
  readonly one_time: boolean;
  readonly allowed_domains: readonly string[];
  readonly allow_download: boolean;
  readonly consumed_at: Date | null;
  readonly access_count: string | number;
  readonly last_access_at: Date | null;
  readonly classification: string;
  readonly expires_at: Date | null;
  readonly created_by_actor_id: string | null;
  readonly created_at: Date;
  readonly revoked_at: Date | null;
}

interface DriveShareLinkAccessRow extends ObjectRow {
  readonly link_id: string;
  readonly link_org_id: string;
  readonly link_object_id: string;
  readonly token_hash: string;
  readonly role: "reader";
  readonly password_hash: string | null;
  readonly one_time: boolean;
  readonly allowed_domains: readonly string[];
  readonly allow_download: boolean;
  readonly consumed_at: Date | null;
  readonly access_count: string | number;
  readonly last_access_at: Date | null;
  readonly link_classification: string;
  readonly expires_at: Date | null;
  readonly created_by_actor_id: string | null;
  readonly link_created_at: Date;
  readonly revoked_at: Date | null;
}

interface DriveScanJobRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly actor_id: string | null;
  readonly status: "pending" | "processing" | "dead_lettered";
  readonly attempt_count: number;
  readonly next_attempt_at: Date | null;
  readonly finalize_metadata: JsonObject;
}

interface DriveScanFailureRow extends DriveScanJobRow {
  readonly status: "pending" | "dead_lettered";
}

interface DriveScanClaimRow extends DriveScanJobRow {
  readonly owner_actor_id: string | null;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: string | number;
  readonly sha256: string | null;
}

interface DriveQuarantineDeletionRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly actor_id: string | null;
  readonly storage_key: string;
  readonly status: "pending" | "processing" | "completed";
  readonly attempt_count: number;
  readonly next_attempt_at: Date;
  readonly completed_at?: Date | null;
}

interface DriveMultipartSessionRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly actor_id: string | null;
  readonly storage_key: string;
  readonly upload_id: string | null;
  readonly status:
    | "provisioning"
    | "pending"
    | "completing"
    | "uploaded"
    | "completed"
    | "aborting";
  readonly byte_size: string | number;
  readonly part_size: number;
  readonly part_count: number;
  readonly expires_at: Date;
  readonly lease_expires_at: Date | null;
  readonly completion_hash: string | null;
  readonly version_id: string | null;
  readonly last_error: string | null;
}

interface DriveMultipartSweepRow extends DriveMultipartSessionRow {
  readonly prior_status: DriveMultipartSessionRow["status"];
}

interface DriveMultipartClaim {
  readonly session: DriveMultipartSessionRow;
  readonly object: ObjectRow;
  readonly version?: DriveVersionRecord;
  readonly completeStorage: boolean;
}

interface DrivePreviewJobRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly version_id: string;
  readonly actor_id: string | null;
  readonly attempt_count: number;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: string | number;
  readonly version_number: number;
  readonly object_metadata: JsonObject;
}

interface DriveFinalizationClaim {
  readonly object: ObjectRow;
  readonly token: string;
  readonly previousStatus: string;
  readonly reservedKey: string;
  readonly versionNumber: number;
}

type DrivePreparedUploadSweepRow = ObjectRow;

interface DriveCommentProjectionRow extends DriveCommentRow {
  readonly actor_display_name: string | null;
  readonly actor_email: string | null;
}

interface DriveCommentObjectContext extends ObjectRow {
  readonly comment_role_rank: number;
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

interface DriveWebDavLockRow {
  readonly path_key: string;
  readonly token: string;
  readonly actor_id: string;
  readonly owner: string;
  readonly depth: "0" | "infinity";
  readonly fence: string | number;
  readonly created_at: Date;
  readonly expires_at: Date;
}

interface DriveWebDavCollectionRow {
  readonly version: string | number;
  readonly min_version: string | number;
}

interface DriveWebDavChangeRow {
  readonly resource_path_key: string;
  readonly resource_type: "file" | "folder";
  readonly status: 200 | 404;
  readonly version: string | number;
}

type SqlLike = postgres.Sql | postgres.TransactionSql;

const DEFAULT_VIRUS_SCAN_MAX_ATTEMPTS = 5;
const DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS = 30_000;
const DEFAULT_UPLOAD_LEASE_MS = 120_000;
const DEFAULT_MULTIPART_SESSION_TTL_MS = 15 * 60_000;

interface PdfFormSourceMetadata {
  readonly versionNumber: number | null;
  readonly sha256: string | null;
  readonly byteSize: number | null;
}

export class PostgresDriveStore
  implements DriveStore, DriveSearchProjectionStore, DriveEnrichmentProjectionStore
{
  private readonly trashSync: TrashSyncRegistry;
  private readonly virusScanner: VirusScanner;
  private virusScanOrgCursor: string | undefined;

  constructor(
    private readonly sql: postgres.Sql,
    private readonly storage?: DriveStorageClient,
    private readonly options: PostgresDriveStoreOptions = {},
  ) {
    this.trashSync = options.trashSync ?? createDefaultTrashSyncRegistry();
    this.virusScanner = options.virusScanner ?? createNoopVirusScanner();
    const scannerRequired = options.requireVirusScanner ?? env().NODE_ENV === "production";
    if (scannerRequired && isNoopVirusScanner(this.virusScanner)) {
      throw new Error("Drive antivirus scanner is required in production and secure tiers.");
    }
  }

  async acquireWebDavLock(input: AcquireDriveWebDavLockInput): Promise<DriveWebDavLock | null> {
    assertWebDavPathKey(input.pathKey);
    const refreshToken = input.token === undefined ? undefined : webDavLockUuid(input.token);
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtextextended(${input.orgId}, 0))`;
        await tx`delete from drive_webdav_locks
          where org_id = ${input.orgId} and expires_at <= statement_timestamp()`;
        if (refreshToken !== undefined) {
          const rows = await tx<DriveWebDavLockRow[]>`
            update drive_webdav_locks
            set expires_at = statement_timestamp() + make_interval(secs => ${input.timeoutSeconds})
            where org_id = ${input.orgId} and path_key = ${input.pathKey}
              and actor_id = ${input.actorId} and token = ${refreshToken}::uuid
            returning *
          `;
          return rows[0] === undefined ? null : mapDriveWebDavLock(rows[0]);
        }
        const conflicts = await tx<DriveWebDavLockRow[]>`
          select * from drive_webdav_locks
          where org_id = ${input.orgId}
            and (
              path_key = ${input.pathKey}
              or (depth = 'infinity' and (path_key = '/' or ${input.pathKey} like path_key || '/%'))
              or (${input.depth} = 'infinity' and (${input.pathKey} = '/' or path_key like ${input.pathKey} || '/%'))
          )
          order by length(path_key) desc, fence desc
        `;
        if (conflicts[0] !== undefined) return null;
        const rows = await tx<DriveWebDavLockRow[]>`
          insert into drive_webdav_locks (
            org_id, path_key, token, actor_id, owner, depth, expires_at
          ) values (
            ${input.orgId}, ${input.pathKey}, ${randomUUID()}, ${input.actorId}, ${input.owner},
            ${input.depth}, statement_timestamp() + make_interval(secs => ${input.timeoutSeconds})
          )
          returning *
        `;
        return mapDriveWebDavLock(rows[0]);
      },
    );
  }

  async listWebDavLocks(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly pathKeys: readonly string[];
  }): Promise<readonly DriveWebDavLock[]> {
    if (input.pathKeys.length === 0) return [];
    input.pathKeys.forEach(assertWebDavPathKey);
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) =>
        (
          await tx<DriveWebDavLockRow[]>`
          select lock.*
          from drive_webdav_locks lock
          where lock.org_id = ${input.orgId}
            and lock.expires_at > statement_timestamp()
            and exists (
              select 1 from unnest(${input.pathKeys}::text[]) requested(path_key)
              where lock.path_key = requested.path_key
                or (lock.depth = 'infinity' and (
                  lock.path_key = '/' or requested.path_key like lock.path_key || '/%'
                ))
            )
          order by length(lock.path_key) desc, lock.fence desc
        `
        ).map(mapDriveWebDavLock),
    );
  }

  async releaseWebDavLock(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly pathKey: string;
    readonly token: string;
  }): Promise<boolean> {
    assertWebDavPathKey(input.pathKey);
    const token = webDavLockUuid(input.token);
    const rows = await withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      (tx) => tx`
        delete from drive_webdav_locks
        where org_id = ${input.orgId} and path_key = ${input.pathKey}
          and actor_id = ${input.actorId} and token = ${token}::uuid
        returning path_key
      `,
    );
    return rows.length === 1;
  }

  async listWebDavChanges(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly collectionPathKey: string;
    readonly afterVersion?: string;
    readonly limit: number;
  }): Promise<DriveWebDavChangePage> {
    assertWebDavPathKey(input.collectionPathKey);
    const afterVersion =
      input.afterVersion === undefined ? undefined : webDavSyncVersion(input.afterVersion);
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 250);
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        const stateRows = await tx<DriveWebDavCollectionRow[]>`
          select version, min_version from drive_webdav_collections
          where org_id = ${input.orgId} and path_key = ${input.collectionPathKey}
          for share
        `;
        const current = String(stateRows[0]?.version ?? 0);
        const minimum = String(stateRows[0]?.min_version ?? 0);
        if (afterVersion === undefined) {
          return { changes: [], version: current, valid: true, hasMore: false };
        }
        if (stateRows[0] === undefined) {
          return { changes: [], version: "0", valid: afterVersion === "0", hasMore: false };
        }
        if (BigInt(afterVersion) < BigInt(minimum) || BigInt(afterVersion) > BigInt(current)) {
          return { changes: [], version: current, valid: false, hasMore: false };
        }
        const rows = await tx<DriveWebDavChangeRow[]>`
          select resource_path_key, resource_type, status, version
          from drive_webdav_changes
          where org_id = ${input.orgId} and collection_path_key = ${input.collectionPathKey}
            and version > ${afterVersion}::bigint
            and ${input.actorId}::uuid = any(audience_actor_ids)
          order by version
          limit ${limit + 1}
        `;
        const hasMore = rows.length > limit;
        const page = rows.slice(0, limit);
        return {
          changes: page.map((row) => ({
            pathKey: row.resource_path_key,
            resourceType: row.resource_type,
            status: row.status,
            version: String(row.version),
          })),
          version: hasMore ? String(page.at(-1)?.version ?? afterVersion) : current,
          valid: true,
          hasMore,
        };
      },
    );
  }

  async prepareUpload(input: PrepareDriveUploadInput): Promise<DriveUploadRecord> {
    const storage = await this.storageForOrg(input.orgId);
    const threshold = this.options.multipartThresholdBytes ?? DEFAULT_MULTIPART_THRESHOLD;
    const partSize = this.options.multipartPartSizeBytes ?? DEFAULT_MULTIPART_PART_SIZE;
    const multipart =
      shouldUseMultipartUpload(input.byteSize, threshold) &&
      storage?.createMultipartUpload !== undefined &&
      storage.presignUploadPart !== undefined
        ? planMultipartParts(input.byteSize, partSize, MAX_MULTIPART_PARTS)
        : undefined;
    const expiresAt = new Date(
      Date.now() +
        Math.max(1_000, this.options.multipartSessionTtlMs ?? DEFAULT_MULTIPART_SESSION_TTL_MS),
    );
    const prepared = await withTenantPostgresContext(
      this.sql,
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
            this.emitStorageQuotaExceeded(input.orgId, event);
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
        const upload = await this.presignPutRequest(storage, prepared.storageKey, input.mimeType);
        return {
          ...prepared,
          uploadUrl: upload?.url ?? null,
          uploadHeaders: upload?.headers ?? {},
        };
      } catch (error) {
        await this.discardPreparedUpload(input.orgId, input.actorId, prepared.objectId);
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
      await withTenantPostgresContext(this.sql, { orgId: input.orgId }, (tx) =>
        bindDriveMultipartSession(tx, input.orgId, prepared.objectId, uploadId as string),
      );
      const expiresSeconds = Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1_000));
      const partUrls = await Promise.all(
        multipart.parts.map((part) =>
          presignUploadPart(prepared.storageKey, uploadId as string, part.partNumber, {
            contentType: input.mimeType,
            expiresSeconds,
          }),
        ),
      );
      await withTenantPostgresContext(this.sql, { orgId: input.orgId }, (tx) =>
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
      await this.compensatePreparedMultipart({
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

  async completeMultipartUpload(input: CompleteMultipartUploadInput): Promise<DriveVersionRecord> {
    const validated = validateCompletedParts(input.parts, input.parts.length);
    if (!validated.ok) {
      throw new DriveConflictError(validated.reason);
    }
    const completionHash = multipartCompletionHash(input);
    const claim = await withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      (tx) => claimDriveMultipartCompletion(tx, input, completionHash),
    );
    if (claim.version !== undefined) return claim.version;

    const storage = await this.storageForOrg(input.orgId);
    if (storage?.completeMultipartUpload === undefined) {
      await this.releaseMultipartCompletion(claim.session, "Multipart storage is unavailable.");
      throw new Error("Drive multipart upload is not configured for this storage client.");
    }
    if (claim.completeStorage) {
      try {
        await storage.completeMultipartUpload(
          claim.session.storage_key,
          input.uploadId,
          input.parts,
        );
      } catch (error) {
        const uploaded = await storage.get(claim.session.storage_key).catch(() => null);
        if (uploaded === null) {
          await this.releaseMultipartCompletion(claim.session, virusScanErrorMessage(error));
          throw error;
        }
      }
      await withTenantPostgresContext(this.sql, { orgId: input.orgId }, (tx) =>
        markDriveMultipartUploaded(tx, claim.session, completionHash),
      );
    }

    const version = await this.finalizeUpload({
      orgId: input.orgId,
      actorId: input.actorId,
      objectId: input.objectId,
      byteSize: input.byteSize,
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      ...(input.mimeType === undefined ? {} : { mimeType: input.mimeType }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      idempotencyKey: completionHash,
    });
    await withTenantPostgresContext(this.sql, { orgId: input.orgId }, (tx) =>
      markDriveMultipartCompleted(tx, claim.session, completionHash, version.id),
    );
    return version;
  }

  async finalizeUpload(input: FinalizeDriveUploadInput): Promise<DriveVersionRecord> {
    const startedAt = Date.now();
    try {
      const version = await this.finalizeUploadForScan(input, false);
      this.options.metrics?.recordOperationalEvent({
        capability: "drive",
        operation: "finalize",
        status: "success",
        durationSeconds: (Date.now() - startedAt) / 1_000,
      });
      return version;
    } catch (error) {
      this.options.metrics?.recordOperationalEvent({
        capability: "drive",
        operation: "finalize",
        status: "error",
        durationSeconds: (Date.now() - startedAt) / 1_000,
      });
      throw error;
    }
  }

  private async finalizeUploadForScan(
    input: FinalizeDriveUploadInput,
    fromRetryWorker: boolean,
  ): Promise<DriveVersionRecord> {
    if (input.idempotencyKey !== undefined) {
      const replay = await withTenantPostgresContext(
        this.sql,
        { orgId: input.orgId, actorId: input.actorId },
        (tx) => findIdempotentDriveVersion(tx, input),
      );
      if (replay !== null) return replay;
    }
    const claim = await withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      (tx) => claimDriveUploadFinalization(tx, input, fromRetryWorker),
    );
    let committed = false;
    let writtenStorageKey: string | undefined;
    let previewStorageKey: string | undefined;
    let blobReservationId: string | undefined;
    try {
      const storage = await this.storageForOrg(input.orgId);
      if (input.content === undefined && storage === undefined) {
        throw new Error("Drive upload content storage is not configured.");
      }
      const inspected = await inspectAndScanUpload({
        open: async () =>
          input.content ?? (await readStoredUpload(storage, claim.reservedKey))?.body ?? null,
        declaredByteSize: input.byteSize,
        declaredMimeType: input.mimeType ?? claim.object.mime_type,
        scanner: this.virusScanner,
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
        this.options.metrics?.recordOperationalEvent({
          capability: "drive",
          operation: "virus_scan",
          status: "error",
        });
        const error = scan;
        const errorMessage = virusScanErrorMessage(error);
        const failure = await withTenantPostgresContext(
          this.sql,
          { orgId: input.orgId, actorId: input.actorId },
          (tx) =>
            commitDriveScanFailure(tx, {
              claim,
              input,
              mimeType,
              byteSize: actualByteSize,
              sha256: actualSha256,
              error: errorMessage,
              maxAttempts: this.options.virusScanMaxAttempts ?? DEFAULT_VIRUS_SCAN_MAX_ATTEMPTS,
              retryDelayMs: this.options.virusScanRetryDelayMs ?? DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS,
            }),
        );
        committed = true;
        this.options.onVirusScanUnavailable?.({
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
                  Math.ceil((failure.next_attempt_at.getTime() - Date.now()) / 1_000),
                ),
              }),
        });
      }

      const dlpDecision = await this.options.dlp?.evaluate({
        orgId: input.orgId,
        actorId: input.actorId,
        boundary: "drive_upload",
        ...(bufferedBytes === undefined ? { scanIncomplete: true } : { content: bufferedBytes }),
        resources: [{ resourceType: "drive.file", resourceId: input.objectId }],
      });
      if (dlpDecision?.action === "block") throw dlpDecisionError(dlpDecision);
      const dlpQuarantine = dlpDecision?.action === "quarantine";

      if (!scan.clean || dlpQuarantine) {
        this.options.metrics?.recordOperationalEvent({
          capability: "drive",
          operation: "virus_scan",
          status: "blocked",
        });
        this.options.metrics?.addOperationalUnits({
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
            this.emitQuarantineDeleteError({
              orgId: input.orgId,
              objectId: input.objectId,
              storageKey: quarantineKey,
              attempts: 0,
              error: `Quarantine copy failed: ${virusScanErrorMessage(error)}`,
            });
          }
        }
        const deletions = await withTenantPostgresContext(
          this.sql,
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
        for (const deletion of deletions) await this.deleteQuarantinedBytes(deletion);
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

      const dedup = this.options.contentAddressedDedup === true;
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
        const blob = await withTenantPostgresContext(this.sql, { orgId: input.orgId }, (tx) =>
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

      const preview = await this.generatePreview({
        orgId: input.orgId,
        objectId: input.objectId,
        name: objectName,
        storageKey,
        mimeType,
        versionNumber: claim.versionNumber,
        byteSize: actualByteSize,
        ...(bufferedBytes === undefined ? {} : { inlineContent: bufferedBytes }),
      });
      previewStorageKey = preview.writtenStorageKey;
      const result = await withTenantPostgresContext(
        this.sql,
        { orgId: input.orgId, actorId: input.actorId },
        (tx) =>
          commitDriveCleanUpload(tx, {
            claim,
            input,
            storageKey,
            mimeType,
            byteSize: actualByteSize,
            sha256: actualSha256,
            preview: preview.metadata,
            dedup,
            ...(blobReservationId === undefined ? {} : { blobReservationId }),
            emitQuotaExceeded: (event) => {
              this.emitStorageQuotaExceeded(input.orgId, event);
            },
          }),
      );
      this.options.metrics?.recordOperationalEvent({
        capability: "drive",
        operation: "virus_scan",
        status: "success",
      });
      this.options.metrics?.addOperationalUnits({
        capability: "drive",
        measure: "uploaded_bytes",
        value: actualByteSize,
      });
      committed = true;
      writtenStorageKey = undefined;
      previewStorageKey = undefined;
      if (result.stagedDeletion !== undefined) {
        await this.deleteQuarantinedBytes(result.stagedDeletion);
      }
      return result.version;
    } catch (error) {
      if (!committed) {
        if (blobReservationId !== undefined) {
          await withTenantPostgresContext(this.sql, { orgId: input.orgId }, (tx) =>
            releaseDriveBlobReservation(tx, input.orgId, blobReservationId as string),
          ).catch(() => undefined);
        }
        for (const key of new Set([writtenStorageKey, previewStorageKey])) {
          if (key === undefined) continue;
          if (
            key === writtenStorageKey &&
            isDriveBlobStorageKey(key) &&
            (await withTenantPostgresContext(this.sql, { orgId: input.orgId }, (tx) =>
              driveBlobStorageIsReferenced(tx, input.orgId, key),
            ).catch(() => true))
          ) {
            continue;
          }
          await this.discardOrphanedQuarantineCopy({
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
        await withTenantPostgresContext(this.sql, { orgId: input.orgId }, (tx) =>
          releaseDriveFinalizationClaim(tx, claim),
        ).catch(() => undefined);
      }
      throw error;
    }
  }

  /** Claim due jobs once and retry their authoritative stored bytes. */
  async runVirusScanRetryBatch(input: {
    readonly limit: number;
    readonly leaseMs: number;
    readonly now?: Date;
    readonly includeVirusScans?: boolean;
  }): Promise<DriveVirusScanRetryBatchResult> {
    const now = input.now ?? new Date();
    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit)));
    const multipartClaims: DriveMultipartSweepRow[] = [];
    const preparedUploadClaims: DrivePreparedUploadSweepRow[] = [];
    const quarantineClaims: DriveQuarantineDeletionRow[] = [];
    const previewClaims: DrivePreviewJobRow[] = [];
    const claims: DriveScanClaimRow[] = [];
    const orgIds = await this.nextVirusScanOrgPage(Math.min(1_000, Math.max(50, limit * 5)));
    for (const orgId of orgIds) {
      this.virusScanOrgCursor = orgId;
      await withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
        await reconcileDriveBlobReferences(tx, orgId);
        await tx`select * from helix_reconcile_storage_usage(${orgId})`;
      });
      const tenantMultipartClaims = await withTenantPostgresContext(this.sql, { orgId }, (tx) =>
        claimExpiredDriveMultipartSessions(tx, {
          limit:
            limit -
            multipartClaims.length -
            preparedUploadClaims.length -
            quarantineClaims.length -
            previewClaims.length -
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
          previewClaims.length +
          claims.length >=
        limit
      )
        break;
      const tenantPreparedUploadClaims = await withTenantPostgresContext(
        this.sql,
        { orgId },
        (tx) =>
          claimExpiredPreparedUploads(tx, {
            limit:
              limit -
              multipartClaims.length -
              preparedUploadClaims.length -
              quarantineClaims.length -
              previewClaims.length -
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
          previewClaims.length +
          claims.length >=
        limit
      )
        break;
      const tenantQuarantineClaims = await withTenantPostgresContext(this.sql, { orgId }, (tx) =>
        claimDriveQuarantineDeletions(tx, {
          limit:
            limit -
            multipartClaims.length -
            preparedUploadClaims.length -
            quarantineClaims.length -
            previewClaims.length -
            claims.length,
          leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
          now,
        }),
      );
      quarantineClaims.push(...tenantQuarantineClaims);
      const remaining =
        limit -
        multipartClaims.length -
        preparedUploadClaims.length -
        quarantineClaims.length -
        previewClaims.length -
        claims.length;
      if (remaining > 0) {
        previewClaims.push(
          ...(await withTenantPostgresContext(this.sql, { orgId }, (tx) =>
            claimDrivePreviewJobs(tx, {
              limit: remaining,
              leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
              now,
            }),
          )),
        );
      }
      if (
        multipartClaims.length +
          preparedUploadClaims.length +
          quarantineClaims.length +
          previewClaims.length +
          claims.length >=
        limit
      )
        break;
      if (input.includeVirusScans !== false) {
        const tenantClaims = await withTenantPostgresContext(this.sql, { orgId }, (tx) =>
          claimDriveScanJobs(tx, {
            limit:
              limit -
              multipartClaims.length -
              preparedUploadClaims.length -
              quarantineClaims.length -
              previewClaims.length -
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
          previewClaims.length +
          claims.length >=
        limit
      )
        break;
    }
    let completed = 0;
    let failed = 0;
    for (const claim of multipartClaims) {
      if (await this.abortExpiredMultipart(claim)) completed += 1;
      else failed += 1;
    }
    for (const claim of preparedUploadClaims) {
      if (await this.deleteExpiredPreparedUpload(claim)) completed += 1;
      else failed += 1;
    }
    for (const claim of quarantineClaims) {
      if (await this.deleteQuarantinedBytes(claim)) completed += 1;
      else failed += 1;
    }
    for (const claim of previewClaims) {
      if (await this.processDrivePreviewJob(claim)) completed += 1;
      else failed += 1;
    }
    for (const claim of claims) {
      try {
        const actorId = claim.actor_id ?? claim.owner_actor_id;
        if (actorId === null || claim.sha256 === null) {
          throw new Error("Drive scan job is missing its actor or verified digest.");
        }
        await this.finalizeUploadForScan(
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
          this.sql,
          { orgId: claim.org_id },
          async (tx) => {
            const released = await releaseDriveScanClaim(tx, {
              id: claim.id,
              orgId: claim.org_id,
              error: errorMessage,
              maxAttempts: this.options.virusScanMaxAttempts ?? DEFAULT_VIRUS_SCAN_MAX_ATTEMPTS,
              retryDelayMs: this.options.virusScanRetryDelayMs ?? DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS,
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
          this.options.onVirusScanUnavailable?.({
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
        previewClaims.length +
        claims.length,
      completed,
      failed,
    };
  }

  private async nextVirusScanOrgPage(limit: number): Promise<readonly string[]> {
    let rows = await listDriveScanOrgIds(this.sql, this.virusScanOrgCursor, limit);
    if (rows.length === 0 && this.virusScanOrgCursor !== undefined) {
      this.virusScanOrgCursor = undefined;
      rows = await listDriveScanOrgIds(this.sql, undefined, limit);
    }
    if (rows.length < limit) this.virusScanOrgCursor = undefined;
    return rows;
  }

  /** Admin-only caller resets a DLQ item for another real scan; it never bypasses AV. */
  async retryDeadLetteredVirusScan(input: RetryDeadLetteredVirusScanInput): Promise<boolean> {
    const reason = input.reason.trim();
    if (reason.length < 10 || reason.length > 1_000) {
      throw new TypeError("A specific antivirus retry reason is required.");
    }
    return withTenantPostgresContext(this.sql, { orgId: input.orgId }, async (tx) => {
      const rows = await tx<{ readonly id: string }[]>`
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

  async list(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId?: string | null;
    readonly includeTrashed?: boolean;
    readonly limit?: number;
    readonly cursor?: string;
    readonly app?: string | null;
    /** Filter by object kind. Defaults to 'file'; the Recordings drive
     *  scope passes 'recording'. */
    readonly kind?: string | null;
    /** When true, return every visible file regardless of which folder
     *  it lives in. Used by the typed surfaces (`/docs`, `/sheets`,
     *  `/slides`) which present a cross-folder app-shaped list. Folder
     *  rows are suppressed in this mode — the result is a flat file list. */
    readonly acrossFolders?: boolean;
  }): Promise<DriveEntryPage> {
    // When filtering for non-file kinds (e.g. 'recording'), the folder
    // hierarchy doesn't apply — those objects don't live in user-managed
    // folders. Force acrossFolders=true so we skip the folder rows and the
    // folderId metadata match.
    const kind = input.kind ?? "file";
    const acrossFolders = input.acrossFolders === true || kind !== "file";
    const limit = Math.min(250, Math.max(1, Math.trunc(input.limit ?? 100)));
    const filter = driveListFilterKey({
      orgId: input.orgId,
      actorId: input.actorId,
      folderId: input.folderId ?? null,
      includeTrashed: input.includeTrashed ?? false,
      app: input.app ?? null,
      kind,
      acrossFolders,
    });
    const cursor = decodeDriveListCursor(input.cursor, filter);
    if (input.folderId !== undefined && input.folderId !== null && !acrossFolders) {
      await requireFolderAccess(this.sql, input.orgId, input.actorId, input.folderId);
    }
    const rows = await withTenantPostgresContext(
      this.sql,
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
              null::text as app,
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

            union all

            select
              'file'::text as entry_type,
              o.id,
              coalesce(o.metadata->>'name', o.storage_key) as name,
              nullif(o.metadata->>'folderId', '') as folder_id,
              o.owner_actor_id,
              nullif(o.metadata->>'app', '') as app,
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
              and coalesce(o.metadata->>'status', 'ready') = 'ready'
              and (${acrossFolders} or coalesce(o.metadata->>'folderId', '') = coalesce(${input.folderId ?? null}::text, ''))
              and (${input.includeTrashed ?? false} or o.deleted_at is null or o.deleted_at > page.snapshot_at)
              and o.created_at <= page.snapshot_at
              and (
                ${input.app ?? null}::text is null
                or coalesce(o.metadata->>'app', 'file') = ${input.app ?? null}
                or (${input.app ?? null}::text = 'docs' and (
                  o.mime_type ilike '%wordprocessingml%'
                  or o.mime_type = 'application/msword'
                  or o.mime_type ilike '%opendocument.text%'
                  or o.mime_type = 'application/rtf'
                  or lower(coalesce(o.metadata->>'name', o.storage_key)) ~ '\\.(docx?|docm|dotx?|dotm|rtf|odt|helixdoc)$'
                ))
                or (${input.app ?? null}::text = 'sheets' and (
                  o.mime_type ilike '%spreadsheetml%'
                  or o.mime_type = 'application/vnd.ms-excel'
                  or o.mime_type = 'application/vnd.oasis.opendocument.spreadsheet'
                  or o.mime_type like 'text/csv%'
                  or o.mime_type = 'text/tab-separated-values'
                  or lower(coalesce(o.metadata->>'name', o.storage_key)) ~ '\\.(xlsx?|xlsm|xlsb|xltx?|xltm|csv|tsv|ods|helixsheet)$'
                ))
                or (${input.app ?? null}::text = 'slides' and (
                  o.mime_type ilike '%presentationml%'
                  or o.mime_type = 'application/vnd.ms-powerpoint'
                  or o.mime_type = 'application/vnd.oasis.opendocument.presentation'
                  or lower(coalesce(o.metadata->>'name', o.storage_key)) ~ '\\.(pptx?|pptm|ppsx?|ppsm|potx?|potm|odp|helixdeck)$'
                ))
              )
              and helix_drive_effective_role(
                ${input.orgId}, ${input.actorId}, 'object', o.id
              ) is not null
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

  async createFolder(input: DriveFolderCreateInput): Promise<DriveEntryRecord> {
    return this.sql.begin(async (tx) => {
      if (input.parentFolderId !== undefined && input.parentFolderId !== null) {
        await requireFolderAddChildren(tx, input.orgId, input.actorId, input.parentFolderId);
      }
      const rows = await tx<DriveFolderRow[]>`
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
      `;
      const folder = mapFolderEntry(rows[0] ?? missingFolderRow());
      await grantFolderAccess(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        folderId: folder.id,
        role: folder.ownerActorId === null ? "editor" : "owner",
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
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        await requireFolderRole(tx, input.orgId, input.actorId, input.folderId, "editor");
        const rows = await tx<
          (DriveFolderRow & {
            readonly trashed_file_ids: readonly string[];
          })[]
        >`
        with recursive folder_tree as (
          select *
          from drive_folders
          where id = ${input.folderId}
            and org_id = ${input.orgId}
            and deleted_at is null
          union all
          select child.*
          from drive_folders child
          join folder_tree parent on child.parent_folder_id = parent.id
          where child.org_id = ${input.orgId}
            and child.deleted_at is null
        ),
        unauthorized as (
          select folder.id
          from folder_tree folder
          where coalesce(helix_drive_effective_role(
            ${input.orgId}, ${input.actorId}, 'drive_folder', folder.id
          ), '') not in ('editor', 'owner')
          union all
          select object.id
          from objects object
          where object.org_id = ${input.orgId}
            and object.kind = 'file'
            and object.deleted_at is null
            and object.metadata->>'folderId' in (select id::text from folder_tree)
            and coalesce(helix_drive_effective_role(
              ${input.orgId}, ${input.actorId}, 'object', object.id
            ), '') not in ('editor', 'owner')
        ),
        trashed_files as (
          update objects
          set deleted_at = now(),
              metadata = metadata || jsonb_build_object('trashRootFolderId', ${input.folderId}),
              updated_at = now()
          where org_id = ${input.orgId}
            and kind = 'file'
            and deleted_at is null
            and metadata->>'folderId' in (select id::text from folder_tree)
            and not exists (select 1 from unauthorized)
          returning id, metadata
        ),
        trashed_folders as (
          update drive_folders
          set deleted_at = now(),
              metadata = metadata || jsonb_build_object('trashRootFolderId', ${input.folderId}),
              updated_at = now()
          where id in (select id from folder_tree)
            and not exists (select 1 from unauthorized)
          returning *
        )
        select folder.*,
          coalesce((select array_agg(id::text) from trashed_files), array[]::text[])
            as trashed_file_ids
        from trashed_folders folder
        where folder.id = ${input.folderId}
        limit 1
      `;
        const row = rows[0];
        if (row === undefined) {
          throw new DriveForbiddenError(
            `Drive folder ${input.folderId} contains an item the actor cannot trash.`,
          );
        }
        for (const objectId of row.trashed_file_ids) {
          await syncTargetDeletedAt(tx, input.orgId, objectId, "trash", this.trashSync);
          await appendDriveActivity(tx, {
            orgId: input.orgId,
            actorId: input.actorId,
            verb: "drive.object.trashed",
            objectId,
            payload: { parentFolderId: input.folderId, recursive: true },
          });
        }
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "drive.folder.trashed",
          objectId: input.folderId,
          payload: { name: row.name, parentFolderId: row.parent_folder_id },
        });
        return mapFolderEntry(row);
      },
    );
  }

  async restoreFolder(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
  }): Promise<DriveEntryRecord | null> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        await requireFolderRoleIncludingDeleted(
          tx,
          input.orgId,
          input.actorId,
          input.folderId,
          "editor",
        );
        const rows = await tx<
          (DriveFolderRow & {
            readonly restored_file_ids: readonly string[];
          })[]
        >`
          with recursive folder_tree as (
            select * from drive_folders
            where id = ${input.folderId} and org_id = ${input.orgId}
              and deleted_at is not null
              and trash_purge_after > now()
              and metadata->>'trashRootFolderId' = ${input.folderId}
              and not (metadata ? 'purgeRootFolderId')
            union all
            select child.* from drive_folders child
            join folder_tree parent on child.parent_folder_id = parent.id
            where child.org_id = ${input.orgId}
              and child.trash_purge_after > now()
              and child.metadata->>'trashRootFolderId' = ${input.folderId}
          ), unauthorized as (
            select folder.id from folder_tree folder
            where coalesce(helix_drive_effective_role(
              ${input.orgId}, ${input.actorId}, 'drive_folder', folder.id
            ), '') not in ('editor', 'owner')
            union all
            select object.id from objects object
            where object.org_id = ${input.orgId}
              and object.metadata->>'trashRootFolderId' = ${input.folderId}
              and coalesce(helix_drive_effective_role(
                ${input.orgId}, ${input.actorId}, 'object', object.id
              ), '') not in ('editor', 'owner')
          ), restored_files as (
            update objects
            set deleted_at = null, metadata = metadata - 'trashRootFolderId', updated_at = now()
            where org_id = ${input.orgId}
              and metadata->>'trashRootFolderId' = ${input.folderId}
              and not exists (select 1 from unauthorized)
            returning id
          ), restored_folders as (
            update drive_folders
            set deleted_at = null, metadata = metadata - 'trashRootFolderId', updated_at = now()
            where id in (select id from folder_tree)
              and not exists (select 1 from unauthorized)
            returning *
          )
          select folder.*,
            coalesce((select array_agg(id::text) from restored_files), array[]::text[])
              as restored_file_ids
          from restored_folders folder
          where folder.id = ${input.folderId}
          limit 1
        `;
        const row = rows[0];
        if (row === undefined) {
          throw new DriveForbiddenError(
            `Drive folder ${input.folderId} contains an item the actor cannot restore.`,
          );
        }
        for (const objectId of row.restored_file_ids) {
          await syncTargetDeletedAt(tx, input.orgId, objectId, "restore", this.trashSync);
          await appendDriveActivity(tx, {
            orgId: input.orgId,
            actorId: input.actorId,
            verb: "drive.object.restored",
            objectId,
            payload: { parentFolderId: input.folderId, recursive: true },
          });
        }
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "drive.folder.restored",
          objectId: input.folderId,
          payload: { name: row.name, parentFolderId: row.parent_folder_id },
        });
        return mapFolderEntry(row);
      },
    );
  }

  /** Purge a previously trashed subtree as a restart-safe saga. The durable
   * marker prevents restore while each file is independently tombstoned and
   * its bytes are handed to the deletion outbox. */
  async deleteFolder(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
  }): Promise<boolean> {
    const fileIds = await withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        await requireFolderRoleIncludingDeleted(
          tx,
          input.orgId,
          input.actorId,
          input.folderId,
          "owner",
        );
        const rows = await tx<
          {
            readonly file_ids: readonly string[];
            readonly root_marked: boolean;
          }[]
        >`
          with recursive folder_tree as (
            select * from drive_folders
            where id = ${input.folderId} and org_id = ${input.orgId}
              and deleted_at is not null
              and (
                metadata->>'trashRootFolderId' = ${input.folderId}
                or metadata->>'purgeRootFolderId' = ${input.folderId}
              )
            union all
            select child.* from drive_folders child
            join folder_tree parent on child.parent_folder_id = parent.id
            where child.org_id = ${input.orgId}
              and (
                child.metadata->>'trashRootFolderId' = ${input.folderId}
                or child.metadata->>'purgeRootFolderId' = ${input.folderId}
              )
          ), unauthorized as (
            select folder.id from folder_tree folder
            where helix_drive_effective_role(
                ${input.orgId}, ${input.actorId}, 'drive_folder', folder.id
              ) is distinct from 'owner'
              or folder.trash_purge_after > now()
              or folder.retain_until > now()
              or exists (
                select 1 from drive_retention_holds hold
                where hold.org_id = ${input.orgId}
                  and hold.resource_type = 'folder' and hold.resource_id = folder.id
                  and hold.released_at is null
                  and (hold.expires_at is null or hold.expires_at > now())
              )
            union all
            select object.id from objects object
            where object.org_id = ${input.orgId}
              and object.metadata->>'trashRootFolderId' = ${input.folderId}
              and (
                helix_drive_effective_role(
                  ${input.orgId}, ${input.actorId}, 'object', object.id
                ) is distinct from 'owner'
                or object.trash_purge_after > now()
                or object.retain_until > now()
                or exists (
                  select 1 from drive_retention_holds hold
                  where hold.org_id = ${input.orgId}
                    and hold.resource_type = 'object' and hold.resource_id = object.id
                    and hold.released_at is null
                    and (hold.expires_at is null or hold.expires_at > now())
                )
              )
          ), marked_folders as (
            update drive_folders
            set metadata = metadata || jsonb_build_object('purgeRootFolderId', ${input.folderId}),
                updated_at = now()
            where id in (select id from folder_tree)
              and not exists (select 1 from unauthorized)
            returning id
          ), marked_files as (
            update objects
            set metadata = metadata || jsonb_build_object('purgeRootFolderId', ${input.folderId}),
                updated_at = now()
            where org_id = ${input.orgId}
              and metadata->>'trashRootFolderId' = ${input.folderId}
              and not exists (select 1 from unauthorized)
            returning id
          )
          select coalesce(array_agg(id::text), array[]::text[]) as file_ids,
            exists (select 1 from marked_folders where id = ${input.folderId}) as root_marked
          from marked_files
        `;
        const row = rows[0];
        if (row?.root_marked !== true) {
          throw new DriveForbiddenError(
            `Drive folder ${input.folderId} contains an item the actor cannot purge.`,
          );
        }
        return row.file_ids;
      },
    );

    for (const objectId of fileIds) {
      await this.delete({ ...input, objectId });
    }

    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        await requireFolderRoleIncludingDeleted(
          tx,
          input.orgId,
          input.actorId,
          input.folderId,
          "owner",
        );
        await tx`
          with recursive folder_tree as (
            select id from drive_folders
            where id = ${input.folderId} and org_id = ${input.orgId}
              and metadata->>'purgeRootFolderId' = ${input.folderId}
            union all
            select child.id from drive_folders child
            join folder_tree parent on child.parent_folder_id = parent.id
            where child.org_id = ${input.orgId}
              and child.metadata->>'purgeRootFolderId' = ${input.folderId}
          )
          delete from permissions
          where org_id = ${input.orgId}
            and resource_type = 'drive_folder'
            and resource_id in (select id from folder_tree)
        `;
        const deleted = await tx`
          with recursive folder_tree as (
            select id from drive_folders
            where id = ${input.folderId} and org_id = ${input.orgId}
              and metadata->>'purgeRootFolderId' = ${input.folderId}
            union all
            select child.id from drive_folders child
            join folder_tree parent on child.parent_folder_id = parent.id
            where child.org_id = ${input.orgId}
              and child.metadata->>'purgeRootFolderId' = ${input.folderId}
          )
          delete from drive_folders
          where id in (select id from folder_tree)
        `;
        if (deleted.count > 0) {
          await appendDriveActivity(tx, {
            orgId: input.orgId,
            actorId: input.actorId,
            verb: "drive.folder.deleted",
            objectId: input.folderId,
            payload: { recursive: true },
          });
        }
        return deleted.count > 0;
      },
    );
  }

  async readFile(input: DriveFileReadInput): Promise<DriveFileReadResult | null> {
    const opened = await this.openFile(input);
    if (opened === null) return null;
    const content = await opened
      .open()
      .then(async (body) => (body === null ? null : toUint8Array(body)));
    const previewContent = await opened.preview
      ?.open()
      .then(async (body) => (body === null ? null : toUint8Array(body)));
    return {
      entry: opened.entry,
      content,
      previewContent: previewContent ?? null,
    };
  }

  async canExportFile(input: DriveFileReadInput): Promise<boolean> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        await requireObjectAccess(tx, input.orgId, input.actorId, input.objectId);
        const rows = await tx<{ readonly export_allowed: boolean }[]>`
          select coalesce((
            select export_allowed from meet_recording_governance
            where org_id = ${input.orgId} and object_id = ${input.objectId}
          ), true) as export_allowed
        `;
        return rows[0]?.export_allowed === true;
      },
    );
  }

  async openFile(input: DriveFileReadInput): Promise<DriveFileStreamResult | null> {
    const startedAt = Date.now();
    try {
      const object = await withTenantPostgresContext(
        this.sql,
        { orgId: input.orgId, actorId: input.actorId },
        async (tx) => {
          const accessible = await requireObjectAccess(
            tx,
            input.orgId,
            input.actorId,
            input.objectId,
          );
          if (accessible.deleted_at !== null || !isDriveObjectReady(accessible)) return null;
          const versions = await tx<{ readonly version_number: number }[]>`
          select version_number
          from drive_versions
          where org_id = ${input.orgId} and object_id = ${input.objectId}
          order by version_number desc
          limit 1
        `;
          return { ...accessible, version_number: versions[0]?.version_number ?? null };
        },
      );
      const opened = object === null ? null : await this.openStoredObject(input.orgId, object);
      this.options.metrics?.recordOperationalEvent({
        capability: "drive",
        operation: "download",
        status: opened === null ? "blocked" : "success",
        durationSeconds: (Date.now() - startedAt) / 1_000,
      });
      if (opened !== null) {
        this.options.metrics?.addOperationalUnits({
          capability: "drive",
          measure: "downloaded_bytes",
          value: opened.byteSize,
        });
      }
      return opened;
    } catch (error) {
      this.options.metrics?.recordOperationalEvent({
        capability: "drive",
        operation: "download",
        status: "error",
        durationSeconds: (Date.now() - startedAt) / 1_000,
      });
      throw error;
    }
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
      const object = await requireObjectRole(
        tx,
        input.orgId,
        input.actorId,
        input.objectId,
        "owner",
      );
      assertDriveObjectReady(object);
      const role = parseDriveRole(input.role);
      const sharedWithActorIds = [...new Set(input.targetActorIds)];
      for (const targetActorId of sharedWithActorIds) {
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
    await requireReadyObjectAccess(this.sql, input.orgId, input.actorId, input.objectId);
    const rows = await this.sql<DriveAccessGrantRow[]>`
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
        and o.deleted_at is null
      left join actors a on a.id = p.actor_id and a.org_id = p.org_id
      where p.org_id = ${input.orgId}
        and p.resource_type = 'object'
        and p.resource_id = ${input.objectId}
        and p.actor_id <> o.owner_actor_id
        and (p.expires_at is null or p.expires_at > now())
      order by p.actor_id, p.updated_at desc, p.created_at desc
    `;
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
      const rows = await tx<{ readonly removed_count: number | string }[]>`
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
            and (o.owner_actor_id is null or p.actor_id <> o.owner_actor_id)
            and p.source_group_grant_id is null
            and (
              ${input.targetActorId === input.actorId}
              or helix_drive_effective_role(
                ${input.orgId}, ${input.actorId}, 'object', o.id
              ) = 'owner'
            )
          returning p.actor_id
        )
        select count(*)::int as removed_count from deleted
      `;
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
      const object = await requireObjectRole(
        tx,
        input.orgId,
        input.actorId,
        input.objectId,
        "owner",
      );
      assertDriveObjectReady(object);
      const role = parseDriveRole(input.role);
      const rows = await tx<DriveAccessGrantRow[]>`
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
            and (o.owner_actor_id is null or p.actor_id <> o.owner_actor_id)
            and p.source_group_grant_id is null
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
      `;
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
    return this.sql.begin(async (tx) => {
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

  async moveFolder(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly folderId: string;
    readonly parentFolderId?: string | null;
  }): Promise<DriveEntryRecord | null> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        await tx`select helix_drive_move_folder(
          ${input.orgId}, ${input.actorId}, ${input.folderId}, ${input.parentFolderId ?? null}
        )`;
        const rows = await tx<DriveFolderRow[]>`
          select * from drive_folders where org_id = ${input.orgId} and id = ${input.folderId}
        `;
        const row = rows[0];
        if (row === undefined) return null;
        await appendDriveActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "drive.folder.moved",
          objectId: input.folderId,
          payload: { parentFolderId: input.parentFolderId ?? null },
        });
        return mapFolderEntry(row);
      },
    );
  }

  async setStarred(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly starred: boolean;
  }): Promise<DriveEntryRecord | null> {
    return withTenantPostgresContext(
      this.sql,
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

  async getDocumentSurfaceView(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<DriveDocumentSurfaceView> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        const rows = await tx<{ readonly view: DriveDocumentSurfaceView }[]>`
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

  async setDocumentSurfaceView(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly view: DriveDocumentSurfaceView;
  }): Promise<DriveDocumentSurfaceView> {
    return withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        const rows = await tx<{ readonly view: DriveDocumentSurfaceView }[]>`
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

  async rename(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly name: string;
  }): Promise<DriveEntryRecord | null> {
    return this.sql.begin(async (tx) => {
      await requireReadyObjectRole(tx, input.orgId, input.actorId, input.objectId, "editor");
      const name = input.name.trim();
      if (name.length === 0) {
        throw new BadRequestError("Drive rename requires a non-empty name.");
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
      }
      return rows[0] === undefined ? null : mapObjectEntry(rows[0]);
    });
  }

  async listVersions(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<readonly DriveVersionRecord[]> {
    await requireReadyObjectRole(this.sql, input.orgId, input.actorId, input.objectId, "reader");
    const rows = await this.sql<DriveVersionRow[]>`
      select *
      from drive_versions
      where org_id = ${input.orgId}
        and object_id = ${input.objectId}
      order by version_number desc
    `;
    return rows.map((row) => mapVersion(row));
  }

  async revertToVersion(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly versionNumber: number;
    readonly idempotencyKey?: string;
  }): Promise<DriveVersionRecord> {
    const version = await withTenantPostgresContext(
      this.sql,
      { orgId: input.orgId, actorId: input.actorId },
      async (tx) => {
        const current = await requireReadyObjectRole(
          tx,
          input.orgId,
          input.actorId,
          input.objectId,
          "editor",
        );
        await tx`
        select id from objects
        where org_id = ${input.orgId} and id = ${input.objectId}
        for update
      `;
        if (input.idempotencyKey !== undefined) {
          const replay = await tx<DriveVersionRow[]>`
          select * from drive_versions
          where org_id = ${input.orgId} and object_id = ${input.objectId}
            and idempotency_key = ${input.idempotencyKey}
          limit 1
        `;
          if (replay[0] !== undefined) return mapVersion(replay[0]);
        }
        const targetRows = await tx<DriveVersionRow[]>`
        select *
        from drive_versions
        where org_id = ${input.orgId}
          and object_id = ${input.objectId}
          and version_number = ${input.versionNumber}
        limit 1
      `;
        const target = targetRows[0];
        if (target === undefined) {
          throw new DriveNotFoundError(
            `Unknown Drive version ${String(input.versionNumber)} for object ${input.objectId}.`,
          );
        }
        const requiresPreviewJob = isOfficePreviewCandidate(
          target.mime_type,
          stringMetadata(current.metadata, "name") ?? "",
        );
        const pendingPreview = {
          kind: "office",
          status: "pending",
          mimeType: target.mime_type,
          blocker: "Preview regeneration is queued.",
        };
        const maxRows = await tx<{ readonly max_version: number }[]>`
        select coalesce(max(version_number), 0)::int as max_version
        from drive_versions
        where org_id = ${input.orgId}
          and object_id = ${input.objectId}
      `;
        const nextVersion = (maxRows[0]?.max_version ?? 0) + 1;
        const inserted = await tx<DriveVersionRow[]>`
        insert into drive_versions (
          org_id, object_id, version_number, storage_key, mime_type, byte_size, sha256, metadata,
          created_by_actor_id, idempotency_key
        )
        values (
          ${input.orgId},
          ${input.objectId},
          ${nextVersion},
          ${target.storage_key},
          ${target.mime_type},
          ${target.byte_size},
          ${target.sha256},
          ${tx.json(
            toSqlJson({
              ...target.metadata,
              revertedFromVersion: input.versionNumber,
              ...(requiresPreviewJob ? { preview: pendingPreview } : {}),
            }),
          )},
          ${input.actorId}, ${input.idempotencyKey ?? null}
        )
        returning *
      `;
        const insertedVersion = inserted[0];
        if (insertedVersion === undefined) throw new Error("Failed to create Drive version.");
        await tx`
        update objects
        set storage_key = ${target.storage_key},
            mime_type = ${target.mime_type},
            byte_size = ${target.byte_size},
            sha256 = ${target.sha256},
            metadata = (metadata - 'preview' - 'previewUrl' - 'previewText') || ${tx.json(
              toSqlJson({
                status: "ready",
                versionNumber: nextVersion,
                latestVersionId: insertedVersion.id,
                ...(requiresPreviewJob
                  ? { preview: pendingPreview }
                  : { preview: target.metadata.preview ?? null }),
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
        if (requiresPreviewJob) {
          await tx`
          insert into drive_preview_jobs (org_id, object_id, version_id, actor_id)
          values (${input.orgId}, ${input.objectId}, ${insertedVersion.id}, ${input.actorId})
          on conflict (org_id, version_id) do nothing
        `;
        }
        if (isDriveBlobStorageKey(target.storage_key)) {
          await upsertDriveBlobRef(tx, {
            orgId: input.orgId,
            sha256: target.sha256,
            storageKey: target.storage_key,
            byteSize: bytesFromDatabase(target.byte_size),
          });
        }
        return mapVersion(insertedVersion);
      },
    );
    await this.runPreviewJobForVersion(input.orgId, version.id).catch(() => undefined);
    return version;
  }

  async createShareLink(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly password?: string | undefined;
    readonly expiresAt?: Date | null;
    readonly oneTime?: boolean | undefined;
    readonly allowedDomains?: readonly string[] | undefined;
    readonly allowDownload?: boolean | undefined;
  }): Promise<DriveShareLinkRecord> {
    const passwordHash =
      input.password === undefined ? null : await hashSecret(requireSharePassword(input.password));
    const allowedDomains = normalizeShareDomains(input.allowedDomains ?? []);
    return this.sql.begin(async (tx) => {
      const object = await requireObjectRole(
        tx,
        input.orgId,
        input.actorId,
        input.objectId,
        "owner",
      );
      assertDriveObjectReady(object);
      const classification = await assertDriveSharePolicy(tx, object, allowedDomains);
      if (
        input.expiresAt !== undefined &&
        input.expiresAt !== null &&
        input.expiresAt <= new Date()
      ) {
        throw new DriveConflictError("Share-link expiry must be in the future.");
      }
      const token = randomBytes(32).toString("base64url");
      const tokenHash = sha256Hex(token);
      const rows = await tx<DriveShareLinkRow[]>`
        insert into drive_share_links (
          org_id, token_hash, object_id, role, password_hash, expires_at, one_time,
          allowed_domains, allow_download, classification, created_by_actor_id
        )
        values (
          ${input.orgId},
          ${tokenHash},
          ${input.objectId},
          'reader',
          ${passwordHash},
          ${input.expiresAt ?? null},
          ${input.oneTime ?? false},
          ${allowedDomains},
          ${input.allowDownload ?? true},
          ${classification},
          ${input.actorId}
        )
        returning *
      `;
      const row = rows[0];
      if (row === undefined) {
        throw new DriveConflictError("Expected drive_share_links row.");
      }
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.link.created",
        objectId: input.objectId,
        payload: {
          linkId: row.id,
          role: "reader",
          passwordProtected: passwordHash !== null,
          oneTime: input.oneTime ?? false,
          allowedDomains,
          allowDownload: input.allowDownload ?? true,
          classification,
        },
      });
      await appendDriveShareLinkEvent(tx, row, "create", "allowed", input.actorId, null, {});
      return mapShareLink(row, token);
    });
  }

  async listShareLinks(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<readonly DriveShareLinkRecord[]> {
    await requireReadyObjectRole(this.sql, input.orgId, input.actorId, input.objectId, "owner");
    const rows = await this.sql<DriveShareLinkRow[]>`
      select *
      from drive_share_links
      where org_id = ${input.orgId}
        and object_id = ${input.objectId}
        and revoked_at is null
      order by created_at desc
    `;
    return rows.map((row) => mapShareLink(row));
  }

  async revokeShareLink(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly linkId: string;
  }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const existing = await tx<DriveShareLinkRow[]>`
        select *
        from drive_share_links
        where id = ${input.linkId}
          and org_id = ${input.orgId}
        limit 1
      `;
      const link = existing[0];
      if (link === undefined) {
        return false;
      }
      await requireObjectRole(tx, input.orgId, input.actorId, link.object_id, "owner");
      const rows = await tx<DriveShareLinkRow[]>`
        update drive_share_links
        set revoked_at = now()
        where id = ${input.linkId}
          and org_id = ${input.orgId}
          and revoked_at is null
        returning *
      `;
      const revoked = rows[0];
      if (revoked === undefined) return false;
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.link.revoked",
        objectId: link.object_id,
        payload: { linkId: link.id },
      });
      await appendDriveShareLinkEvent(tx, revoked, "revoke", "allowed", input.actorId, null, {});
      return true;
    });
  }

  async resolveShareLink(input: DriveShareAccessInput): Promise<{
    readonly orgId: string;
    readonly objectId: string;
    readonly linkId: string;
  } | null> {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(input.token) || !/^[a-f0-9]{64}$/u.test(input.clientKey)) {
      return null;
    }
    await consumeDriveShareRateLimit(this.sql, sha256Hex(`ip:${input.clientKey}`), 120);
    const tokenHash = sha256Hex(input.token);
    await consumeDriveShareRateLimit(this.sql, sha256Hex(`token:${tokenHash}`), 60);
    const linkRows = await this.sql<DriveShareLinkRow[]>`
      select * from helix_drive_share_link_by_token_hash(${tokenHash})
    `;
    const link = linkRows[0];
    if (link === undefined) return null;
    const row = await withTenantPostgresContext(this.sql, { orgId: link.org_id }, async (tx) => {
      const objects = await tx<ObjectRow[]>`
        select * from objects
        where id = ${link.object_id} and org_id = ${link.org_id}
        limit 1
      `;
      const object = objects[0];
      if (object === undefined) return null;
      return {
        ...link,
        ...object,
        link_id: link.id,
        link_org_id: link.org_id,
        link_object_id: link.object_id,
        link_created_at: link.created_at,
        link_classification: link.classification,
      } satisfies DriveShareLinkAccessRow;
    });
    if (row === null) return null;
    const denied = await driveShareDenialReason(this.sql, row, input);
    if (denied !== null) {
      await appendDriveShareLinkEvent(
        this.sql,
        shareLinkRow(row),
        input.download === true ? "download" : "access",
        "denied",
        shareActorId(row, input.actor),
        input.clientKey,
        { reason: denied },
      );
      return null;
    }
    return { orgId: row.link_org_id, objectId: row.link_object_id, linkId: row.link_id };
  }

  async openFileByShareToken(input: DriveShareAccessInput): Promise<DriveFileStreamResult | null> {
    const resolved = await this.resolveShareLink(input);
    if (resolved === null) {
      return null;
    }
    const object = await withTenantPostgresContext(
      this.sql,
      { orgId: resolved.orgId },
      async (tx) => {
        const rows = await tx<ObjectRow[]>`
          select *
          from objects
          where id = ${resolved.objectId}
            and org_id = ${resolved.orgId}
            and kind in ('file', 'recording')
            and deleted_at is null
            and coalesce(metadata->>'status', 'ready') = 'ready'
          limit 1
        `;
        const found = rows[0];
        if (found === undefined) return undefined;
        const versions = await tx<{ readonly version_number: number }[]>`
          select version_number
          from drive_versions
          where org_id = ${resolved.orgId} and object_id = ${resolved.objectId}
          order by version_number desc
          limit 1
        `;
        return { ...found, version_number: versions[0]?.version_number ?? null };
      },
    );
    if (object === undefined) {
      return null;
    }
    const storage = await this.storageForOrg(resolved.orgId);
    const head = await storage?.head?.(object.storage_key);
    const expectedBytes = bytesFromDatabase(object.byte_size);
    const storedSha256 = head?.metadata?.sha256;
    if (
      head === null ||
      head === undefined ||
      head.byteSize !== expectedBytes ||
      (storedSha256 !== undefined && object.sha256 !== null && storedSha256 !== object.sha256)
    ) {
      const rows = await this.sql<DriveShareLinkRow[]>`
        select * from helix_drive_share_link_by_token_hash(${sha256Hex(input.token)})
      `;
      if (rows[0] !== undefined) {
        await appendDriveShareLinkEvent(
          this.sql,
          rows[0],
          input.download === true ? "download" : "access",
          "integrity_error",
          shareActorId(rows[0], input.actor),
          input.clientKey,
          { expectedBytes, actualBytes: head?.byteSize ?? null },
        );
      }
      return {
        orgId: resolved.orgId,
        entry: mapObjectEntry(object),
        byteSize: expectedBytes,
        etag: driveContentEtag(object.sha256, object.id, object.version_number),
        open: async () => null,
      };
    }
    const consumed = await withTenantPostgresContext(
      this.sql,
      { orgId: resolved.orgId },
      async (tx) =>
        await tx<DriveShareLinkRow[]>`
          update drive_share_links link
          set consumed_at = case when link.one_time then statement_timestamp() else link.consumed_at end,
              access_count = link.access_count + 1,
              last_access_at = statement_timestamp()
          where link.id = ${resolved.linkId}
            and link.org_id = ${resolved.orgId}
            and link.revoked_at is null
            and (link.expires_at is null or link.expires_at > statement_timestamp())
            and (not link.one_time or link.consumed_at is null)
          returning *
        `,
    );
    const link = consumed[0];
    if (link === undefined) return null;
    await appendDriveShareLinkEvent(
      this.sql,
      link,
      input.download === true ? "download" : "access",
      "allowed",
      shareActorId(link, input.actor),
      input.clientKey,
      {},
    );
    return this.openStoredObject(resolved.orgId, object);
  }

  async trash(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<DriveEntryRecord | null> {
    try {
      return await withTenantPostgresContext(
        this.sql,
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
        },
      );
    } catch (error) {
      if (!(error instanceof DriveNotFoundError)) throw error;
      return this.trashFolder({
        orgId: input.orgId,
        actorId: input.actorId,
        folderId: input.objectId,
      });
    }
  }

  async restore(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
  }): Promise<DriveEntryRecord | null> {
    try {
      return await this.updateFileFolder({
        ...input,
        verb: "drive.object.restored",
        restore: true,
      });
    } catch (error) {
      if (!(error instanceof DriveNotFoundError)) throw error;
      return this.restoreFolder({
        orgId: input.orgId,
        actorId: input.actorId,
        folderId: input.objectId,
      });
    }
  }

  async delete(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<boolean> {
    try {
      const hasStorage = (await this.storageForOrg(input.orgId)) !== undefined;
      const result = await withTenantPostgresContext(
        this.sql,
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
          // syncTargetDeletedAt no-ops when the object has no linked app, so it is
          // called unconditionally here — matching the trash and restore paths.
          await syncTargetDeletedAt(tx, input.orgId, input.objectId, "purge", this.trashSync);
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
                this.options.contentAddressedDedup === true &&
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
        await this.deleteQuarantinedBytes(deletion);
      }
      return result.deleted;
    } catch (error) {
      if (!(error instanceof DriveNotFoundError)) throw error;
      return this.deleteFolder({
        orgId: input.orgId,
        actorId: input.actorId,
        folderId: input.objectId,
      });
    }
  }

  async search(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string;
    readonly folderId?: string | null;
    readonly limit?: number;
  }): Promise<readonly DriveSearchHit[]> {
    const query = input.query ?? "";
    const rows = await this.sql<DriveSearchRow[]>`
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
      const object = await requireReadyDriveCommentObject(
        tx,
        input.orgId,
        input.actorId,
        input.objectId,
        1,
      );
      if (input.parentCommentId !== undefined) {
        await requireDriveCommentParent(tx, {
          orgId: input.orgId,
          objectId: input.objectId,
          parentCommentId: input.parentCommentId,
        });
      }
      const rows = await tx<DriveCommentRow[]>`
        insert into drive_comments
          (org_id, object_id, parent_comment_id, actor_id, anchor, body, metadata,
           changed_by_actor_id)
        values (
          ${input.orgId},
          ${input.objectId},
          ${input.parentCommentId ?? null},
          ${input.actorId},
          ${tx.json(toSqlJson(input.anchor ?? {}))},
          ${input.body},
          ${tx.json(toSqlJson(input.metadata ?? {}))},
          ${input.actorId}
        )
        returning *
      `;
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
      await notifyDriveCommentReply(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        object,
        commentId: comment.id,
        parentCommentId: comment.parentCommentId,
        body: comment.body,
      });
      return comment;
    });
  }

  async listComments(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly status?: string | undefined;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<DriveCommentPage> {
    await requireReadyDriveCommentObject(this.sql, input.orgId, input.actorId, input.objectId, 0);
    const cursor = decodeDriveCommentCursor(input.cursor);
    const limit = boundedDriveCommentLimit(input.limit);
    const rows = await this.sql<DriveCommentProjectionRow[]>`
      select
        c.*,
        a.display_name as actor_display_name,
        a.email as actor_email
      from drive_comments c
      left join actors a on a.id = c.actor_id and a.org_id = c.org_id
      where c.org_id = ${input.orgId}
        and c.object_id = ${input.objectId}
        and c.deleted_at is null
        ${
          input.status === undefined || input.status === "all"
            ? this.sql``
            : this.sql`and c.status = ${input.status}`
        }
        ${
          cursor === undefined
            ? this.sql``
            : this.sql`and (c.created_at, c.id) > (
                select anchor.created_at, anchor.id
                from drive_comments anchor
                where anchor.org_id = ${input.orgId}
                  and anchor.object_id = ${input.objectId}
                  and anchor.id = ${cursor.id}
              )`
        }
      order by c.created_at asc, c.id asc
      limit ${limit + 1}
    `;
    const comments = rows.slice(0, limit).map(mapDriveCommentListItem);
    const last = comments.at(-1);
    return {
      comments,
      nextCursor:
        rows.length > limit && last !== undefined ? encodeDriveCommentCursor(last.id) : null,
    };
  }

  async listCommentRevisions(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<DriveCommentRevisionPage> {
    return this.sql.begin(async (tx) => {
      await requireReadyDriveCommentObject(tx, input.orgId, input.actorId, input.objectId, 2);
      const cursor = decodeDriveCommentCursor(input.cursor);
      const limit = boundedDriveCommentLimit(input.limit);
      const rows = await tx<DriveCommentRevisionRow[]>`
        select *
        from drive_comment_revisions
        where org_id = ${input.orgId}
          and object_id = ${input.objectId}
          ${
            cursor === undefined
              ? tx``
              : tx`and (captured_at, id) > (
                  select anchor.captured_at, anchor.id
                  from drive_comment_revisions anchor
                  where anchor.org_id = ${input.orgId}
                    and anchor.object_id = ${input.objectId}
                    and anchor.id = ${cursor.id}
                )`
          }
        order by captured_at asc, id asc
        limit ${limit + 1}
      `;
      const revisions = rows.slice(0, limit).map(mapDriveCommentRevision);
      const last = revisions.at(-1);
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.comment.evidence.exported",
        objectId: input.objectId,
        payload: { returned: revisions.length },
      });
      return {
        revisions,
        nextCursor:
          rows.length > limit && last !== undefined ? encodeDriveCommentCursor(last.id) : null,
      };
    });
  }

  async resolveComment(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly commentId: string;
  }): Promise<DriveCommentRecord | null> {
    return this.sql.begin(async (tx) => {
      const existingRows = await tx<DriveCommentRow[]>`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        limit 1
      `;
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireDriveCommentMutation(tx, input.orgId, input.actorId, existing, "resolve");
      if (existing.status === "resolved") {
        return mapDriveComment(existing);
      }
      const rows = await tx<DriveCommentRow[]>`
        update drive_comments
        set status = 'resolved', resolved_at = now(), resolved_by_actor_id = ${input.actorId},
            changed_by_actor_id = ${input.actorId}, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        returning *
      `;
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
      const existingRows = await tx<DriveCommentRow[]>`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        limit 1
      `;
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireDriveCommentMutation(tx, input.orgId, input.actorId, existing, "resolve");
      if (existing.status === "open") {
        return mapDriveComment(existing);
      }
      const rows = await tx<DriveCommentRow[]>`
        update drive_comments
        set status = 'open', resolved_at = null, resolved_by_actor_id = null,
            changed_by_actor_id = ${input.actorId}, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        returning *
      `;
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
      const existingRows = await tx<DriveCommentRow[]>`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        limit 1
      `;
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      const object = await requireDriveCommentMutation(
        tx,
        input.orgId,
        input.actorId,
        existing,
        "author",
      );
      if (existing.body === input.body) {
        return mapDriveComment(existing);
      }
      const rows = await tx<DriveCommentRow[]>`
        update drive_comments
        set body = ${input.body}, changed_by_actor_id = ${input.actorId}, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        returning *
      `;
      const comment = mapDriveComment(rows[0]);
      await appendDriveActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "drive.comment.updated",
        objectId: comment.objectId,
        payload: { commentId: comment.id },
      });
      const oldTokens = new Set(mentionTokensForComment(existing.metadata, existing.body));
      const addedTokens = mentionTokensForComment(existing.metadata, input.body).filter(
        (token) => !oldTokens.has(token),
      );
      await notifyDriveCommentMentions(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        object,
        commentId: comment.id,
        parentCommentId: comment.parentCommentId,
        anchor: comment.anchor,
        body: comment.body,
        metadata: comment.metadata,
        tokens: addedTokens,
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
      const existingRows = await tx<DriveCommentRow[]>`
        select *
        from drive_comments
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        limit 1
      `;
      const existing = existingRows[0];
      if (existing === undefined) {
        return null;
      }
      await requireDriveCommentMutation(tx, input.orgId, input.actorId, existing, "author");
      const rows = await tx<DriveCommentRow[]>`
        update drive_comments
        set deleted_at = now(), deleted_by_actor_id = ${input.actorId},
            changed_by_actor_id = ${input.actorId}, updated_at = now()
        where id = ${input.commentId}
          and org_id = ${input.orgId}
          and deleted_at is null
        returning *
      `;
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
    await requireReadyObjectAccess(this.sql, input.orgId, input.actorId, input.objectId);
    const rows = await this.sql<DrivePdfFormStateRow[]>`
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
    `;
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
      const object = await requireReadyObjectAccess(tx, input.orgId, input.actorId, input.objectId);
      const source = await pdfFormSourceMetadata(tx, object);
      const rows = await tx<DrivePdfFormStateRow[]>`
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
      `;
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
      await requireReadyObjectAccess(tx, input.orgId, input.actorId, input.objectId);
      const rows = await tx<{ readonly object_id: string }[]>`
        delete from drive_pdf_form_states
        where org_id = ${input.orgId}
          and object_id = ${input.objectId}
          and actor_id = ${input.actorId}
        returning object_id
      `;
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
    const rows = await this.sql<DriveSearchProjectionRow[]>`
      with recursive target as (
        select *
        from objects
        where id = ${fileId}
          and kind = 'file'
          and deleted_at is null
          and coalesce(metadata->>'status', 'ready') = 'ready'
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
        ) as folder_path,
        helix_drive_visible_actor_ids(t.org_id, 'object', t.id)::text[] as allowed_actor_ids
      from target t
      left join actors a on a.id = t.owner_actor_id and a.org_id = t.org_id
    `;
    return rows[0] === undefined ? null : mapDriveSearchRecord(rows[0]);
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
        and deleted_at is null
        and coalesce(metadata->>'status', 'ready') = 'ready'
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
        and deleted_at is null
        and coalesce(metadata->>'status', 'ready') = 'ready'
    `;
  }

  private async deleteQuarantinedBytes(deletion: DriveQuarantineDeletionRow): Promise<boolean> {
    if (deletion.status === "completed") return true;
    const deletionStatus = deletion.status;
    try {
      const storage = await this.storageForOrg(deletion.org_id);
      if (storage === undefined) {
        throw new Error("Drive upload content storage is not configured.");
      }
      const retained =
        isDriveBlobStorageKey(deletion.storage_key) &&
        (await withTenantPostgresContext(this.sql, { orgId: deletion.org_id }, (tx) =>
          driveBlobStorageIsReferenced(tx, deletion.org_id, deletion.storage_key),
        ));
      if (!retained) await storage.delete(deletion.storage_key);
      await withTenantPostgresContext(this.sql, { orgId: deletion.org_id }, async (tx) => {
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
      let released: DriveQuarantineDeletionRow | null = null;
      try {
        released = await withTenantPostgresContext(this.sql, { orgId: deletion.org_id }, (tx) =>
          releaseDriveQuarantineDeletion(tx, {
            id: deletion.id,
            orgId: deletion.org_id,
            status: deletionStatus,
            error: errorMessage,
            retryDelayMs: this.options.virusScanRetryDelayMs ?? DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS,
          }),
        );
      } catch (persistError) {
        this.emitQuarantineDeleteError({
          orgId: deletion.org_id,
          objectId: deletion.object_id,
          storageKey: deletion.storage_key,
          attempts: deletion.attempt_count + 1,
          error: `${errorMessage}; cleanup state update failed: ${virusScanErrorMessage(persistError)}`,
        });
        return false;
      }
      this.emitQuarantineDeleteError({
        orgId: deletion.org_id,
        objectId: deletion.object_id,
        storageKey: deletion.storage_key,
        attempts: released?.attempt_count ?? deletion.attempt_count + 1,
        error: errorMessage,
      });
      return false;
    }
  }

  private async discardOrphanedQuarantineCopy(orphan: DriveQuarantineDeletionRow): Promise<void> {
    const storage = await this.storageForOrg(orphan.org_id);
    try {
      if (storage === undefined) throw new Error("Drive upload content storage is not configured.");
      await storage.delete(orphan.storage_key);
    } catch (error) {
      const errorMessage = virusScanErrorMessage(error);
      try {
        await withTenantPostgresContext(this.sql, { orgId: orphan.org_id }, (tx) =>
          insertDriveQuarantineDeletion(tx, {
            orgId: orphan.org_id,
            objectId: orphan.object_id,
            actorId: orphan.actor_id,
            storageKey: orphan.storage_key,
            error: errorMessage,
          }),
        );
        this.emitQuarantineDeleteError({
          orgId: orphan.org_id,
          objectId: orphan.object_id,
          storageKey: orphan.storage_key,
          attempts: 1,
          error: errorMessage,
        });
      } catch (persistError) {
        this.emitQuarantineDeleteError({
          orgId: orphan.org_id,
          objectId: orphan.object_id,
          storageKey: orphan.storage_key,
          attempts: 1,
          error: `${errorMessage}; cleanup state insert failed: ${virusScanErrorMessage(persistError)}`,
        });
      }
    }
  }

  private emitQuarantineDeleteError(event: DriveQuarantineDeleteErrorEvent): void {
    try {
      this.options.onQuarantineDeleteError?.(event);
    } catch {
      // Reporting must never roll back or release quarantined content.
    }
  }

  private async discardPreparedUpload(
    orgId: string,
    actorId: string,
    objectId: string,
  ): Promise<void> {
    await withTenantPostgresContext(this.sql, { orgId }, async (tx) => {
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

  private async compensatePreparedMultipart(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly storage: DriveStorageClient | undefined;
    readonly storageKey: string;
    readonly uploadId: string | undefined;
    readonly error: unknown;
  }): Promise<void> {
    if (input.uploadId === undefined) {
      await this.discardPreparedUpload(input.orgId, input.actorId, input.objectId);
      return;
    }
    try {
      if (input.storage?.abortMultipartUpload === undefined) {
        throw new Error("Multipart abort is not configured.");
      }
      await input.storage.abortMultipartUpload(input.storageKey, input.uploadId);
      await this.discardPreparedUpload(input.orgId, input.actorId, input.objectId);
    } catch (abortError) {
      await withTenantPostgresContext(this.sql, { orgId: input.orgId }, (tx) =>
        scheduleDriveMultipartAbort(tx, {
          orgId: input.orgId,
          objectId: input.objectId,
          uploadId: input.uploadId as string,
          error: `${virusScanErrorMessage(input.error)}; abort: ${virusScanErrorMessage(abortError)}`,
        }),
      );
    }
  }

  private async releaseMultipartCompletion(
    session: DriveMultipartSessionRow,
    error: string,
  ): Promise<void> {
    await withTenantPostgresContext(this.sql, { orgId: session.org_id }, (tx) =>
      releaseDriveMultipartCompletion(tx, session, error),
    );
  }

  private async abortExpiredMultipart(session: DriveMultipartSweepRow): Promise<boolean> {
    try {
      const storage = await this.storageForOrg(session.org_id);
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
      await withTenantPostgresContext(this.sql, { orgId: session.org_id }, async (tx) => {
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
      await withTenantPostgresContext(this.sql, { orgId: session.org_id }, (tx) =>
        releaseDriveMultipartAbort(
          tx,
          session,
          virusScanErrorMessage(error),
          this.options.virusScanRetryDelayMs ?? DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS,
        ),
      ).catch(() => undefined);
      return false;
    }
  }

  private async deleteExpiredPreparedUpload(object: DrivePreparedUploadSweepRow): Promise<boolean> {
    try {
      const storage = await this.storageForOrg(object.org_id);
      await storage?.delete(object.storage_key).catch((error: unknown) => {
        if (!isMissingStorageObject(error)) throw error;
      });
      await withTenantPostgresContext(this.sql, { orgId: object.org_id }, async (tx) => {
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
      await withTenantPostgresContext(this.sql, { orgId: object.org_id }, (tx) =>
        releaseExpiredPreparedUpload(
          tx,
          object,
          virusScanErrorMessage(error),
          this.options.virusScanRetryDelayMs ?? DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS,
        ),
      ).catch(() => undefined);
      return false;
    }
  }

  private async storageForOrg(orgId: string): Promise<DriveStorageClient | undefined> {
    if (this.options.storageResolver === undefined) return this.storage;
    return (await this.options.storageResolver({ orgId }))?.client;
  }

  private async runPreviewJobForVersion(orgId: string, versionId: string): Promise<boolean> {
    const claims = await withTenantPostgresContext(this.sql, { orgId }, (tx) =>
      claimDrivePreviewJobs(tx, {
        limit: 1,
        leaseExpiresAt: new Date(Date.now() + DEFAULT_UPLOAD_LEASE_MS),
        now: new Date(),
        versionId,
      }),
    );
    return claims[0] === undefined ? true : this.processDrivePreviewJob(claims[0]);
  }

  private async processDrivePreviewJob(job: DrivePreviewJobRow): Promise<boolean> {
    let writtenStorageKey: string | undefined;
    try {
      const preview = await this.generatePreview({
        orgId: job.org_id,
        objectId: job.object_id,
        name: stringMetadata(job.object_metadata, "name") ?? job.storage_key,
        storageKey: job.storage_key,
        mimeType: job.mime_type,
        versionNumber: job.version_number,
        byteSize: bytesFromDatabase(job.byte_size),
      });
      writtenStorageKey = preview.writtenStorageKey;
      await withTenantPostgresContext(this.sql, { orgId: job.org_id }, async (tx) => {
        const updated = await completeDrivePreviewJob(tx, job, preview.metadata);
        if (!updated) throw new Error("Drive preview job lease was lost.");
      });
      return true;
    } catch (error) {
      if (writtenStorageKey !== undefined) {
        await this.discardOrphanedQuarantineCopy({
          id: "",
          org_id: job.org_id,
          object_id: job.object_id,
          actor_id: job.actor_id,
          storage_key: writtenStorageKey,
          status: "pending",
          attempt_count: 0,
          next_attempt_at: new Date(),
        });
      }
      await withTenantPostgresContext(this.sql, { orgId: job.org_id }, (tx) =>
        releaseDrivePreviewJob(
          tx,
          job,
          virusScanErrorMessage(error),
          this.options.virusScanRetryDelayMs ?? DEFAULT_VIRUS_SCAN_RETRY_DELAY_MS,
        ),
      ).catch(() => undefined);
      return false;
    }
  }

  private async openStoredObject(
    orgId: string,
    object: ObjectRow & { readonly version_number: number | null },
  ): Promise<DriveFileStreamResult> {
    const storage = await this.storageForOrg(orgId);
    const entry = mapObjectEntry(object);
    const readStorage =
      (key: string) => async (range?: { readonly start: number; readonly end: number }) => {
        if (storage === undefined) return null;
        if (range !== undefined && storage.getRange !== undefined) {
          return (await storage.getRange(key, range.start, range.end))?.body ?? null;
        }
        const stored =
          storage.getStream === undefined ? await storage.get(key) : await storage.getStream(key);
        if (stored === null) return null;
        return range === undefined ? stored.body : sliceStorageBody(stored.body, range);
      };
    const previewKey =
      entry.preview?.kind === "pdf" && entry.preview.status === "available"
        ? entry.preview.storageKey
        : undefined;
    const previewHead =
      previewKey === undefined || storage?.head === undefined
        ? null
        : await storage.head(previewKey).catch(() => null);
    return {
      orgId,
      entry,
      byteSize: bytesFromDatabase(object.byte_size),
      etag: driveContentEtag(object.sha256, object.id, object.version_number),
      open: readStorage(object.storage_key),
      ...(previewKey === undefined || previewHead === null
        ? {}
        : {
            preview: {
              byteSize: previewHead.byteSize,
              etag:
                previewHead.etag ?? `"preview-${object.id}-${String(object.version_number ?? 0)}"`,
              open: readStorage(previewKey),
            },
          }),
    };
  }

  private async presignPutRequest(
    storage: DriveStorageClient | undefined,
    storageKey: string,
    mimeType: string,
  ): Promise<TenantPresignedPutUpload | null> {
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

  private async generatePreview(input: {
    readonly orgId: string;
    readonly objectId: string;
    readonly name: string;
    readonly storageKey: string;
    readonly mimeType: string;
    readonly versionNumber: number;
    readonly byteSize: number;
    readonly inlineContent?: Uint8Array;
  }): Promise<{
    readonly metadata: { readonly preview: DrivePreview } | Record<string, never>;
    readonly writtenStorageKey?: string;
  }> {
    if (!isOfficePreviewCandidate(input.mimeType, input.name)) {
      return { metadata: {} };
    }

    if (input.byteSize > MAX_BUFFERED_DRIVE_SCAN_BYTES) {
      return {
        metadata: {
          preview: unsupportedOfficePreview(
            input.mimeType,
            "Office preview exceeds the bounded conversion size.",
          ),
        },
      };
    }

    const converter = this.options.officePreviewConverter;
    const storage = await this.storageForOrg(input.orgId);
    if (converter === undefined || storage === undefined) {
      return {
        metadata: {
          preview: unsupportedOfficePreview(
            input.mimeType,
            "Office preview conversion requires the LibreOffice preview service.",
          ),
        },
      };
    }

    const content =
      input.inlineContent ?? (await this.readObjectBytes(input.orgId, input.storageKey));
    if (content === undefined) {
      return {
        metadata: {
          preview: unsupportedOfficePreview(
            input.mimeType,
            "Office preview conversion could not read the uploaded object bytes.",
          ),
        },
      };
    }

    let converted;
    try {
      converted = await converter.convert({
        objectId: input.objectId,
        name: input.name,
        storageKey: input.storageKey,
        sourceMimeType: input.mimeType,
        content,
      });
    } catch (error) {
      return {
        metadata: {
          preview: unsupportedOfficePreview(
            input.mimeType,
            error instanceof Error ? error.message : "Office preview conversion failed.",
          ),
        },
      };
    }
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
    let previewUrl: string | undefined;
    try {
      previewUrl = await storage.presignGetUrl?.(previewStorageKey, { expiresSeconds: 3600 });
    } catch (error) {
      await this.discardOrphanedQuarantineCopy({
        id: "",
        org_id: input.orgId,
        object_id: input.objectId,
        actor_id: null,
        storage_key: previewStorageKey,
        status: "pending",
        attempt_count: 0,
        next_attempt_at: new Date(),
      });
      throw error;
    }
    return {
      metadata: {
        preview: {
          kind: "pdf",
          status: "available",
          mimeType: "application/pdf",
          storageKey: previewStorageKey,
          ...(previewUrl === undefined ? {} : { url: previewUrl }),
          pageCount: converted.pageCount,
          generatedAt: converted.generatedAt,
        },
      },
      writtenStorageKey: previewStorageKey,
    };
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

  private emitStorageQuotaExceeded(
    orgId: string,
    event: Omit<StorageQuotaExceededEvent, "bucket" | "quota">,
  ): void {
    this.options.metrics?.recordOperationalEvent({
      capability: "drive",
      operation: "quota",
      status: "blocked",
    });
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
}

export interface StorageQuotaExceededEvent {
  readonly quota: "storage_bytes_limit";
  readonly bucket: "drive";
  readonly used_bytes: number;
  readonly limit_bytes: number;
  readonly byte_delta: number;
  readonly projected_bytes: number;
}

async function reserveDriveStorageQuota(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  byteSize: number,
  expiresAt: Date,
  onExceeded?: (event: Omit<StorageQuotaExceededEvent, "bucket" | "quota">) => void,
): Promise<void> {
  const rows = await sql<StorageQuotaDecisionRow[]>`
    select * from helix_reserve_drive_storage(
      ${orgId}, ${objectId}, ${byteSize}, ${expiresAt}
    )
  `;
  assertStorageQuotaDecision(orgId, byteSize, rows[0], onExceeded);
}

export async function commitStorageUsage(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  byteDelta: number,
  bucket: "drive" | "chat" | "meet_recordings",
  onExceeded?: (event: Omit<StorageQuotaExceededEvent, "bucket" | "quota">) => void,
): Promise<void> {
  const rows = await sql<StorageQuotaDecisionRow[]>`
    select * from helix_commit_storage_usage(${orgId}, ${objectId}, ${byteDelta}, ${bucket})
  `;
  assertStorageQuotaDecision(orgId, byteDelta, rows[0], onExceeded);
}

function assertStorageQuotaDecision(
  orgId: string,
  byteDelta: number,
  row: StorageQuotaDecisionRow | undefined,
  onExceeded?: (event: Omit<StorageQuotaExceededEvent, "bucket" | "quota">) => void,
): void {
  if (row === undefined) throw new DriveNotFoundError("Unknown Drive tenant.");
  if (row.accepted) return;
  const limit = numberFromBigIntLike(row.limit_bytes);
  if (limit === null) throw new Error("Unlimited storage quota was unexpectedly rejected.");
  const used = bytesFromDatabase(row.used_bytes);
  const projected = bytesFromDatabase(row.projected_bytes);
  onExceeded?.({
    used_bytes: used,
    limit_bytes: limit,
    byte_delta: byteDelta,
    projected_bytes: projected,
  });
  throw new DriveStorageQuotaExceededError(orgId, limit, projected);
}

async function requireObjectAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  objectId: string,
): Promise<ObjectRow> {
  // Drive surfaces 'file' (uploaded files / app-created docs) and
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
): Promise<ObjectRow> {
  const object = await requireObjectAccess(sql, orgId, actorId, objectId);
  if (object.owner_actor_id === actorId) return object;
  const rows = await sql<{ readonly role: string | null }[]>`
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

async function requireReadyObjectAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  objectId: string,
): Promise<ObjectRow> {
  const object = await requireObjectAccess(sql, orgId, actorId, objectId);
  assertDriveObjectReady(object);
  return object;
}

async function requireReadyObjectRole(
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

async function requireUploadWriteAccess(
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

function isDriveObjectReady(object: ObjectRow): boolean {
  const status = stringMetadata(object.metadata, "status");
  return status === undefined || status === "ready";
}

function assertDriveObjectReady(object: ObjectRow): void {
  if (!isDriveObjectReady(object)) {
    throw new DriveConflictError("Drive object is not ready.");
  }
}

async function requireFolderAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  folderId: string,
): Promise<{
  readonly id: string;
  readonly owner_actor_id: string | null;
}> {
  const rows = await sql<{ readonly id: string; readonly owner_actor_id: string | null }[]>`
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

async function requireFolderRole(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  folderId: string,
  minRole: DriveRole,
): Promise<void> {
  const folder = await requireFolderAccess(sql, orgId, actorId, folderId);
  if (folder.owner_actor_id === actorId) return;
  const rows = await sql<{ readonly role: string | null }[]>`
    select helix_drive_effective_role(${orgId}, ${actorId}, 'drive_folder', ${folderId}) as role
  `;
  const best = parseDriveRole(rows[0]?.role ?? "reader");
  if (!hasRoleAtLeast(best, minRole)) {
    throw new DriveForbiddenError(
      `Requires '${minRole}' access on Drive folder ${folderId}; actor has '${best}'.`,
    );
  }
}

async function requireFolderRoleIncludingDeleted(
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

/** Commenters are folder contributors: they may add children, but cannot trash or manage the folder. */
function requireFolderAddChildren(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  folderId: string,
): Promise<void> {
  return requireFolderRole(sql, orgId, actorId, folderId, "commenter");
}

async function insertDriveMultipartSession(
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

async function bindDriveMultipartSession(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  uploadId: string,
): Promise<void> {
  const rows = await sql<{ readonly id: string }[]>`
    update drive_multipart_sessions
    set upload_id = ${uploadId}, updated_at = now()
    where org_id = ${orgId} and object_id = ${objectId} and status = 'provisioning'
    returning id
  `;
  if (rows[0] === undefined)
    throw new DriveConflictError("Multipart upload session is unavailable.");
}

async function activateDriveMultipartSession(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  uploadId: string,
): Promise<void> {
  const rows = await sql<{ readonly id: string }[]>`
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

async function claimExpiredDriveMultipartSessions(
  sql: SqlLike,
  input: { readonly limit: number; readonly now: Date; readonly leaseExpiresAt: Date },
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

async function claimExpiredPreparedUploads(
  sql: SqlLike,
  input: { readonly limit: number; readonly now: Date; readonly leaseExpiresAt: Date },
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
          'uploadCleanupLeaseExpiresAt', ${input.leaseExpiresAt.toISOString()}
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
          'uploadCleanupLeaseExpiresAt', ${retryAt},
          'uploadCleanupError', ${error}
        ),
        updated_at = now()
    where org_id = ${object.org_id} and id = ${object.id}
      and metadata->>'status' = 'upload_expiring'
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

async function getLatestDriveVersion(
  sql: SqlLike,
  orgId: string,
  objectId: string,
): Promise<DriveVersionRecord | null> {
  const rows = await sql<DriveVersionRow[]>`
    select * from drive_versions
    where org_id = ${orgId} and object_id = ${objectId}
    order by version_number desc limit 1
  `;
  return rows[0] === undefined ? null : mapVersion(rows[0]);
}

async function claimDriveUploadFinalization(
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
  const versionRows = await sql<{ readonly version_number: number }[]>`
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

async function findIdempotentDriveVersion(
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

async function commitDriveScanFailure(
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
  const rows = await sql<{ readonly id: string }[]>`
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

async function commitDriveInfectedVerdict(
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
  const priorPreviewStorageKey = drivePreviewFromMetadata(
    input.claim.object.mime_type,
    input.claim.object.metadata,
  )?.storageKey;
  await sql`
    delete from drive_scan_jobs
    where org_id = ${input.input.orgId} and object_id = ${input.input.objectId}
  `;
  await sql`
    delete from drive_multipart_sessions
    where org_id = ${input.input.orgId} and object_id = ${input.input.objectId}
      and status in ('uploaded', 'completing')
  `;
  const rows = await sql<{ readonly id: string }[]>`
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
  if (priorPreviewStorageKey !== undefined) keys.add(priorPreviewStorageKey);
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

async function commitDriveCleanUpload(
  sql: SqlLike,
  input: {
    readonly claim: DriveFinalizationClaim;
    readonly input: FinalizeDriveUploadInput;
    readonly storageKey: string;
    readonly mimeType: string;
    readonly byteSize: number;
    readonly sha256: string;
    readonly preview: { readonly preview: DrivePreview } | Record<string, never>;
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
          ...input.preview,
        }),
      )},
      ${input.input.actorId}, ${input.input.idempotencyKey ?? null}
    ) returning *
  `;
  const version = mapVersion(versionRows[0]);
  const rows = await sql<{ readonly id: string }[]>`
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
            ...input.preview,
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

async function releaseDriveFinalizationClaim(
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

async function claimDriveBlobDestination(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  sha256: string,
  baseStorageKey: string,
): Promise<{
  readonly storageKey: string;
  readonly referenced: boolean;
  readonly reservationId: string;
}> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:${sha256}`}, 0))`;
  const rows = await sql<{ readonly storage_key: string; readonly refcount: number }[]>`
    select storage_key, refcount
    from drive_blobs
    where org_id = ${orgId} and sha256 = ${sha256}
    for update
  `;
  const current = rows[0];
  const referenced = current !== undefined && current.refcount > 0;
  const deletionRows = await sql`
    select 1
    from drive_quarantine_deletions
    where org_id = ${orgId} and storage_key = ${current?.storage_key ?? baseStorageKey}
      and status in ('pending', 'processing')
    limit 1
  `;
  const storageKey = referenced
    ? current.storage_key
    : deletionRows[0] === undefined
      ? (current?.storage_key ?? baseStorageKey)
      : `${baseStorageKey}.${randomUUID()}`;
  await sql`
    insert into drive_blobs (org_id, sha256, storage_key, byte_size, refcount)
    values (${orgId}, ${sha256}, ${storageKey}, 0, 0)
    on conflict (org_id, sha256) do update
      set storage_key = excluded.storage_key, updated_at = now()
    where drive_blobs.refcount = 0
  `;
  const reservations = await sql<{ readonly id: string }[]>`
    insert into drive_blob_reservations (
      org_id, object_id, sha256, storage_key, expires_at
    ) values (
      ${orgId}, ${objectId}, ${sha256}, ${storageKey},
      ${new Date(Date.now() + 24 * 60 * 60 * 1_000)}
    )
    on conflict (org_id, object_id) do update
      set sha256 = excluded.sha256, storage_key = excluded.storage_key,
          expires_at = excluded.expires_at, created_at = now()
    returning id
  `;
  const reservationId = reservations[0]?.id;
  if (reservationId === undefined) throw new Error("Failed to reserve Drive blob storage.");
  return { storageKey, referenced, reservationId };
}

async function driveBlobStorageIsReferenced(
  sql: SqlLike,
  orgId: string,
  storageKey: string,
): Promise<boolean> {
  const rows = await sql`
    select 1
    where exists (
      select 1 from drive_blobs
      where org_id = ${orgId} and storage_key = ${storageKey} and refcount > 0
    ) or exists (
      select 1 from drive_blob_reservations
      where org_id = ${orgId} and storage_key = ${storageKey} and expires_at > now()
    )
    limit 1
  `;
  return rows[0] !== undefined;
}

async function releaseDriveBlobReservation(
  sql: SqlLike,
  orgId: string,
  reservationId: string,
): Promise<void> {
  await sql`
    delete from drive_blob_reservations
    where org_id = ${orgId} and id = ${reservationId}
  `;
}

async function reconcileDriveBlobReferences(sql: SqlLike, orgId: string): Promise<void> {
  await sql`
    delete from drive_blob_reservations
    where org_id = ${orgId} and expires_at <= now()
  `;
  await sql`
    insert into drive_blobs (org_id, sha256, storage_key, byte_size, refcount)
    select org_id, lower(sha256), min(storage_key), max(byte_size), count(*)::integer
    from drive_versions
    where org_id = ${orgId} and storage_key like ${`drive/${orgId}/blobs/%`}
    group by org_id, lower(sha256)
    on conflict (org_id, sha256) do update
      set storage_key = excluded.storage_key, byte_size = excluded.byte_size,
          refcount = excluded.refcount, updated_at = now()
  `;
  await sql`
    update drive_blobs blob
    set refcount = 0, updated_at = now()
    where blob.org_id = ${orgId}
      and not exists (
        select 1 from drive_versions version
        where version.org_id = blob.org_id and version.storage_key = blob.storage_key
      )
  `;
  await sql`
    insert into drive_quarantine_deletions (
      org_id, object_id, actor_id, storage_key, status, next_attempt_at
    )
    select blob.org_id, gen_random_uuid(), null, blob.storage_key, 'pending', now()
    from drive_blobs blob
    where blob.org_id = ${orgId} and blob.refcount = 0
      and not exists (
        select 1 from drive_blob_reservations reservation
        where reservation.org_id = blob.org_id
          and reservation.storage_key = blob.storage_key
          and reservation.expires_at > now()
      )
    on conflict (org_id, storage_key) do update
      set status = 'pending', next_attempt_at = now(), lease_expires_at = null,
          completed_at = null, updated_at = now()
  `;
}

async function requireReadyDriveCommentObject(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  objectId: string,
  minimumRoleRank: number,
): Promise<DriveCommentObjectContext> {
  const rows = await sql<DriveCommentObjectContext[]>`
    select object.*,
      drive_comment_actor_role_rank(${orgId}, ${objectId}, ${actorId}) as comment_role_rank
    from objects object
    where object.org_id = ${orgId}
      and object.id = ${objectId}
      and object.kind in ('file', 'recording')
      and object.deleted_at is null
    limit 1
  `;
  const object = rows[0];
  if (object === undefined || object.comment_role_rank < 0) {
    throw new DriveNotFoundError(`Unknown or inaccessible Drive object: ${objectId}`);
  }
  assertDriveObjectReady(object);
  if (object.comment_role_rank < minimumRoleRank) {
    throw new DriveForbiddenError(
      `Insufficient permission to comment on Drive object ${objectId}.`,
    );
  }
  return object;
}

async function requireDriveCommentMutation(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  comment: DriveCommentRow,
  operation: "author" | "resolve",
): Promise<DriveCommentObjectContext> {
  const object = await requireReadyDriveCommentObject(sql, orgId, actorId, comment.object_id, 0);
  if (object.comment_role_rank >= 2) {
    return object;
  }
  const permitted =
    operation === "author"
      ? comment.actor_id === actorId
      : await driveCommentThreadOwnerId(sql, orgId, comment.id).then((id) => id === actorId);
  if (!permitted) {
    throw new DriveForbiddenError(
      operation === "author"
        ? "Only the comment author or an editor can change this comment."
        : "Only the thread owner or an editor can resolve this comment thread.",
    );
  }
  return object;
}

async function driveCommentThreadOwnerId(
  sql: SqlLike,
  orgId: string,
  commentId: string,
): Promise<string | null> {
  const rows = await sql<{ readonly actor_id: string | null }[]>`
    select drive_comment_thread_owner_id(${orgId}, ${commentId}) as actor_id
  `;
  return rows[0]?.actor_id ?? null;
}

interface DriveCommentCursor {
  readonly id: string;
}

interface DriveListCursor {
  readonly name: string;
  readonly type: number;
  readonly id: string;
  readonly snapshotAt: Date;
  readonly filter: string;
}

function driveListFilterKey(input: {
  readonly orgId: string;
  readonly actorId: string;
  readonly folderId: string | null;
  readonly includeTrashed: boolean;
  readonly app: string | null;
  readonly kind: string;
  readonly acrossFolders: boolean;
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

function boundedDriveCommentLimit(limit: number | undefined): number {
  return Math.min(100, Math.max(1, Math.trunc(limit ?? 50)));
}

function encodeDriveCommentCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

function decodeDriveCommentCursor(cursor: string | undefined): DriveCommentCursor | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    const id = Buffer.from(cursor, "base64url").toString("utf8");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
      throw new Error("invalid fields");
    }
    return { id };
  } catch {
    throw new BadRequestError("Invalid Drive comment cursor.");
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
  const rows = await sql<{ readonly id: string }[]>`
    select id
    from drive_comments
    where id = ${input.parentCommentId}
      and org_id = ${input.orgId}
      and object_id = ${input.objectId}
      and deleted_at is null
    limit 1
  `;
  if (rows[0] === undefined) {
    throw new Error(`Unknown parent Drive comment: ${input.parentCommentId}`);
  }
}

async function pdfFormSourceMetadata(
  sql: SqlLike,
  object: ObjectRow,
): Promise<PdfFormSourceMetadata> {
  const rows = await sql<
    {
      readonly version_number: number;
      readonly sha256: string;
      readonly byte_size: string | number;
    }[]
  >`
    select version_number, sha256, byte_size
    from drive_versions
    where org_id = ${object.org_id}
      and object_id = ${object.id}
    order by version_number desc
    limit 1
  `;
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

async function assertRecordingPurgeAllowed(
  sql: SqlLike,
  orgId: string,
  objectId: string,
): Promise<void> {
  const rows = await sql<{ readonly blocked: boolean }[]>`
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

function assertDriveRestoreAllowed(object: ObjectRow): void {
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
  const rows = await sql<{ readonly blocked: boolean }[]>`
    select exists (
      select 1 from drive_retention_holds hold
      where hold.org_id = ${object.org_id}
        and hold.resource_type = 'object'
        and hold.resource_id = ${object.id}
        and hold.released_at is null
        and (hold.expires_at is null or hold.expires_at > now())
    ) as blocked
  `;
  if (rows[0]?.blocked === true) {
    throw new DriveConflictError("Drive object is protected by a retention hold.");
  }
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
  const rows = await sql<{ readonly newly_referenced: boolean }[]>`
    insert into drive_blobs (org_id, sha256, storage_key, byte_size, refcount)
    values (${input.orgId}, ${input.sha256}, ${input.storageKey}, ${input.byteSize}, 1)
    on conflict (org_id, sha256) do update
      set refcount = drive_blobs.refcount + 1,
          storage_key = case when drive_blobs.refcount = 0 then excluded.storage_key else drive_blobs.storage_key end,
          byte_size = case when drive_blobs.refcount = 0 then excluded.byte_size else drive_blobs.byte_size end,
          updated_at = now()
    returning refcount = 1 as newly_referenced
  `;
  return rows[0]?.newly_referenced === true;
}

/**
 * Decrement drive_blobs.refcount for a blob storage key.
 * Returns the refcount after decrement (0 if row was removed / already gone).
 */
async function decrementDriveBlobRef(
  sql: SqlLike,
  input: { readonly orgId: string; readonly storageKey: string; readonly amount: number },
): Promise<number> {
  if (!Number.isSafeInteger(input.amount) || input.amount <= 0) {
    throw new TypeError("Drive blob reference decrement must be a positive safe integer.");
  }
  const rows = await sql<{ readonly refcount: number }[]>`
    update drive_blobs
    set refcount = refcount - ${input.amount},
        updated_at = now()
    where org_id = ${input.orgId}
      and storage_key = ${input.storageKey}
      and refcount >= ${input.amount}
    returning refcount
  `;
  const refcount = rows[0]?.refcount;
  if (refcount === undefined) {
    throw new Error("Drive blob refcount invariant does not match immutable versions.");
  }
  return refcount;
}

async function syncTargetDeletedAt(
  sql: SqlLike,
  orgId: string,
  objectId: string,
  action: "restore" | "trash" | "purge",
  trashSync: TrashSyncRegistry,
): Promise<void> {
  const deletedAt = action === "restore" ? null : new Date();
  const rows = await sql<{ readonly app: string | null }[]>`
    select metadata->>'app' as app from objects
    where id = ${objectId} and org_id = ${orgId}
  `;
  const app = rows[0]?.app ?? null;
  await trashSync.run(app, {
    sql: sql,
    orgId,
    objectId,
    action,
    deletedAt,
  });
}

function canReadFolderSql(
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

async function recordDriveScanFailure(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly objectId: string;
    readonly actorId: string;
    readonly error: string;
    readonly finalizeMetadata: JsonObject;
    readonly maxAttempts: number;
    readonly retryDelayMs: number;
  },
): Promise<DriveScanFailureRow> {
  const maxAttempts = Math.max(1, Math.trunc(input.maxAttempts));
  const nextAttemptAt = new Date(Date.now() + Math.max(1, input.retryDelayMs));
  const initialStatus = maxAttempts === 1 ? "dead_lettered" : "pending";
  const rows = await sql<DriveScanFailureRow[]>`
    insert into drive_scan_jobs (
      org_id, object_id, actor_id, status, attempt_count, next_attempt_at,
      last_error, finalize_metadata
    )
    values (
      ${input.orgId}, ${input.objectId}, ${input.actorId}, ${initialStatus}, 1,
      ${initialStatus === "dead_lettered" ? null : nextAttemptAt},
      ${input.error}, ${sql.json(toSqlJson(input.finalizeMetadata))}
    )
    on conflict (org_id, object_id) do update
    set
      actor_id = excluded.actor_id,
      status = case
        when drive_scan_jobs.status <> 'processing' then drive_scan_jobs.status
        when drive_scan_jobs.attempt_count + 1 >= ${maxAttempts} then 'dead_lettered'
        else 'pending'
      end,
      attempt_count = case
        when drive_scan_jobs.status = 'processing' then drive_scan_jobs.attempt_count + 1
        else drive_scan_jobs.attempt_count
      end,
      next_attempt_at = case
        when drive_scan_jobs.status <> 'processing' then drive_scan_jobs.next_attempt_at
        when drive_scan_jobs.attempt_count + 1 >= ${maxAttempts} then null
        else ${nextAttemptAt}
      end,
      lease_expires_at = case
        when drive_scan_jobs.status = 'processing' then null
        else drive_scan_jobs.lease_expires_at
      end,
      last_error = excluded.last_error,
      finalize_metadata = excluded.finalize_metadata,
      updated_at = now()
    returning id, org_id, object_id, actor_id, status, attempt_count,
              next_attempt_at, finalize_metadata
  `;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Failed to persist Drive antivirus retry state.");
  }
  return row;
}

async function insertDriveQuarantineDeletion(
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

async function claimDriveQuarantineDeletions(
  sql: SqlLike,
  input: { readonly limit: number; readonly now: Date; readonly leaseExpiresAt: Date },
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

async function claimDriveScanJobs(
  sql: SqlLike,
  input: { readonly limit: number; readonly now: Date; readonly leaseExpiresAt: Date },
): Promise<readonly DriveScanClaimRow[]> {
  return await sql<DriveScanClaimRow[]>`
    with candidates as (
      select jobs.id
      from drive_scan_jobs jobs
      join objects object on object.id = jobs.object_id and object.org_id = jobs.org_id
      where object.deleted_at is null
        and (
          (jobs.status = 'pending' and jobs.next_attempt_at <= ${input.now})
          or (jobs.status = 'processing' and jobs.lease_expires_at <= ${input.now})
        )
      order by jobs.next_attempt_at asc nulls first, jobs.created_at asc
      limit ${Math.max(1, Math.trunc(input.limit))}
      for update of jobs skip locked
    ), claimed as (
      update drive_scan_jobs jobs
      set status = 'processing', lease_expires_at = ${input.leaseExpiresAt}, updated_at = now()
      from candidates
      where jobs.id = candidates.id
      returning jobs.*
    )
    select claimed.*, object.owner_actor_id, object.storage_key, object.mime_type,
           object.byte_size, object.sha256
    from claimed
    join objects object on object.id = claimed.object_id and object.org_id = claimed.org_id
  `;
}

async function listDriveScanOrgIds(
  sql: postgres.Sql,
  afterId: string | undefined,
  limit: number,
): Promise<readonly string[]> {
  const rows =
    afterId === undefined
      ? await sql<{ readonly id: string }[]>`
          select id from orgs
          order by id
          limit ${limit}
        `
      : await sql<{ readonly id: string }[]>`
          select id from orgs
          where id > ${afterId}::uuid
          order by id
          limit ${limit}
        `;
  return rows.map((row) => row.id);
}

async function claimDrivePreviewJobs(
  sql: SqlLike,
  input: {
    readonly limit: number;
    readonly now: Date;
    readonly leaseExpiresAt: Date;
    readonly versionId?: string;
  },
): Promise<readonly DrivePreviewJobRow[]> {
  return await sql<DrivePreviewJobRow[]>`
    with candidates as (
      select id
      from drive_preview_jobs
      where (${input.versionId ?? null}::uuid is null or version_id = ${input.versionId ?? null})
        and ((status = 'pending' and next_attempt_at <= ${input.now})
          or (status = 'processing' and lease_expires_at <= ${input.now}))
      order by next_attempt_at, created_at
      limit ${Math.max(1, Math.trunc(input.limit))}
      for update skip locked
    ), claimed as (
      update drive_preview_jobs job
      set status = 'processing', lease_expires_at = ${input.leaseExpiresAt}, updated_at = now()
      from candidates
      where job.id = candidates.id
      returning job.*
    )
    select claimed.id, claimed.org_id, claimed.object_id, claimed.version_id,
      claimed.actor_id, claimed.attempt_count, version.storage_key, version.mime_type,
      version.byte_size, version.version_number, object.metadata as object_metadata
    from claimed
    join drive_versions version
      on version.org_id = claimed.org_id and version.id = claimed.version_id
    join objects object
      on object.org_id = claimed.org_id and object.id = claimed.object_id
  `;
}

async function completeDrivePreviewJob(
  sql: SqlLike,
  job: DrivePreviewJobRow,
  metadata: { readonly preview: DrivePreview } | Record<string, never>,
): Promise<boolean> {
  const rows = await sql<{ readonly id: string }[]>`
    update drive_versions
    set metadata = (metadata - 'preview') || ${sql.json(toSqlJson(metadata))}::jsonb
    where org_id = ${job.org_id} and id = ${job.version_id}
      and exists (
        select 1 from drive_preview_jobs
        where id = ${job.id} and org_id = ${job.org_id} and status = 'processing'
      )
    returning id
  `;
  if (rows[0] === undefined) return false;
  await sql`
    update objects
    set metadata = (metadata - 'preview') || ${sql.json(toSqlJson(metadata))}::jsonb,
        updated_at = now()
    where org_id = ${job.org_id} and id = ${job.object_id}
      and metadata->>'latestVersionId' = ${job.version_id}
  `;
  await sql`
    delete from drive_preview_jobs
    where id = ${job.id} and org_id = ${job.org_id} and status = 'processing'
  `;
  return true;
}

async function releaseDrivePreviewJob(
  sql: SqlLike,
  job: DrivePreviewJobRow,
  error: string,
  retryDelayMs: number,
): Promise<void> {
  await sql`
    update drive_preview_jobs
    set status = 'pending', attempt_count = attempt_count + 1,
        next_attempt_at = ${new Date(Date.now() + Math.max(1, retryDelayMs))},
        lease_expires_at = null, last_error = ${error}, updated_at = now()
    where id = ${job.id} and org_id = ${job.org_id} and status = 'processing'
  `;
}

async function releaseDriveScanClaim(
  sql: SqlLike,
  input: {
    readonly id: string;
    readonly orgId: string;
    readonly error: string;
    readonly maxAttempts: number;
    readonly retryDelayMs: number;
  },
): Promise<DriveScanFailureRow | null> {
  const maxAttempts = Math.max(1, Math.trunc(input.maxAttempts));
  const nextAttemptAt = new Date(Date.now() + Math.max(1, input.retryDelayMs));
  const rows = await sql<DriveScanFailureRow[]>`
    update drive_scan_jobs
    set
      status = case when attempt_count + 1 >= ${maxAttempts} then 'dead_lettered' else 'pending' end,
      attempt_count = attempt_count + 1,
      next_attempt_at = case
        when attempt_count + 1 >= ${maxAttempts} then null
        else ${nextAttemptAt}
      end,
      lease_expires_at = null,
      last_error = ${input.error},
      updated_at = now()
    where id = ${input.id} and org_id = ${input.orgId} and status = 'processing'
    returning id, org_id, object_id, actor_id, status, attempt_count,
              next_attempt_at, finalize_metadata
  `;
  return rows[0] ?? null;
}

async function updateDriveScanObjectState(
  sql: SqlLike,
  failure: DriveScanFailureRow,
): Promise<void> {
  await sql`
    update objects
    set metadata = metadata || jsonb_build_object(
          'status', ${failure.status === "dead_lettered" ? "scan_dead_letter" : "scan_pending"},
          'avScanAttempts', ${failure.attempt_count},
          'avScanNextAttemptAt', ${failure.next_attempt_at?.toISOString() ?? null}
        ),
        updated_at = now()
    where org_id = ${failure.org_id} and id = ${failure.object_id}
  `;
}

function virusScanErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/[\r\n\t]+/gu, " ").slice(0, 500) || "Antivirus scan failed.";
}

function isMissingStorageObject(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { readonly status?: unknown }).status === 404
  );
}

function isQuarantineVerdict(error: unknown): boolean {
  if (!(error instanceof DriveConflictError)) return false;
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    "scanOutcome" in details &&
    details.scanOutcome === "quarantined"
  );
}

function withoutVirusScanFailureMetadata(metadata: JsonObject): JsonObject {
  const failureKeys = new Set(["avScanAttempts", "avScanLastError", "avScanNextAttemptAt"]);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !failureKeys.has(key)));
}

function withoutMetadataKey(metadata: JsonObject, key: string): JsonObject {
  return Object.fromEntries(Object.entries(metadata).filter(([candidate]) => candidate !== key));
}

function withoutDriveFinalizationMetadata(metadata: JsonObject): JsonObject {
  const transientKeys = new Set([
    "scanActorId",
    "scanLeaseExpiresAt",
    "scanPreviousStatus",
    "scanToken",
  ]);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !transientKeys.has(key)));
}

function withoutDriveUploadLifecycleMetadata(metadata: JsonObject): JsonObject {
  const lifecycleKeys = new Set([
    "uploadCleanupError",
    "uploadCleanupLeaseExpiresAt",
    "uploadExpiresAt",
  ]);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !lifecycleKeys.has(key)));
}

function withoutDriveDerivedContentMetadata(metadata: JsonObject): JsonObject {
  const derivedKeys = new Set([
    "autoTag",
    "contentUrl",
    "description",
    "enrichments",
    "preview",
    "previewText",
    "previewUrl",
    "summary",
    "tags",
    "textContent",
  ]);
  return Object.fromEntries(Object.entries(metadata).filter(([key]) => !derivedKeys.has(key)));
}

async function appendDriveActivity(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly objectId: string;
    readonly payload: JsonObject;
  },
): Promise<void> {
  const previousRows = await sql<{ readonly this_hash: string }[]>`
    select this_hash from activity
    where org_id = ${input.orgId}
    order by created_at desc, id desc
    limit 1
    for update
  `;
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
    readonly tokens?: readonly string[] | undefined;
  },
): Promise<void> {
  const tokens = input.tokens ?? mentionTokensForComment(input.metadata, input.body);
  if (tokens.length === 0) {
    return;
  }
  const actorRows = await sql<
    {
      readonly id: string;
      readonly display_name: string;
      readonly email: string | null;
    }[]
  >`
    select id, display_name, email
    from actors
    where org_id = ${input.orgId}
      and disabled_at is null
      and type = 'user'
      and drive_comment_actor_role_rank(${input.orgId}, ${input.object.id}, actors.id) >= 0
  `;
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

async function notifyDriveCommentReply(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly object: ObjectRow;
    readonly commentId: string;
    readonly parentCommentId: string | null;
    readonly body: string;
  },
): Promise<void> {
  if (input.parentCommentId === null) {
    return;
  }
  const rows = await sql<{ readonly actor_id: string }[]>`
    select parent.actor_id
    from drive_comments parent
    where parent.org_id = ${input.orgId}
      and parent.object_id = ${input.object.id}
      and parent.id = ${input.parentCommentId}
      and parent.deleted_at is null
      and parent.actor_id is not null
      and parent.actor_id <> ${input.actorId}
      and drive_comment_actor_role_rank(
        ${input.orgId}, ${input.object.id}, parent.actor_id
      ) >= 0
      and not exists (
        select 1 from notifications notification
        where notification.org_id = ${input.orgId}
          and notification.actor_id = parent.actor_id
          and notification.payload->>'commentId' = ${input.commentId}
      )
    limit 1
  `;
  const recipientId = rows[0]?.actor_id;
  if (recipientId === undefined) {
    return;
  }
  await insertNotification(sql, {
    orgId: input.orgId,
    actorId: recipientId,
    verb: "drive.comment.reply",
    objectType: "drive.object",
    objectId: input.object.id,
    summary: `Someone replied to your comment in "${driveObjectNotificationTitle(input.object)}".`,
    body: input.body,
    payload: {
      objectId: input.object.id,
      commentId: input.commentId,
      parentCommentId: input.parentCommentId,
      repliedByActorId: input.actorId,
    },
  });
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
    byteSize: bytesFromDatabase(row.byte_size),
    sha256: row.sha256,
    status: stringMetadata(metadata, "status") ?? "ready",
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDriveWebDavLock(row: DriveWebDavLockRow | undefined): DriveWebDavLock {
  if (row === undefined) throw new Error("Expected Drive WebDAV lock row.");
  return {
    pathKey: row.path_key,
    token: `opaquelocktoken:${row.token}`,
    actorId: row.actor_id,
    owner: row.owner,
    depth: row.depth,
    fence: String(row.fence),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function assertWebDavPathKey(value: string): void {
  if (!value.startsWith("/") || value.length > 4_096 || value.includes("\0")) {
    throw new BadRequestError("Invalid WebDAV lock path.");
  }
}

function webDavLockUuid(token: string): string {
  const value = token.replace(/^opaquelocktoken:/u, "");
  if (!UUID_RE.test(value)) throw new BadRequestError("Invalid WebDAV lock token.");
  return value;
}

function webDavSyncVersion(value: string): string {
  if (!/^(0|[1-9][0-9]{0,18})$/u.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new BadRequestError("Invalid WebDAV sync token.");
  }
  return value;
}

function mapVersion(row: DriveVersionRow | undefined): DriveVersionRecord {
  if (row === undefined) {
    throw new DriveNotFoundError("Expected Drive version row.");
  }
  return mapVersionCore(row);
}

const SHARE_DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireSharePassword(password: string): string {
  if (password.length < 12 || password.length > 256) {
    throw new TypeError("Share-link passwords must contain 12 to 256 characters.");
  }
  return password;
}

function normalizeShareDomains(domains: readonly string[]): readonly string[] {
  const normalized = [...new Set(domains.map((domain) => domain.trim().toLowerCase()))].sort();
  if (normalized.length > 50 || normalized.some((domain) => !SHARE_DOMAIN_RE.test(domain))) {
    throw new TypeError("Share-link domains must be valid lower-case DNS names (maximum 50).");
  }
  return normalized;
}

interface DriveSharePolicyRow {
  readonly classification: string | null;
  readonly external_settings: JsonObject | null;
  readonly dlp_settings: JsonObject | null;
}

async function driveSharePolicyReason(
  sql: SqlLike,
  object: Pick<ObjectRow, "id" | "org_id" | "metadata">,
  allowedDomains: readonly string[],
): Promise<{ readonly reason: string | null; readonly classification: string }> {
  const rows = await sql<DriveSharePolicyRow[]>`
    select
      (select classification.classification
       from resource_classifications classification
       where classification.org_id = ${object.org_id}
         and classification.resource_type = 'drive.file'
         and classification.resource_id = ${object.id}
       limit 1) as classification,
      (select policy.settings from admin_security_policies policy
       where policy.org_id = ${object.org_id} and policy.policy_type = 'external_sharing'
         and policy.enabled and policy.enforcement <> 'disabled'
       limit 1) as external_settings,
      (select policy.settings from admin_security_policies policy
       where policy.org_id = ${object.org_id} and policy.policy_type = 'dlp'
         and policy.enabled and policy.enforcement <> 'disabled'
       limit 1) as dlp_settings
  `;
  const policy = rows[0];
  const storedClassification = policy?.classification;
  const classification =
    storedClassification === "public" ||
    storedClassification === "standard" ||
    storedClassification === "confidential" ||
    storedClassification === "restricted"
      ? storedClassification
      : "standard";
  if (classification === "confidential" || classification === "restricted") {
    return { reason: "classification_blocks_public_link", classification };
  }
  const externalMode = policy?.external_settings?.mode;
  if (externalMode === "blocked") {
    return { reason: "external_sharing_blocked", classification };
  }
  if (externalMode === "allowlist") {
    const configured = new Set(
      Array.isArray(policy?.external_settings?.allowedDomains)
        ? policy.external_settings.allowedDomains.filter(
            (domain): domain is string => typeof domain === "string",
          )
        : [],
    );
    if (allowedDomains.length === 0 || allowedDomains.some((domain) => !configured.has(domain))) {
      return { reason: "domain_not_allowlisted", classification };
    }
  }
  const dlp = policy?.dlp_settings;
  if (
    dlp?.action === "block" &&
    dlp.scanSharedDocs !== false &&
    !["clean", "allowed"].includes(stringMetadata(object.metadata, "dlpVerdict") ?? "")
  ) {
    return { reason: "dlp_verdict_required", classification };
  }
  return { reason: null, classification };
}

async function assertDriveSharePolicy(
  sql: SqlLike,
  object: ObjectRow,
  allowedDomains: readonly string[],
): Promise<string> {
  const denied = await driveSharePolicyReason(sql, object, allowedDomains);
  if (denied.reason !== null) {
    throw new DriveForbiddenError(`Drive public link rejected: ${denied.reason}.`);
  }
  return denied.classification;
}

async function consumeDriveShareRateLimit(
  sql: SqlLike,
  scopeHash: string,
  limit: number,
): Promise<void> {
  const rows = await sql<{ readonly allowed: boolean }[]>`
    select helix_consume_drive_share_rate_limit(${scopeHash}, ${limit}, 60) as allowed
  `;
  if (rows[0]?.allowed !== true) {
    throw new RateLimitedError("Share-link request limit exceeded.", { retryAfterSeconds: 60 });
  }
}

function shareLinkRow(row: DriveShareLinkAccessRow): DriveShareLinkRow {
  return {
    id: row.link_id,
    org_id: row.link_org_id,
    token_hash: row.token_hash,
    object_id: row.link_object_id,
    role: "reader",
    password_hash: row.password_hash,
    one_time: row.one_time,
    allowed_domains: row.allowed_domains,
    allow_download: row.allow_download,
    consumed_at: row.consumed_at,
    access_count: row.access_count,
    last_access_at: row.last_access_at,
    classification: row.link_classification,
    expires_at: row.expires_at,
    created_by_actor_id: row.created_by_actor_id,
    created_at: row.link_created_at,
    revoked_at: row.revoked_at,
  };
}

function shareActorId(
  link: Pick<DriveShareLinkRow, "org_id">,
  actor: DriveShareAccessInput["actor"],
): string | null {
  return actor?.orgId === link.org_id && UUID_RE.test(actor.id) ? actor.id : null;
}

async function appendDriveShareLinkEvent(
  sql: SqlLike,
  link: DriveShareLinkRow,
  eventType: "create" | "access" | "download" | "revoke",
  outcome: "allowed" | "denied" | "integrity_error",
  actorId: string | null,
  clientKey: string | null,
  details: JsonObject,
): Promise<void> {
  await sql`
    select helix_append_drive_share_link_event(
      ${link.org_id}, ${link.id}, ${eventType}, ${outcome}, ${actorId}, ${clientKey},
      ${sql.json(toSqlJson(details))}::jsonb
    )
  `;
}

async function driveShareDenialReason(
  sql: SqlLike,
  row: DriveShareLinkAccessRow,
  input: DriveShareAccessInput,
): Promise<string | null> {
  if (
    row.revoked_at !== null ||
    (row.expires_at !== null && row.expires_at <= new Date()) ||
    (row.one_time && row.consumed_at !== null) ||
    row.deleted_at !== null ||
    (stringMetadata(row.metadata, "status") !== undefined &&
      stringMetadata(row.metadata, "status") !== "ready")
  ) {
    return "unavailable";
  }
  if (input.download === true && !row.allow_download) return "download_blocked";
  if (
    row.password_hash !== null &&
    (input.password === undefined || !(await verifySecret(input.password, row.password_hash)))
  ) {
    return "password_invalid";
  }
  if (row.allowed_domains.length > 0) {
    const actorDomain = input.actor?.email?.split("@").at(-1)?.toLowerCase();
    if (
      input.actor?.orgId !== row.link_org_id ||
      actorDomain === undefined ||
      !row.allowed_domains.includes(actorDomain)
    ) {
      return "domain_identity_required";
    }
  }
  return (await driveSharePolicyReason(sql, row, row.allowed_domains)).reason;
}

function mapShareLink(row: DriveShareLinkRow, token: string | null = null): DriveShareLinkRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    objectId: row.object_id,
    token,
    role: "reader",
    expiresAt: row.expires_at,
    passwordProtected: row.password_hash !== null,
    oneTime: row.one_time,
    allowedDomains: [...row.allowed_domains],
    allowDownload: row.allow_download,
    consumedAt: row.consumed_at,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
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

function mapDriveListEntry(row: DriveListRow): DriveEntryRecord {
  if (row.entry_type === "folder") {
    return {
      id: row.id,
      type: "folder",
      name: row.name,
      folderId: row.folder_id,
      ownerActorId: row.owner_actor_id,
      app: null,
      metadata: row.metadata,
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  if (row.storage_key === null || row.mime_type === null || row.byte_size === null) {
    throw new Error("Drive list returned an incomplete file row.");
  }
  return mapObjectEntry({
    id: row.id,
    org_id: "",
    owner_actor_id: row.owner_actor_id,
    kind: "file",
    storage_key: row.storage_key,
    mime_type: row.mime_type,
    byte_size: row.byte_size,
    sha256: row.sha256,
    metadata: row.metadata,
    deleted_at: row.deleted_at,
    trash_purge_after: null,
    retain_until: null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    version_number: row.version_number,
    mine: row.mine,
    shared_count: row.shared_count,
    starred: row.starred,
  });
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
    ...(typeof row.mine === "boolean" ? { mine: row.mine } : {}),
    ...(row.shared_count === undefined || row.shared_count === null
      ? {}
      : { shared_count: row.shared_count }),
    ...(typeof row.starred === "boolean" ? { starred: row.starred } : {}),
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

function mapDriveCommentRevision(row: DriveCommentRevisionRow): DriveCommentRevisionRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    objectId: row.object_id,
    commentId: row.comment_id,
    revision: Number(row.revision),
    changeKind: row.change_kind,
    parentCommentId: row.parent_comment_id,
    commentActorId: row.comment_actor_id,
    anchor: row.anchor,
    body: row.body,
    status: row.status,
    metadata: row.metadata,
    resolvedAt: row.resolved_at,
    resolvedByActorId: row.resolved_by_actor_id,
    deletedAt: row.deleted_at,
    deletedByActorId: row.deleted_by_actor_id,
    changedByActorId: row.changed_by_actor_id,
    capturedAt: row.captured_at,
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
    byteSize: bytesFromDatabase(row.byte_size),
    storageKey: row.storage_key,
    ...(row.sha256 === null ? {} : { sha256: row.sha256 }),
    ...(parentFolderId === null ? {} : { parentFolderId }),
    path: [...row.folder_path, name],
    allowedActorIds: row.allowed_actor_ids,
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
  const status = stringMetadata(current.metadata, "status");
  if (status !== "ready") return byteSize;
  if (storageKey === current.storage_key) {
    return byteSize - bytesFromDatabase(current.byte_size);
  }
  return byteSize;
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
  const classification = sensitivityClassificationFromMetadata(metadata);
  return classification === undefined ? {} : { classification };
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
      (status === "pending" || status === "available" || status === "unsupported")
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
  return /\.(docx|docm|dotx|dotm|odt|xlsx|xlsm|xltx|xltm|ods|pptx|pptm|ppsx|ppsm|potx|potm|odp)$/iu.test(
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

const MAX_BUFFERED_DRIVE_SCAN_BYTES = 128 * 1024 * 1024;

async function readStoredUpload(
  storage: DriveStorageClient | undefined,
  key: string,
): Promise<StorageObject | null | undefined> {
  if (storage === undefined) return undefined;
  return storage.getStream === undefined ? storage.get(key) : storage.getStream(key);
}

async function inspectAndScanUpload(input: {
  readonly open: () => Promise<StorageObject["body"] | null>;
  readonly declaredByteSize: number;
  readonly declaredMimeType: string;
  readonly scanner: VirusScanner;
}): Promise<{
  readonly actualByteSize: number;
  readonly actualSha256: string;
  readonly mimeType: string;
  readonly scan: VirusScanResult | Error;
  readonly bufferedBytes?: Uint8Array;
}> {
  const first = await input.open();
  if (first === null) {
    throw new DriveConflictError("Drive upload bytes were not found at the reserved key.");
  }
  const inspected = await hashStorageBody(first);
  if (inspected.byteSize !== input.declaredByteSize) {
    throw new DriveConflictError("Drive upload size does not match stored bytes.", {
      details: { expectedByteSize: input.declaredByteSize, actualByteSize: inspected.byteSize },
    });
  }
  const mimeType = resolveEffectiveMime(input.declaredMimeType, sniffMimeType(inspected.head));
  let bufferedBytes = first instanceof Uint8Array ? first : undefined;
  let scan: VirusScanResult | Error;
  try {
    const archive = mimeType === "application/zip" || isGzipHead(inspected.head);
    if (
      bufferedBytes === undefined &&
      (archive || input.scanner.scanStream === undefined) &&
      inspected.byteSize <= MAX_BUFFERED_DRIVE_SCAN_BYTES
    ) {
      const reopened = await input.open();
      if (reopened === null) throw new Error("Drive upload disappeared before virus scanning.");
      bufferedBytes = await toUint8Array(reopened);
    }
    if (bufferedBytes !== undefined) {
      scan = await input.scanner.scan(bufferedBytes);
    } else if (input.scanner.scanStream !== undefined) {
      const reopened = await input.open();
      if (reopened === null) throw new Error("Drive upload disappeared before virus scanning.");
      scan = await input.scanner.scanStream(asAsyncIterable(reopened), inspected.byteSize);
    } else {
      throw new Error("Virus scanner does not support bounded streaming for this file size.");
    }
  } catch (error) {
    scan = error instanceof Error ? error : new Error(String(error));
  }
  return {
    actualByteSize: inspected.byteSize,
    actualSha256: inspected.sha256,
    mimeType,
    scan,
    ...(bufferedBytes === undefined ? {} : { bufferedBytes }),
  };
}

async function hashStorageBody(body: StorageObject["body"]): Promise<{
  readonly byteSize: number;
  readonly sha256: string;
  readonly head: Uint8Array;
}> {
  const hash = createHash("sha256");
  let byteSize = 0;
  const head = new Uint8Array(512);
  let headSize = 0;
  for await (const chunk of asAsyncIterable(body)) {
    byteSize += chunk.byteLength;
    if (!Number.isSafeInteger(byteSize)) throw new Error("Drive object exceeds safe size limits.");
    hash.update(chunk);
    if (headSize < head.byteLength) {
      const copied = Math.min(chunk.byteLength, head.byteLength - headSize);
      head.set(chunk.subarray(0, copied), headSize);
      headSize += copied;
    }
  }
  return { byteSize, sha256: hash.digest("hex"), head: head.subarray(0, headSize) };
}

async function* asAsyncIterable(body: StorageObject["body"]): AsyncIterable<Uint8Array> {
  if (body instanceof Uint8Array) {
    yield body;
    return;
  }
  yield* body;
}

function isGzipHead(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function driveContentEtag(
  sha256: string | null,
  objectId: string,
  versionNumber: number | null,
): string {
  return sha256 === null
    ? `"drive-${objectId}-${String(versionNumber ?? 0)}"`
    : `"sha256-${sha256}"`;
}

function sliceStorageBody(
  body: StorageObject["body"],
  range: { readonly start: number; readonly end: number },
): StorageObject["body"] {
  if (body instanceof Uint8Array) return body.subarray(range.start, range.end + 1);
  return (async function* () {
    let offset = 0;
    for await (const chunk of body) {
      const chunkEnd = offset + chunk.byteLength;
      if (chunkEnd > range.start && offset <= range.end) {
        const start = Math.max(0, range.start - offset);
        const end = Math.min(chunk.byteLength, range.end - offset + 1);
        if (end > start) yield chunk.subarray(start, end);
      }
      offset = chunkEnd;
      if (offset > range.end) return;
    }
  })();
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
