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
      loadDriveConfig(loadEnv({ ...base, HELIX_DRIVE_CONTENT_DEDUP: "true" })).contentAddressedDedup,
    ).toBe(true);
  });
});
