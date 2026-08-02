import type { JsonObject } from "@helix/sdk-types";
import type { DriveUploadState } from "@helix/contracts";
import type {
  DriveAccessGrantRecord,
  DriveEntryRecord,
  DrivePreview,
  DriveSearchHit,
  DriveVersionRecord,
} from "../types.js";
import {
  isDriveFileAvailable,
  isDriveUploadState,
  userFacingDriveUploadState,
} from "../upload-state.js";

/** Minimal pure helpers shared by store mappers (G5). */

export function stringMetadata(metadata: JsonObject, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" ? value : undefined;
}

export function nullableStringMetadata(metadata: JsonObject, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

export function bytesFromDatabase(value: string | number): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10);
}

export interface MapObjectEntryInput {
  readonly id: string;
  readonly owner_actor_id: string | null;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: number;
  readonly sha256: string | null;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly version_number?: number | null;
  readonly mine?: boolean;
  readonly shared_count?: string | number | null;
  readonly preview?: DrivePreview;
  readonly upload_state?: DriveUploadState | string | null;
}

/** Owner-visible non-active states that may appear in list (never treated as available). */
export function isOwnerVisibleProcessingState(state: DriveUploadState): boolean {
  return (
    state === "uploaded" ||
    state === "scanning" ||
    state === "quarantined" ||
    state === "scan_failed"
  );
}

export function mapObjectEntry(row: MapObjectEntryInput): DriveEntryRecord {
  const metadata =
    row.mine === undefined && row.shared_count === undefined
      ? row.metadata
      : {
          ...row.metadata,
          ...(typeof row.mine === "boolean" ? { mine: row.mine } : {}),
          ...(row.shared_count === undefined || row.shared_count === null
            ? {}
            : { sharedCount: bytesFromDatabase(row.shared_count) }),
        };
  const uploadState = isDriveUploadState(row.upload_state) ? row.upload_state : undefined;
  const userFacing =
    uploadState === undefined ? undefined : userFacingDriveUploadState(uploadState);
  return {
    id: row.id,
    type: "file",
    name: stringMetadata(row.metadata, "name") ?? row.storage_key,
    folderId: nullableStringMetadata(row.metadata, "folderId"),
    ownerActorId: row.owner_actor_id,
    app: stringMetadata(row.metadata, "app") ?? null,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    storageKey: row.storage_key,
    versionNumber: row.version_number ?? undefined,
    ...(row.preview === undefined ? {} : { preview: row.preview }),
    ...(uploadState === undefined
      ? {}
      : {
          uploadState,
          uploadStatusLabel: userFacing?.label,
          available:
            userFacing !== undefined ? userFacing.available : isDriveFileAvailable(uploadState),
        }),
    metadata,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface MapDriveAccessGrantInput {
  readonly actor_id: string;
  readonly role: string;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly granted_by_actor_id: string | null;
  readonly expires_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export function mapDriveAccessGrant(row: MapDriveAccessGrantInput): DriveAccessGrantRecord {
  return {
    actorId: row.actor_id,
    role: row.role,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.email === null ? {} : { email: row.email }),
    grantedByActorId: row.granted_by_actor_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface MapVersionInput {
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

export function mapVersion(row: MapVersionInput): DriveVersionRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    objectId: row.object_id,
    versionNumber: row.version_number,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    metadata: row.metadata,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at,
  };
}

export interface MapSearchHitInput {
  readonly id: string;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: number;
  readonly sha256: string | null;
  readonly metadata: JsonObject;
  readonly updated_at: Date;
  readonly previewMetadata?: DrivePreview;
}

export function mapSearchHit(row: MapSearchHitInput): DriveSearchHit {
  const name = stringMetadata(row.metadata, "name") ?? row.storage_key;
  return {
    objectId: row.id,
    name,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    folderId: nullableStringMetadata(row.metadata, "folderId"),
    preview: `${name} ${row.mime_type}`.slice(0, 240),
    ...(row.previewMetadata === undefined ? {} : { previewMetadata: row.previewMetadata }),
    updatedAt: row.updated_at,
  };
}
