import { env, type Env } from "../../config/env.js";

export interface DriveStorageConfig {
  readonly endpoint?: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly serverSideEncryption?: "AES256" | "aws:kms";
  readonly forcePathStyle: boolean;
}

export interface DriveConfig {
  readonly storage: DriveStorageConfig;
  readonly officePreview: {
    readonly url?: string;
    readonly localFallback: boolean;
    readonly timeoutMs: number;
    readonly allowedHosts: readonly string[];
  };
  readonly bodyLimitBytes: number;
  readonly autoTagEnrichment: boolean;
  /** Optional content-addressed blob dedup (dark-shippable; default false). */
  readonly contentAddressedDedup: boolean;
  readonly multipartThresholdBytes: number;
  readonly multipartPartSizeBytes: number;
  readonly chromiumPath?: string;
  readonly isProduction: boolean;
}

function coerceBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return defaultValue;
}

function parseAllowedHosts(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  return raw
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

function parseServerSideEncryption(value: string | undefined): "AES256" | "aws:kms" | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  if (value === "AES256" || value === "aws:kms") {
    return value;
  }
  return undefined;
}

/** Pure derivation of Drive operational config from the validated env module. */
export function loadDriveConfig(e: Env = env()): DriveConfig {
  const isProduction = e.NODE_ENV === "production";
  const endpoint =
    e.RUSTFS_ENDPOINT ??
    (e.RUSTFS_API_PORT === undefined ? undefined : `http://localhost:${e.RUSTFS_API_PORT}`);
  const serverSideEncryption = parseServerSideEncryption(e.RUSTFS_SERVER_SIDE_ENCRYPTION);
  return {
    storage: {
      ...(endpoint === undefined ? {} : { endpoint }),
      region: e.RUSTFS_REGION,
      bucket: e.RUSTFS_BUCKET,
      accessKeyId: e.RUSTFS_ACCESS_KEY,
      secretAccessKey: e.RUSTFS_SECRET_KEY,
      ...(serverSideEncryption === undefined ? {} : { serverSideEncryption }),
      forcePathStyle: true,
    },
    officePreview: {
      ...(e.HELIX_DRIVE_OFFICE_PREVIEW_URL === undefined
        ? {}
        : { url: e.HELIX_DRIVE_OFFICE_PREVIEW_URL }),
      localFallback: coerceBool(e.HELIX_DRIVE_LOCAL_OFFICE_PREVIEW, !isProduction),
      timeoutMs: e.HELIX_DRIVE_OFFICE_PREVIEW_TIMEOUT_MS,
      allowedHosts: parseAllowedHosts(e.HELIX_DRIVE_OFFICE_PREVIEW_ALLOWED_HOSTS),
    },
    bodyLimitBytes: e.HELIX_BODY_LIMIT_BYTES,
    autoTagEnrichment: coerceBool(e.DRIVE_AUTO_TAG_ENRICHMENT, true),
    contentAddressedDedup: coerceBool(e.HELIX_DRIVE_CONTENT_DEDUP, false),
    multipartThresholdBytes: e.HELIX_DRIVE_MULTIPART_THRESHOLD_BYTES,
    multipartPartSizeBytes: e.HELIX_DRIVE_MULTIPART_PART_SIZE_BYTES,
    ...(e.HELIX_CHROMIUM_PATH === undefined ? {} : { chromiumPath: e.HELIX_CHROMIUM_PATH }),
    isProduction,
  };
}
