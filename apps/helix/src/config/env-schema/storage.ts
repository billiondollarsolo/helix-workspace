import { z } from "zod";
import { optionalPositiveInt, optionalString, optionalUrl } from "./common.js";
export const storageEnv = {
  RUSTFS_ENDPOINT: optionalUrl,
  RUSTFS_API_PORT: optionalString,
  RUSTFS_ACCESS_KEY: z.string().default("helixrustfs"),
  RUSTFS_SECRET_KEY: z.string().default("helix_rustfs_dev_secret"),
  RUSTFS_BUCKET: z.string().default("helix-objects"),
  RUSTFS_REGION: z.string().default("us-east-1"),
  RUSTFS_SERVER_SIDE_ENCRYPTION: optionalString,
  RUSTFS_SSE_KMS_KEY_ID: optionalString,
  RUSTFS_OBJECT_LOCK_MODE: optionalString,
  RUSTFS_OBJECT_LOCK_RETENTION_DAYS: optionalPositiveInt,
  DRIVE_AUTO_TAG_ENRICHMENT: optionalString,
  DRIVE_CLAMAV_ENABLED: optionalString,
  DRIVE_CLAMAV_HOST: optionalString,
  DRIVE_CLAMAV_PORT: optionalString,
  DRIVE_CLAMAV_TIMEOUT_MS: optionalString,
  DRIVE_CLAMAV_MAX_BYTES: optionalString,
  DRIVE_CLAMAV_CHUNK_SIZE_BYTES: optionalString,
  DRIVE_CLAMAV_SCANNER_VERSION: optionalString,
};
