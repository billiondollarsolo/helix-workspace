import type { JsonObject } from "@helix/sdk-types";
import { createHash } from "node:crypto";
import type { DriveEntryRecord } from "../types.js";
import { S3Error } from "./errors.js";
import type { SigV4Headers } from "./sigv4.js";

/**
 * S3 view of Drive object metadata. Drive identifies content by SHA-256; S3
 * clients expect an MD5-shaped ETag for single-part objects (rclone and the
 * MinIO client compare it with their local MD5). The gateway records the MD5
 * (or the multipart ETag) it computed at upload time under `metadata.s3`,
 * bound to the SHA-256 it describes. When the file later changes through
 * another Drive channel, the binding no longer matches and the ETag falls back
 * to a stable SHA-256-derived value with a `-1` suffix, which clients treat as
 * opaque rather than as an MD5 to verify.
 */
export const EMPTY_MD5_ETAG = '"d41d8cd98f00b204e9800998ecf8427e"';
const MAX_USER_METADATA_BYTES = 2048;
const USER_METADATA_PREFIX = "x-amz-meta-";

interface DriveS3Metadata {
  readonly sha256: string;
  readonly etag: string;
  readonly userMetadata: Readonly<Record<string, string>>;
}

function readS3Metadata(entry: DriveEntryRecord): DriveS3Metadata | undefined {
  const value = entry.metadata.s3;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as JsonObject;
  const userMetadata: Record<string, string> = {};
  const rawUser = record.userMetadata;
  if (typeof rawUser === "object" && rawUser !== null && !Array.isArray(rawUser)) {
    for (const [name, entryValue] of Object.entries(rawUser)) {
      if (typeof entryValue === "string") userMetadata[name] = entryValue;
    }
  }
  return typeof record.sha256 === "string" && typeof record.etag === "string"
    ? { sha256: record.sha256, etag: record.etag, userMetadata }
    : undefined;
}

/** The S3 ETag (quoted) for a Drive file. */
export function driveS3Etag(entry: DriveEntryRecord): string {
  const sha256 = entry.sha256 ?? null;
  if (sha256 === null) return EMPTY_MD5_ETAG;
  const recorded = readS3Metadata(entry);
  if (recorded !== undefined && recorded.sha256 === sha256) return `"${recorded.etag}"`;
  return `"${sha256.slice(0, 32)}-1"`;
}

/** `x-amz-meta-*` values recorded for the current content, if any. */
export function driveS3UserMetadata(entry: DriveEntryRecord): Readonly<Record<string, string>> {
  const recorded = readS3Metadata(entry);
  return recorded !== undefined && recorded.sha256 === entry.sha256 ? recorded.userMetadata : {};
}

export function driveS3UploadMetadata(input: {
  readonly sha256: string;
  readonly etag: string;
  readonly userMetadata: Readonly<Record<string, string>>;
}): JsonObject {
  return {
    source: "s3",
    s3: { sha256: input.sha256, etag: input.etag, userMetadata: { ...input.userMetadata } },
  };
}

/** Reads `x-amz-meta-*` headers, bounded like S3 (2 KiB in total). */
export function userMetadataFromHeaders(headers: SigV4Headers): Record<string, string> {
  const metadata: Record<string, string> = {};
  let size = 0;
  for (const [name, raw] of Object.entries(headers)) {
    if (!name.startsWith(USER_METADATA_PREFIX) || raw === undefined) continue;
    const key = name.slice(USER_METADATA_PREFIX.length);
    const value = Array.isArray(raw) ? raw.join(",") : raw;
    size += Buffer.byteLength(key) + Buffer.byteLength(value);
    metadata[key] = value;
  }
  if (size > MAX_USER_METADATA_BYTES) {
    throw new S3Error("InvalidArgument", "User-defined metadata must not exceed 2 KB.");
  }
  return metadata;
}

/** S3's multipart ETag: MD5 of the concatenated binary part MD5s, then `-<parts>`. */
export function multipartEtag(partMd5Hex: readonly string[]): string {
  const hash = createHash("md5");
  for (const md5 of partMd5Hex) hash.update(Buffer.from(md5, "hex"));
  return `${hash.digest("hex")}-${String(partMd5Hex.length)}`;
}
