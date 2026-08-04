import { DriveInvalidStorageKeyError } from "../errors.js";

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

/** C0 controls plus DEL — never legal in a Drive storage key. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

/**
 * Ensures a finalize-time storageKey matches the reserved object key and is not
 * a path-traversal / absolute / scheme-qualified value.
 *
 * Accepts either the reserved per-object key (default path) or a content-addressed
 * blob key (`drive/{org}/blobs/{sha256}`) when dedup is enabled.
 */
export function assertFinalizeStorageKey(storageKey: string, currentStorageKey: string): void {
  const isBlobKey = /^drive\/[^/]+\/blobs\/[a-f0-9]{64}$/iu.test(storageKey);
  const matchesReserved = storageKey === currentStorageKey;
  if (
    (!matchesReserved && !isBlobKey) ||
    storageKey.startsWith("/") ||
    storageKey.includes("..") ||
    storageKey.includes("\\") ||
    storageKey.includes("//") ||
    storageKey.startsWith("tenants/") ||
    hasControlCharacter(storageKey) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(storageKey)
  ) {
    throw new DriveInvalidStorageKeyError(
      "Drive upload storageKey must be a logical Drive object key.",
    );
  }
}

/** @deprecated Use {@link assertFinalizeStorageKey}. */
export const assertProvidedFinalizeStorageKey = assertFinalizeStorageKey;
