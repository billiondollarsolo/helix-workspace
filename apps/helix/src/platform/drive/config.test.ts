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

  it("requires the isolated converter in production", () => {
    expect(() => loadDriveConfig(loadEnv({ ...base, NODE_ENV: "production" }))).toThrow(
      "Production requires HELIX_DRIVE_OFFICE_PREVIEW_URL",
    );
    const cfg = loadDriveConfig(
      loadEnv({
        ...base,
        NODE_ENV: "production",
        HELIX_DRIVE_OFFICE_PREVIEW_URL: "http://drive-preview:3000",
        RUSTFS_ENDPOINT: "https://storage.example.com",
        RUSTFS_SECRET_KEY: "random-production-storage-secret",
        RUSTFS_SERVER_SIDE_ENCRYPTION: "aws:kms",
        RUSTFS_SSE_KMS_KEY_ID: "arn:aws:kms:us-east-1:123:key/storage",
        RUSTFS_OBJECT_LOCK_MODE: "compliance",
        RUSTFS_OBJECT_LOCK_RETENTION_DAYS: "30",
      }),
    );
    expect(cfg.officePreview.timeoutMs).toBe(10_000);
    expect(cfg.officePreview.url).toBe("http://drive-preview:3000");
    expect(cfg.isProduction).toBe(true);
  });

  it("does not create an API-process converter outside production", () => {
    const cfg = loadDriveConfig(loadEnv({ ...base, NODE_ENV: "development" }));
    expect(cfg.officePreview.url).toBeUndefined();
  });

  it("parses allowed hosts for the office-preview SSRF allowlist", () => {
    const cfg = loadDriveConfig(
      loadEnv({
        ...base,
        HELIX_DRIVE_OFFICE_PREVIEW_ALLOWED_HOSTS: "office.internal, preview.helix.local",
      }),
    );
    expect(cfg.officePreview.allowedHosts).toEqual(["office.internal", "preview.helix.local"]);
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
});
