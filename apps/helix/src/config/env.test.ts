import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/helix",
  REDIS_URL: "redis://localhost:6379",
};

describe("loadEnv", () => {
  it("parses a valid environment and applies defaults", () => {
    const env = loadEnv(base);
    expect(env.PORT).toBe(3000);
    expect(env.DATABASE_URL).toContain("postgres://");
    expect(env.HOST).toBe("0.0.0.0");
    expect(env.CHAT_PRESENCE_TTL_SECONDS).toBe(60);
    expect(env.CHAT_WS_RATE_LIMIT_CAPACITY).toBe(30);
    expect(env.CHAT_WS_RATE_LIMIT_REFILL_PER_SECOND).toBe(3);
  });

  it("accepts CHAT_PRESENCE_TTL_SECONDS override", () => {
    const env = loadEnv({ ...base, CHAT_PRESENCE_TTL_SECONDS: "45" });
    expect(env.CHAT_PRESENCE_TTL_SECONDS).toBe(45);
  });

  it("rejects a non-numeric CHAT_PRESENCE_TTL_SECONDS", () => {
    expect(() => loadEnv({ ...base, CHAT_PRESENCE_TTL_SECONDS: "nope" })).toThrow(
      /CHAT_PRESENCE_TTL_SECONDS/,
    );
  });

  it("fails fast with a readable message when DATABASE_URL is missing in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production", REDIS_URL: base.REDIS_URL })).toThrow(
      /DATABASE_URL/,
    );
  });

  it("rejects known development and placeholder credentials in production", () => {
    for (const environment of [
      {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://helix:change-me@postgres.internal:5432/helix",
      },
      {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://helix:strong@postgres.internal:5432/helix",
        BETTER_AUTH_SECRET: "helix_local_better_auth_secret_change_me_32_chars",
      },
      {
        NODE_ENV: "production",
        DATABASE_URL: "postgres://helix:strong@postgres.internal:5432/helix",
        RUSTFS_ENDPOINT: "https://s3.internal",
      },
    ]) {
      expect(() => loadEnv(environment)).toThrow(/placeholder credential is forbidden/u);
    }
  });

  it("accepts non-placeholder production credentials", () => {
    expect(
      loadEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://helix:strong-random-value@postgres.internal:5432/helix",
        BETTER_AUTH_SECRET: "random-production-auth-secret-with-ample-entropy",
        RUSTFS_ENDPOINT: "https://s3.internal",
        RUSTFS_SECRET_KEY: "random-production-storage-secret",
      }),
    ).toMatchObject({ NODE_ENV: "production", RUSTFS_ENDPOINT: "https://s3.internal" });
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => loadEnv({ ...base, PORT: "notaport" })).toThrow(/PORT/);
  });

  it("accepts empty REDIS_URL as undefined", () => {
    const env = loadEnv({ ...base, REDIS_URL: "" });
    expect(env.REDIS_URL).toBeUndefined();
  });

  it("normalizes an empty plugin trust path as undefined", () => {
    expect(
      loadEnv({ ...base, HELIX_PLUGIN_TRUST_FILE: "" }).HELIX_PLUGIN_TRUST_FILE,
    ).toBeUndefined();
    expect(
      loadEnv({ ...base, HELIX_PLUGIN_TRUST_FILE: "/run/helix/plugin-trust.json" }),
    ).toMatchObject({ HELIX_PLUGIN_TRUST_FILE: "/run/helix/plugin-trust.json" });
  });

  it("validates the outbound egress proxy URL", () => {
    expect(
      loadEnv({ ...base, HELIX_OUTBOUND_HTTP_PROXY_URL: "http://egress.internal:3128" }),
    ).toMatchObject({ HELIX_OUTBOUND_HTTP_PROXY_URL: "http://egress.internal:3128" });
    expect(() => loadEnv({ ...base, HELIX_OUTBOUND_HTTP_PROXY_URL: "not a URL" })).toThrow(
      /HELIX_OUTBOUND_HTTP_PROXY_URL/u,
    );
  });

  it("preserves the explicit trusted-proxy allowlist for centralized parsing", () => {
    expect(loadEnv({ ...base, HELIX_TRUSTED_PROXIES: "10.0.0.1,2001:db8::/48" })).toMatchObject({
      HELIX_TRUSTED_PROXIES: "10.0.0.1,2001:db8::/48",
    });
  });

  it("validates tenant routing configuration", () => {
    expect(
      loadEnv({
        ...base,
        HELIX_TENANT_ROOT_HOSTS: "workspace.example.org,workspace.example.net",
        HELIX_TENANT_PROXY_SECRET: "tenant-proxy-secret-with-at-least-32-bytes",
      }),
    ).toMatchObject({
      HELIX_TENANT_ROOT_HOSTS: "workspace.example.org,workspace.example.net",
    });
    expect(() => loadEnv({ ...base, HELIX_TENANT_PROXY_SECRET: "too-short" })).toThrow(
      /HELIX_TENANT_PROXY_SECRET/,
    );
  });
});
