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

  it("defaults office-preview timeout and local fallback off in production", () => {
    const cfg = loadDriveConfig(loadEnv({ ...base, NODE_ENV: "production" }));
    expect(cfg.officePreview.timeoutMs).toBe(10_000);
    expect(cfg.officePreview.localFallback).toBe(false);
    expect(cfg.isProduction).toBe(true);
  });

  it("enables local office preview by default outside production", () => {
    const cfg = loadDriveConfig(loadEnv({ ...base, NODE_ENV: "development" }));
    expect(cfg.officePreview.localFallback).toBe(true);
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
