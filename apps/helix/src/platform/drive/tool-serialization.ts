import type {
  DriveUploadRecord,
  DriveVersionRecord,
  DriveUploadStatusRecord,
  DriveEntryRecord,
} from "./types.js";

export function serializeUpload(record: DriveUploadRecord) {
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}
export function serializeVersion(version: DriveVersionRecord) {
  return {
    ...version,
    createdAt: version.createdAt.toISOString(),
  };
}
export function serializeUploadStatus(status: DriveUploadStatusRecord) {
  return {
    ...status,
    updatedAt: status.updatedAt.toISOString(),
  };
}
export function serializeEntry({ trashPurgeAfter, ...entry }: DriveEntryRecord) {
  return {
    ...entry,
    deletedAt: entry.deletedAt?.toISOString() ?? null,
    ...(trashPurgeAfter === undefined
      ? {}
      : { trashPurgeAfter: trashPurgeAfter?.toISOString() ?? null }),
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}
