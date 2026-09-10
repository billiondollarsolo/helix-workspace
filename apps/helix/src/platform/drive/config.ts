import { env, type Env } from "../../config/env.js";
interface DriveStorageConfig {
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
  readonly malwareScanner:
    | {
        readonly kind: "clamav";
        readonly host: string;
        readonly port: number;
        readonly timeoutMs?: number;
        readonly maxBytes?: number;
        readonly chunkSizeBytes?: number;
        readonly scannerVersion?: string;
      }
    | undefined;
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
  readonly gc: {
    readonly enabled: boolean;
    readonly intervalMs: number;
    readonly orphanGraceHours: number;
    readonly batchSize: number;
  };
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
function parsePositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
/** Pure derivation of Drive operational config from the validated env module. */
export function loadDriveConfig(e: Env = env()): DriveConfig {
  const isProduction = e.NODE_ENV === "production";
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
    if ((lockMode !== "GOVERNANCE" && lockMode !== "COMPLIANCE") || retentionDays === undefined) {
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
  if (serverSideEncryption === "aws:kms" && e.RUSTFS_SSE_KMS_KEY_ID === undefined) {
    throw new Error("RUSTFS_SSE_KMS_KEY_ID is required when Drive storage uses aws:kms.");
  }
  if (serverSideEncryption !== "aws:kms" && e.RUSTFS_SSE_KMS_KEY_ID !== undefined) {
    throw new Error("RUSTFS_SSE_KMS_KEY_ID requires RUSTFS_SERVER_SIDE_ENCRYPTION=aws:kms.");
  }
  const scannerEnabled = coerceBool(e.DRIVE_CLAMAV_ENABLED, false);
  const scannerTimeoutMs = parsePositiveInteger(e.DRIVE_CLAMAV_TIMEOUT_MS);
  const scannerMaxBytes = parsePositiveInteger(e.DRIVE_CLAMAV_MAX_BYTES);
  const scannerChunkSizeBytes = parsePositiveInteger(e.DRIVE_CLAMAV_CHUNK_SIZE_BYTES);
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
    malwareScanner: scannerEnabled
      ? {
          kind: "clamav",
          host: e.DRIVE_CLAMAV_HOST ?? "clamav",
          port: parsePositiveInteger(e.DRIVE_CLAMAV_PORT) ?? 3310,
          ...(scannerTimeoutMs === undefined ? {} : { timeoutMs: scannerTimeoutMs }),
          ...(scannerMaxBytes === undefined ? {} : { maxBytes: scannerMaxBytes }),
          ...(scannerChunkSizeBytes === undefined ? {} : { chunkSizeBytes: scannerChunkSizeBytes }),
          ...(e.DRIVE_CLAMAV_SCANNER_VERSION === undefined
            ? {}
            : { scannerVersion: e.DRIVE_CLAMAV_SCANNER_VERSION }),
        }
      : undefined,
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
    gc: {
      enabled: coerceBool(e.HELIX_DRIVE_GC_ENABLED, isProduction),
      intervalMs: e.HELIX_DRIVE_GC_INTERVAL_MS,
      orphanGraceHours: e.HELIX_DRIVE_GC_ORPHAN_GRACE_HOURS,
      batchSize: e.HELIX_DRIVE_GC_BATCH_SIZE,
    },
    ...(e.HELIX_CHROMIUM_PATH === undefined ? {} : { chromiumPath: e.HELIX_CHROMIUM_PATH }),
    isProduction,
  };
}
