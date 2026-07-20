import { driveBlobKey } from "./storage-key.js";

/**
 * Pure helpers for content-addressed Drive blob dedup (G5).
 *
 * Two storage keys are in play when dedup is on:
 * - reservedKey: per-object key written by prepare/presign/multipart
 * - blobKey: drive/{org}/blobs/{sha256} shared across versions/objects
 */

export function isDriveBlobStorageKey(storageKey: string): boolean {
  return /^drive\/[^/]+\/blobs\/[a-f0-9]{64}$/iu.test(storageKey);
}

export function resolveFinalizeStorageKey(input: {
  readonly dedup: boolean;
  readonly orgId: string;
  readonly sha256: string;
  readonly reservedKey: string;
}): string {
  if (!input.dedup) return input.reservedKey;
  return driveBlobKey(input.orgId, input.sha256);
}

/**
 * Whether finalize must write bytes to the blob key.
 * - First ref (inserted=true): always need bytes at the blob key.
 * - Subsequent refs: never write (share existing blob).
 */
export function shouldWriteBlobBytes(input: {
  readonly dedup: boolean;
  readonly blobRowInserted: boolean;
}): boolean {
  if (!input.dedup) return false;
  return input.blobRowInserted;
}

/**
 * After a blob ref is removed, whether the underlying storage object may be deleted.
 */
export function shouldDeleteBlobStorage(refcountAfterDecrement: number): boolean {
  return refcountAfterDecrement <= 0;
}

/**
 * Source of bytes for a first-time blob write:
 * - inline content when present
 * - otherwise the reserved object key (presigned PUT / multipart complete target)
 */
export type BlobByteSource =
  | { readonly kind: "inline"; readonly content: Uint8Array }
  | { readonly kind: "reserved"; readonly reservedKey: string }
  | { readonly kind: "missing" };

export function resolveBlobByteSource(input: {
  readonly content: Uint8Array | undefined;
  readonly reservedKey: string;
}): BlobByteSource {
  if (input.content !== undefined) {
    return { kind: "inline", content: input.content };
  }
  if (input.reservedKey.length > 0) {
    return { kind: "reserved", reservedKey: input.reservedKey };
  }
  return { kind: "missing" };
}
