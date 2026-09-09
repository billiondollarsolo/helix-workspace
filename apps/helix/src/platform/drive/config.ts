import { env, type Env } from "../../config/env.js";

export interface DriveStorageConfig {
  readonly endpoint?: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly serverSideEncryption?: "AES256" | "aws:kms";
  readonly serverSideEncryptionAwsKmsKeyId?: string;
  readonly securityPolicy?: {
    readonly requireTls: boolean;
    readonly requireVersioning: boolean;
    readonly objectLock: {
      readonly mode: "COMPLIANCE" | "GOVERNANCE";
      readonly retentionDays: number;
    };
  };
  readonly forcePathStyle: boolean;
}

export interface DriveConfig {
  readonly storage: DriveStorageConfig;
  readonly officePreview: {
    readonly url?: string;
    readonly timeoutMs: number;
    readonly allowedHosts: readonly string[];
  };
  readonly autoTagEnrichment: boolean;
  /** Optional content-addressed blob dedup (dark-shippable; default false). */
  readonly contentAddressedDedup: boolean;
  readonly multipartThresholdBytes: number;
  readonly multipartPartSizeBytes: number;
  readonly antivirus: {
    readonly maxSignatureAgeMs: number;
    readonly maxFileBytes: number;
    readonly archiveMaxEntries: number;
    readonly archiveMaxUncompressedBytes: number;
    readonly archiveMaxExpansionRatio: number;
    readonly archiveMaxNested: number;
    readonly maxAttempts: number;
    readonly retryDelayMs: number;
    readonly retryIntervalMs: number;
    readonly retryBatchSize: number;
    readonly leaseMs: number;
  };
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

function parseObjectLockMode(value: string | undefined): "COMPLIANCE" | "GOVERNANCE" | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized === "COMPLIANCE" || normalized === "GOVERNANCE" ? normalized : undefined;
}

/** Pure derivation of Drive operational config from the validated env module. */
export function loadDriveConfig(e: Env = env()): DriveConfig {
  const isProduction = e.NODE_ENV === "production";
  if (isProduction && e.HELIX_DRIVE_OFFICE_PREVIEW_URL === undefined) {
    throw new Error("Production requires HELIX_DRIVE_OFFICE_PREVIEW_URL for isolated conversion.");
  }
  const endpoint =
    e.RUSTFS_ENDPOINT ??
    (e.RUSTFS_API_PORT === undefined ? undefined : `http://localhost:${e.RUSTFS_API_PORT}`);
  const serverSideEncryption = parseServerSideEncryption(e.RUSTFS_SERVER_SIDE_ENCRYPTION);
  const lockMode = parseObjectLockMode(e.RUSTFS_OBJECT_LOCK_MODE);
  const retentionDays = e.RUSTFS_OBJECT_LOCK_RETENTION_DAYS;
  if (isProduction) {
    if (endpoint === undefined || new URL(endpoint).protocol !== "https:") {
      throw new Error("Production object storage requires an HTTPS RUSTFS_ENDPOINT.");
    }
    if (serverSideEncryption !== "aws:kms" || e.RUSTFS_SSE_KMS_KEY_ID === undefined) {
      throw new Error("Production object storage requires SSE-KMS and RUSTFS_SSE_KMS_KEY_ID.");
    }
    if (
      (lockMode !== "GOVERNANCE" && lockMode !== "COMPLIANCE") ||
      retentionDays === undefined
    ) {
      throw new Error("Production object storage requires object lock mode and retention days.");
    }
  }
  const securityPolicy =
    lockMode === "GOVERNANCE" || lockMode === "COMPLIANCE"
      ? retentionDays === undefined
        ? undefined
        : {
          requireTls: isProduction,
          requireVersioning: true,
          objectLock: { mode: lockMode, retentionDays },
        }
      : undefined;
  return {
    storage: {
      ...(endpoint === undefined ? {} : { endpoint }),
      region: e.RUSTFS_REGION,
      bucket: e.RUSTFS_BUCKET,
      accessKeyId: e.RUSTFS_ACCESS_KEY,
      secretAccessKey: e.RUSTFS_SECRET_KEY,
      ...(serverSideEncryption === undefined ? {} : { serverSideEncryption }),
      ...(e.RUSTFS_SSE_KMS_KEY_ID === undefined
        ? {}
        : { serverSideEncryptionAwsKmsKeyId: e.RUSTFS_SSE_KMS_KEY_ID }),
      ...(securityPolicy === undefined ? {} : { securityPolicy }),
      forcePathStyle: true,
    },
    officePreview: {
      ...(e.HELIX_DRIVE_OFFICE_PREVIEW_URL === undefined
        ? {}
        : { url: e.HELIX_DRIVE_OFFICE_PREVIEW_URL }),
      timeoutMs: e.HELIX_DRIVE_OFFICE_PREVIEW_TIMEOUT_MS,
      allowedHosts: parseAllowedHosts(e.HELIX_DRIVE_OFFICE_PREVIEW_ALLOWED_HOSTS),
    },
    autoTagEnrichment: coerceBool(e.DRIVE_AUTO_TAG_ENRICHMENT, true),
    contentAddressedDedup: coerceBool(e.HELIX_DRIVE_CONTENT_DEDUP, false),
    multipartThresholdBytes: e.HELIX_DRIVE_MULTIPART_THRESHOLD_BYTES,
    multipartPartSizeBytes: e.HELIX_DRIVE_MULTIPART_PART_SIZE_BYTES,
    antivirus: {
      maxSignatureAgeMs: e.HELIX_AV_MAX_SIGNATURE_AGE_MS,
      maxFileBytes: e.HELIX_DRIVE_AV_MAX_FILE_BYTES,
      archiveMaxEntries: e.HELIX_DRIVE_ARCHIVE_MAX_ENTRIES,
      archiveMaxUncompressedBytes: e.HELIX_DRIVE_ARCHIVE_MAX_UNCOMPRESSED_BYTES,
      archiveMaxExpansionRatio: e.HELIX_DRIVE_ARCHIVE_MAX_EXPANSION_RATIO,
      archiveMaxNested: e.HELIX_DRIVE_ARCHIVE_MAX_NESTED,
      maxAttempts: e.HELIX_DRIVE_SCAN_MAX_ATTEMPTS,
      retryDelayMs: e.HELIX_DRIVE_SCAN_RETRY_DELAY_MS,
      retryIntervalMs: e.HELIX_DRIVE_SCAN_RETRY_INTERVAL_MS,
      retryBatchSize: e.HELIX_DRIVE_SCAN_RETRY_BATCH_SIZE,
      leaseMs: e.HELIX_DRIVE_SCAN_LEASE_MS,
    },
    isProduction,
  };
}
