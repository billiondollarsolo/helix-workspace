import type { AIClassification, JsonObject } from "@helix/sdk-types";
import type {
  DriveItemKind as ContractDriveItemKind,
  DrivePreview as ContractDrivePreview,
  DrivePreviewKind as ContractDrivePreviewKind,
  DriveRole,
} from "@helix/contracts";

export const drivePluginId = "com.helix.core.drive";

export type DriveItemKind = ContractDriveItemKind;
export type DriveShareRole = DriveRole;
export type DrivePreviewKind = ContractDrivePreviewKind;
export type DrivePreviewStatus = ContractDrivePreview["status"];
export type { DriveRole };

export type DriveActor = JsonObject & {
  readonly id: string;
  readonly displayName?: string;
  readonly email?: string;
};

export interface DriveSearchRecord {
  readonly id: string;
  readonly orgId: string;
  readonly kind: DriveItemKind;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly storageKey?: string | undefined;
  readonly sha256?: string | undefined;
  readonly parentFolderId?: string | undefined;
  readonly path?: readonly string[] | undefined;
  readonly owner?: DriveActor | undefined;
  /** Principals allowed to discover this record in search/RAG. */
  readonly allowedActorIds?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly summary?: string | undefined;
  readonly description?: string | undefined;
  readonly textContent?: string | undefined;
  readonly classification?: AIClassification | undefined;
  readonly createdAt: string;
  readonly updatedAt?: string | undefined;
  readonly trashedAt?: string | undefined;
  readonly deletedAt?: string | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface DriveSearchProjectionStore {
  getDriveSearchRecord(fileId: string): Promise<DriveSearchRecord | null>;
}

export type DriveEnrichmentRecord = DriveSearchRecord;

export interface DriveEnrichmentWrite {
  readonly fileId: string;
  readonly feature: string;
  readonly data: JsonObject;
}

export interface DriveAutoTagWrite {
  readonly fileId: string;
  readonly tags: readonly string[];
  readonly source: string;
}

export interface DriveEnrichmentProjectionStore {
  getDriveEnrichmentRecord(fileId: string): Promise<DriveEnrichmentRecord | null>;
  recordDriveEnrichment?(input: DriveEnrichmentWrite): Promise<void>;
  setDriveAutoTags?(input: DriveAutoTagWrite): Promise<void>;
}

export type DriveActivityPayload = JsonObject & {
  readonly id?: string | undefined;
  readonly objectId?: string | undefined;
  readonly fileId?: string | undefined;
};

export interface DriveMultipartUploadInfo {
  readonly uploadId: string;
  readonly partSize: number;
  readonly partCount: number;
  readonly partUrls: readonly string[];
  readonly expiresAt: string;
}

export interface DriveUploadRecord {
  readonly objectId: string;
  readonly orgId: string;
  readonly ownerActorId: string;
  readonly name: string;
  readonly folderId: string | null;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string | null;
  readonly status: string;
  readonly uploadUrl: string | null;
  readonly uploadHeaders: Record<string, string>;
  readonly metadata: JsonObject;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Present when the server prepared an S3 multipart upload for large files. */
  readonly multipart?: DriveMultipartUploadInfo | undefined;
}

export interface DriveVersionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly objectId: string;
  readonly versionNumber: number;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly metadata: JsonObject;
  readonly createdByActorId: string | null;
  readonly createdAt: Date;
}

export interface DriveFolderRecord {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly parentFolderId: string | null;
  readonly ownerActorId: string | null;
  readonly createdByActorId: string | null;
  readonly metadata: JsonObject;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DriveEntryRecord {
  readonly id: string;
  readonly type: DriveItemKind;
  readonly name: string;
  readonly folderId: string | null;
  readonly ownerActorId: string | null;
  readonly app: string | null;
  readonly mimeType?: string | undefined;
  readonly byteSize?: number | undefined;
  readonly sha256?: string | null | undefined;
  readonly storageKey?: string | undefined;
  readonly versionNumber?: number | undefined;
  readonly preview?: DrivePreview | undefined;
  readonly metadata: JsonObject;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DriveEntryPage {
  readonly entries: readonly DriveEntryRecord[];
  readonly nextCursor: string | null;
}

export interface DriveWebDavLock {
  readonly pathKey: string;
  readonly token: string;
  readonly actorId: string;
  readonly owner: string;
  readonly depth: "0" | "infinity";
  readonly fence: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface DriveWebDavChange {
  readonly pathKey: string;
  readonly resourceType: "file" | "folder";
  readonly status: 200 | 404;
  readonly version: string;
}

export interface DriveWebDavChangePage {
  readonly changes: readonly DriveWebDavChange[];
  readonly version: string;
  readonly valid: boolean;
  readonly hasMore: boolean;
}

export interface AcquireDriveWebDavLockInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly pathKey: string;
  readonly owner: string;
  readonly depth: "0" | "infinity";
  readonly timeoutSeconds: number;
  readonly token?: string;
}

export interface DriveAccessGrantRecord {
  readonly actorId: string;
  readonly role: string;
  readonly displayName?: string | undefined;
  readonly email?: string | undefined;
  readonly grantedByActorId: string | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DriveSearchHit {
  readonly objectId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string | null;
  readonly folderId: string | null;
  readonly preview: string;
  readonly previewMetadata?: DrivePreview | undefined;
  readonly updatedAt: Date;
}

export interface DriveCommentRecord {
  readonly id: string;
  readonly orgId: string;
  readonly objectId: string;
  readonly parentCommentId: string | null;
  readonly actorId: string | null;
  readonly anchor: JsonObject;
  readonly body: string;
  readonly status: string;
  readonly metadata: JsonObject;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date | null;
}

export interface DriveCommentListItem extends DriveCommentRecord {
  readonly author?: DriveActor | undefined;
}

export interface DriveCommentPage {
  readonly comments: readonly DriveCommentListItem[];
  readonly nextCursor: string | null;
}

export interface DriveCommentRevisionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly objectId: string;
  readonly commentId: string;
  readonly revision: number;
  readonly changeKind: "created" | "edited" | "resolved" | "reopened" | "deleted";
  readonly parentCommentId: string | null;
  readonly commentActorId: string | null;
  readonly anchor: JsonObject;
  readonly body: string;
  readonly status: "open" | "resolved";
  readonly metadata: JsonObject;
  readonly resolvedAt: Date | null;
  readonly resolvedByActorId: string | null;
  readonly deletedAt: Date | null;
  readonly deletedByActorId: string | null;
  readonly changedByActorId: string;
  readonly capturedAt: Date;
}

export interface DriveCommentRevisionPage {
  readonly revisions: readonly DriveCommentRevisionRecord[];
  readonly nextCursor: string | null;
}

export interface DrivePdfFormStateRecord {
  readonly orgId: string;
  readonly objectId: string;
  readonly actorId: string;
  readonly fieldValues: readonly JsonObject[];
  readonly sourceVersionNumber: number | null;
  readonly sourceSha256: string | null;
  readonly sourceByteSize: number | null;
  readonly sourceChanged: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type DrivePreview = ContractDrivePreview;
