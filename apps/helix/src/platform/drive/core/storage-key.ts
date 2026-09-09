/** Build the versioned Drive object storage key with a sanitized filename. */
export function driveStorageKey(
  orgId: string,
  objectId: string,
  versionNumber: number,
  name: string,
): string {
  const safeName = name.replaceAll(/[^A-Za-z0-9._-]/g, "_").slice(0, 180) || "upload";
  return `drive/${orgId}/${objectId}/v${String(versionNumber)}/${safeName}`;
}

/** Content-addressed blob key (used when dedup is enabled). */
export function driveBlobKey(orgId: string, sha256: string): string {
  return `drive/${orgId}/blobs/${sha256}`;
}

/** Private, lifecycle-managed namespace for bytes rejected by antivirus. */
export function driveQuarantineStorageKey(orgId: string, objectId: string, sha256: string): string {
  return `drive-quarantine/${orgId}/${objectId}/${sha256}`;
}
