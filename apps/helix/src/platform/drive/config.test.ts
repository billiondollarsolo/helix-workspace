import { describe, expect, it } from "vitest";
import { loadEnv } from "../../config/env.js";
import { loadDriveConfig } from "./config.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/h",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadDriveConfig", () => {
  it("derives the RustFS endpoint from RUSTFS_API_PORT when RUSTFS_ENDPOINT is unset", () => {
    const cfg = loadDriveConfig(loadEnv({ ...base, RUSTFS_API_PORT: "28437" }));
    expect(cfg.storage.endpoint).toBe("http://localhost:28437");
  });

  it("supports production storage without a converter", () => {
    const cfg = loadDriveConfig(
      loadEnv({
        ...base,
        NODE_ENV: "production",
        RUSTFS_ENDPOINT: "https://storage.example.com",
        RUSTFS_SECRET_KEY: "random-production-storage-secret",
        RUSTFS_SERVER_SIDE_ENCRYPTION: "aws:kms",
        RUSTFS_SSE_KMS_KEY_ID: "arn:aws:kms:us-east-1:123:key/storage",
        RUSTFS_OBJECT_LOCK_MODE: "compliance",
        RUSTFS_OBJECT_LOCK_RETENTION_DAYS: "30",
      }),
    );
    expect(cfg.isProduction).toBe(true);
  });

  it("defaults content-addressed dedup off and enables via HELIX_DRIVE_CONTENT_DEDUP", () => {
    expect(loadDriveConfig(loadEnv(base)).contentAddressedDedup).toBe(false);
    expect(
      loadDriveConfig(loadEnv({ ...base, HELIX_DRIVE_CONTENT_DEDUP: "true" }))
        .contentAddressedDedup,
    ).toBe(true);
  });

  it("loads bounded antivirus freshness, archive, and retry policy", () => {
    const cfg = loadDriveConfig(
      loadEnv({
        ...base,
        HELIX_AV_MAX_SIGNATURE_AGE_MS: "3600000",
        HELIX_DRIVE_ARCHIVE_MAX_ENTRIES: "50",
        HELIX_DRIVE_SCAN_MAX_ATTEMPTS: "3",
        HELIX_DRIVE_SCAN_RETRY_BATCH_SIZE: "9",
      }),
    );
    expect(cfg.antivirus).toMatchObject({
      maxSignatureAgeMs: 3_600_000,
      archiveMaxEntries: 50,
      maxAttempts: 3,
      retryBatchSize: 9,
    });
  });

  it("keeps the real malware scanner disabled unless explicitly configured", () => {
    expect(loadDriveConfig(loadEnv(base)).malwareScanner).toBeUndefined();
  });

  it("requires a KMS key with aws:kms and enables bounded production GC", () => {
    expect(() =>
      loadDriveConfig(loadEnv({ ...base, RUSTFS_SERVER_SIDE_ENCRYPTION: "aws:kms" })),
    ).toThrow(/RUSTFS_SSE_KMS_KEY_ID/u);
    const cfg = loadDriveConfig(
      loadEnv({
        ...base,
        NODE_ENV: "production",
        RUSTFS_SERVER_SIDE_ENCRYPTION: "aws:kms",
        RUSTFS_SSE_KMS_KEY_ID: "kms-default",
        RUSTFS_SECRET_KEY: "random-production-storage-secret",
        HELIX_DRIVE_OFFICE_PREVIEW_URL: "http://drive-preview:3000",
        RUSTFS_ENDPOINT: "https://storage.example.com",
        RUSTFS_OBJECT_LOCK_MODE: "compliance",
        RUSTFS_OBJECT_LOCK_RETENTION_DAYS: "30",
      }),
    );
    expect(cfg.storage.serverSideEncryptionAwsKmsKeyId).toBe("kms-default");
    expect(cfg.gc).toEqual({
      enabled: true,
      intervalMs: 3_600_000,
      orphanGraceHours: 24,
      batchSize: 100,
    });
  });

  it("parses a bounded ClamAV scanner configuration", () => {
    const cfg = loadDriveConfig(
      loadEnv({
        ...base,
        DRIVE_CLAMAV_ENABLED: "true",
        DRIVE_CLAMAV_HOST: "clamd.internal",
        DRIVE_CLAMAV_PORT: "3311",
        DRIVE_CLAMAV_TIMEOUT_MS: "15000",
        DRIVE_CLAMAV_MAX_BYTES: "52428800",
        DRIVE_CLAMAV_CHUNK_SIZE_BYTES: "65536",
        DRIVE_CLAMAV_SCANNER_VERSION: "1.4.3/27388",
      }),
    );

    expect(cfg.malwareScanner).toEqual({
      kind: "clamav",
      host: "clamd.internal",
      port: 3311,
      timeoutMs: 15_000,
      maxBytes: 52_428_800,
      chunkSizeBytes: 65_536,
      scannerVersion: "1.4.3/27388",
    });
  });
});
