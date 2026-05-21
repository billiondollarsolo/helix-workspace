import type { AIClassification, JsonObject } from "@helix/sdk-types";

export const drivePluginId = "com.helix.core.drive";

export type DriveItemKind = "file" | "folder";
export type DriveShareRole = "viewer" | "commenter" | "editor" | "owner";
export type DrivePreviewKind = "text" | "image" | "pdf" | "office" | "unsupported";
export type DrivePreviewStatus = "available" | "unsupported";

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
  readonly metadata: JsonObject;
  readonly createdAt: Date;
  readonly updatedAt: Date;
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

export interface DrivePreview {
  readonly kind: DrivePreviewKind;
  readonly status: DrivePreviewStatus;
  readonly mimeType: string;
  readonly text?: string | undefined;
  readonly url?: string | undefined;
  readonly storageKey?: string | undefined;
  readonly pageCount?: number | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly blocker?: string | undefined;
  readonly generatedAt?: string | undefined;
}
