import type { DriveRootView } from "../path-resolution.js";
import { hasControlCharacter } from "../../util/strings.js";
import { S3Error } from "./errors.js";

/**
 * S3 buckets are fixed, DNS-safe names for the Drive roots an actor can see.
 * They are not storage buckets: each one is a view over the same Drive tree
 * the web app shows, filtered by the actor's own Drive permissions.
 *
 * - `my-drive`: the actor's My Drive root (files and folders they own).
 * - `shared-with-me`: items other people shared with the actor. The root is
 *   read-only; folders shared with edit access accept writes.
 *
 * A tenant-qualified alias `<org-slug>--<bucket>` names the same bucket and is
 * refused with AccessDenied for any other organization, so a misconfigured
 * client cannot silently write into the wrong tenant.
 */
export type DriveS3BucketName = "my-drive" | "shared-with-me";

export interface DriveS3Bucket {
  readonly name: DriveS3BucketName;
  readonly view: DriveRootView;
  readonly rootWritable: boolean;
}

export const DRIVE_S3_BUCKETS = {
  "my-drive": { name: "my-drive", view: "owned", rootWritable: true },
  "shared-with-me": { name: "shared-with-me", view: "shared", rootWritable: false },
} as const satisfies Record<DriveS3BucketName, DriveS3Bucket>;

const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const TENANT_SEPARATOR = "--";
/** S3's own key-length limit. */
const MAX_KEY_BYTES = 1024;
const MAX_SEGMENT_LENGTH = 255;

function isBucketName(value: string): value is DriveS3BucketName {
  return Object.hasOwn(DRIVE_S3_BUCKETS, value);
}

export function resolveDriveS3Bucket(name: string, orgSlug: string | undefined): DriveS3Bucket {
  if (!BUCKET_NAME_RE.test(name)) {
    throw new S3Error("InvalidBucketName", "The specified bucket is not valid.");
  }
  if (isBucketName(name)) return DRIVE_S3_BUCKETS[name];
  const separator = name.lastIndexOf(TENANT_SEPARATOR);
  const base = separator < 0 ? "" : name.slice(separator + TENANT_SEPARATOR.length);
  if (isBucketName(base)) {
    if (orgSlug !== undefined && name.slice(0, separator) === orgSlug) {
      return DRIVE_S3_BUCKETS[base];
    }
    throw new S3Error(
      "AccessDenied",
      "This bucket belongs to another organization. Access keys only reach their own organization's Drive.",
    );
  }
  throw new S3Error(
    "NoSuchBucket",
    `The specified bucket does not exist. Helix Drive buckets are: ${Object.keys(DRIVE_S3_BUCKETS).join(", ")}.`,
  );
}

export interface DriveS3ObjectKey {
  readonly key: string;
  /** Folder segments followed by the object name; empty for a bucket-root marker. */
  readonly segments: readonly string[];
  /** True for `folder/` directory-marker keys. */
  readonly directory: boolean;
}

export function parseDriveS3Key(key: string): DriveS3ObjectKey {
  if (Buffer.byteLength(key, "utf8") > MAX_KEY_BYTES) {
    throw new S3Error("KeyTooLongError", "Your key is too long (maximum 1024 bytes).");
  }
  const directory = key.endsWith("/");
  const segments = (directory ? key.slice(0, -1) : key).split("/");
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      segment.length > MAX_SEGMENT_LENGTH ||
      hasControlCharacter(segment)
    ) {
      throw new S3Error(
        "InvalidObjectName",
        "Object keys map to Drive paths: use '/'-separated names without empty, '.', '..', control-character, or over-255-character segments.",
      );
    }
  }
  return { key, segments, directory };
}

/** S3 lists keys in UTF-8 binary order. */
export function compareS3Keys(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
