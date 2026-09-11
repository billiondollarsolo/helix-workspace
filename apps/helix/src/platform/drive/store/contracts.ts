import type { Actor, EventBus, JsonObject, StorageClient, StorageObject } from "@helix/sdk-types";
import { type DlpGuard } from "../../dlp.js";
import type { TenantPresignedPutUpload, TenantStorageResolver } from "../../storage/index.js";
import type { DriveConfig } from "../config.js";
import { type VirusScanner } from "../scanning.js";
import type {
  DriveAccessGrantRecord,
  DriveCommentPage,
  DriveCommentRecord,
  DriveCommentRevisionPage,
  DriveEntryPage,
  DriveEntryRecord,
  DriveSearchHit,
  DriveUploadRecord,
  DriveUploadStatusRecord,
  DriveVersionRecord,
} from "../types.js";
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
    options?: {
      readonly contentType?: string;
    },
  ): Promise<{
    readonly uploadId: string;
  }>;
  presignUploadPart?(
    key: string,
    uploadId: string,
    partNumber: number,
    options?: {
      readonly contentType?: string;
      readonly expiresSeconds?: number;
    },
  ): Promise<string>;
  completeMultipartUpload?(
    key: string,
    uploadId: string,
    parts: readonly {
      readonly partNumber: number;
      readonly etag: string;
    }[],
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
  readonly parts: readonly {
    readonly partNumber: number;
    readonly etag: string;
  }[];
  readonly byteSize: number;
  readonly sha256?: string;
  readonly mimeType?: string;
  readonly metadata?: JsonObject;
}

export type DriveDocumentSurfaceView = "grid" | "list";

export interface DriveStore {
  getStorageQuotaUsage?(input: { readonly orgId: string }): Promise<DriveStorageQuotaUsageRecord>;
  getLifecyclePolicy?(input: { readonly orgId: string }): Promise<DriveLifecyclePolicyRecord>;
  setLifecyclePolicy?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly trashRetentionDays: number;
    readonly orphanGraceHours: number;
  }): Promise<DriveLifecyclePolicyRecord>;
  getUploadStatus?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
  }): Promise<DriveUploadStatusRecord | null>;
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
    /** Filter by object kind. Defaults to 'file' so existing callers stay
     *  unchanged; pass 'recording' for the Recordings drive surface. */
    readonly kind?: string | null;
    readonly acrossFolders?: boolean;
    readonly view?: "owned" | "shared" | null;
  }): Promise<DriveEntryPage>;
  setHiddenShare?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly hidden: boolean;
  }): Promise<{ readonly objectId: string; readonly hidden: boolean }>;
  requestAccess?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly message?: string;
  }): Promise<{ readonly requestId: string }>;
  decideAccessRequest?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly requestId: string;
    readonly approve: boolean;
  }): Promise<{ readonly requestId: string; readonly approved: boolean }>;
  listAccessRequests?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId?: string;
  }): Promise<
    readonly {
      readonly id: string;
      readonly objectId: string;
      readonly requesterActorId: string;
      readonly requesterDisplayName: string | null;
      readonly requesterEmail: string | null;
      readonly objectName: string;
      readonly message: string | null;
      readonly createdAt: Date;
    }[]
  >;
  copyObject?(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly folderId?: string | null;
  }): Promise<DriveEntryRecord>;
  share(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly objectId: string;
    readonly targetActorIds: readonly string[];
    readonly role: string;
    readonly expiresAt?: Date | null;
    readonly notify?: boolean;
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
    readonly maxDownloads?: number | null;
    readonly rateLimitPerHour?: number;
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
  readonly maxDownloads: number | null;
  readonly downloadCount: number;
  readonly rateLimitPerHour: number;
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
}

interface DriveObjectStream {
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
}

export interface PostgresDriveStoreOptions {
  readonly gc?: DriveConfig["gc"];
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
  /** When true, finalize uses content-addressed blob keys + refcounts. */
  readonly contentAddressedDedup?: boolean;
  /** Multipart threshold in bytes (default 8 MiB). */
  readonly multipartThresholdBytes?: number;
  readonly multipartPartSizeBytes?: number;
  /** Lifetime for a prepared multipart plan and its presigned URLs (default 15 minutes). */
  readonly multipartSessionTtlMs?: number;
  readonly dlp?: DlpGuard;
}

interface DriveVirusScanUnavailableEvent {
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

export interface StorageQuotaExceededEvent {
  readonly quota: "storage_bytes_limit";
  readonly bucket: "drive";
  readonly used_bytes: number;
  readonly limit_bytes: number;
  readonly byte_delta: number;
  readonly projected_bytes: number;
}
