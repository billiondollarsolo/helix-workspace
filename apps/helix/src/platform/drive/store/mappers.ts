import {
  bytesFromDatabase,
  mapDriveAccessGrant as mapDriveAccessGrantCore,
  mapObjectEntry as mapObjectEntryCore,
  mapSearchHit as mapSearchHitCore,
  mapVersion as mapVersionCore,
  nullableStringMetadata,
  stringMetadata,
} from "../core/mappers.js";
import { DriveNotFoundError } from "../errors.js";
import type {
  DriveAccessGrantRecord,
  DriveCommentListItem,
  DriveCommentRecord,
  DriveCommentRevisionRecord,
  DriveEntryRecord,
  DriveSearchHit,
  DriveSearchRecord,
  DriveUploadRecord,
  DriveVersionRecord,
} from "../types.js";
import { driveUploadStateFromMetadata } from "../upload-state.js";
import {
  metadataClassificationProperty,
  metadataStringArrayProperty,
  metadataStringProperty,
} from "./metadata.js";
import {
  type DriveAccessGrantRow,
  type DriveCommentProjectionRow,
  type DriveCommentRevisionRow,
  type DriveCommentRow,
  type DriveFolderRow,
  type DriveListRow,
  type DriveSearchProjectionRow,
  type DriveSearchRow,
  type DriveVersionRow,
  type ObjectRow,
} from "./rows.js";
export function mapUpload(
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
    status: driveUploadStateFromMetadata(metadata.status, row.deleted_at),
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapVersion(row: DriveVersionRow | undefined): DriveVersionRecord {
  if (row === undefined) {
    throw new DriveNotFoundError("Expected Drive version row.");
  }
  return mapVersionCore(row);
}

export function mapFolderEntry(row: DriveFolderRow): DriveEntryRecord {
  return {
    id: row.id,
    type: "folder",
    name: row.name,
    folderId: row.parent_folder_id,
    ownerActorId: row.owner_actor_id,
    metadata: row.metadata,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapDriveListEntry(row: DriveListRow): DriveEntryRecord {
  if (row.entry_type === "folder") {
    return {
      id: row.id,
      type: "folder",
      name: row.name,
      folderId: row.folder_id,
      ownerActorId: row.owner_actor_id,
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

export function missingFolderRow(): DriveFolderRow {
  throw new Error("Expected Drive folder row.");
}

export function mapObjectEntry(row: DriveSearchRow): DriveEntryRecord {
  return mapObjectEntryCore({
    upload_state: driveUploadStateFromMetadata(row.metadata.status, row.deleted_at),
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
  });
}

export function mapDriveAccessGrant(row: DriveAccessGrantRow): DriveAccessGrantRecord {
  return mapDriveAccessGrantCore(row);
}

export function mapSearchHit(row: DriveSearchRow): DriveSearchHit {
  return mapSearchHitCore({
    id: row.id,
    storage_key: row.storage_key,
    mime_type: row.mime_type,
    byte_size: row.byte_size,
    sha256: row.sha256,
    metadata: row.metadata,
    updated_at: row.updated_at,
  });
}

export function mapDriveComment(row: DriveCommentRow | undefined): DriveCommentRecord {
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

export function mapDriveCommentListItem(row: DriveCommentProjectionRow): DriveCommentListItem {
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

export function mapDriveCommentRevision(row: DriveCommentRevisionRow): DriveCommentRevisionRecord {
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

export function mapDriveSearchRecord(row: DriveSearchProjectionRow): DriveSearchRecord {
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

export function numberFromBigIntLike(value: string | number | null): number | null {
  return value === null ? null : bytesFromDatabase(value);
}
