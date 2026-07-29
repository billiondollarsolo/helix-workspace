import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv, loadMigrationEnv } from "./env.js";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/helix",
  REDIS_URL: "redis://localhost:6379",
};

const productionImageEnvironment = {
  HELIX_IMAGE:
    "ghcr.io/billiondollarsolo/helix-workspace@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  HELIX_WEB_IMAGE:
    "ghcr.io/billiondollarsolo/helix-workspace-web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  HELIX_POSTGRES_IMAGE:
    "ghcr.io/billiondollarsolo/helix-workspace-postgres@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  HELIX_NATS_IMAGE:
    "ghcr.io/billiondollarsolo/helix-workspace-nats@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  HELIX_MEILISEARCH_IMAGE:
    "ghcr.io/billiondollarsolo/helix-workspace-meilisearch@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  HELIX_CERBOS_IMAGE:
    "ghcr.io/billiondollarsolo/helix-workspace-cerbos@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
  HELIX_SPAMD_IMAGE:
    "ghcr.io/billiondollarsolo/helix-workspace-spamassassin@sha256:1111111111111111111111111111111111111111111111111111111111111111",
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

  it("rejects a non-numeric PORT", () => {
    expect(() => loadEnv({ ...base, PORT: "notaport" })).toThrow(/PORT/);
  });

  it("accepts empty REDIS_URL as undefined", () => {
    const env = loadEnv({ ...base, REDIS_URL: "" });
    expect(env.REDIS_URL).toBeUndefined();
  });

  it("loads an allowlisted secret from an absolute *_FILE path", () => {
    const directory = mkdtempSync(join(tmpdir(), "helix-env-test-"));
    temporaryDirectories.push(directory);
    const secretPath = join(directory, "better-auth-secret");
    writeFileSync(secretPath, "file-backed-secret-with-a-trailing-newline\n", {
      mode: 0o600,
    });

    const loaded = loadEnv({
      ...base,
      BETTER_AUTH_SECRET_FILE: secretPath,
    });

    expect(loaded.BETTER_AUTH_SECRET).toBe("file-backed-secret-with-a-trailing-newline");
  });

  it("loads the dedicated MFA assertion key only from its allowlisted secret file", () => {
    const directory = mkdtempSync(join(tmpdir(), "helix-env-test-"));
    temporaryDirectories.push(directory);
    const secretPath = join(directory, "mfa-assertion-secret");
    writeFileSync(secretPath, "independent-mfa-assertion-secret-with-32-bytes\n", {
      mode: 0o600,
    });

    const loaded = loadEnv({
      ...base,
      HELIX_MFA_ASSERTION_SECRET_FILE: secretPath,
    });

    expect(loaded.HELIX_MFA_ASSERTION_SECRET).toBe(
      "independent-mfa-assertion-secret-with-32-bytes",
    );
  });

  it("rejects simultaneous inline and file-backed values without echoing either", () => {
    const directory = mkdtempSync(join(tmpdir(), "helix-env-test-"));
    temporaryDirectories.push(directory);
    const secretPath = join(directory, "better-auth-secret");
    const inlineSecret = "inline-secret-that-must-not-appear";
    const fileSecret = "file-secret-that-must-not-appear";
    writeFileSync(secretPath, fileSecret, { mode: 0o600 });

    let caught: unknown;
    try {
      loadEnv({
        ...base,
        BETTER_AUTH_SECRET: inlineSecret,
        BETTER_AUTH_SECRET_FILE: secretPath,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("BETTER_AUTH_SECRET_FILE");
    expect((caught as Error).message).not.toContain(inlineSecret);
    expect((caught as Error).message).not.toContain(fileSecret);
    expect((caught as Error).message).not.toContain(secretPath);
  });

  it("rejects relative and unreadable *_FILE inputs without echoing paths", () => {
    expect(() =>
      loadEnv({
        ...base,
        BETTER_AUTH_SECRET_FILE: "./relative-secret",
      }),
    ).toThrow(/BETTER_AUTH_SECRET_FILE/);

    const missingPath = "/definitely/not/a/helix/secret";
    let caught: unknown;
    try {
      loadEnv({ ...base, BETTER_AUTH_SECRET_FILE: missingPath });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).not.toContain(missingPath);
  });
});

describe("loadMigrationEnv", () => {
  it("loads the production database URL from the dedicated secret file", () => {
    const directory = mkdtempSync(join(tmpdir(), "helix-migration-env-test-"));
    temporaryDirectories.push(directory);
    const databaseUrlPath = join(directory, "migration-database-url");
    const databaseUrl =
      "postgres://helix_migrator:Migration-DB_Secret!2026-A1b2C3d4E5f6G7h8@postgres:5432/helix";
    writeFileSync(databaseUrlPath, `${databaseUrl}\n`, { mode: 0o600 });

    const loaded = loadMigrationEnv({
      ...productionImageEnvironment,
      NODE_ENV: "production",
      DATABASE_URL_FILE: databaseUrlPath,
      POSTGRES_TLS_CA_FILE: "/run/secrets/postgres_ca",
      POSTGRES_POOL_MAX: "2",
      HELIX_EDITORS_MIGRATIONS_ENABLED: "false",
      PORT: "not-a-port",
      REDIS_URL: "not-a-redis-url",
    });

    expect(loaded).toMatchObject({
      NODE_ENV: "production",
      DATABASE_URL: databaseUrl,
      POSTGRES_TLS_CA_FILE: "/run/secrets/postgres_ca",
      POSTGRES_POOL_MAX: 2,
      HELIX_EDITORS_MIGRATIONS_ENABLED: "false",
    });
    expect(loaded).not.toHaveProperty("PORT");
    expect(loaded).not.toHaveProperty("REDIS_URL");
  });

  it("rejects tag-only production image references", () => {
    expect(() =>
      loadMigrationEnv({
        ...productionImageEnvironment,
        NODE_ENV: "production",
        DATABASE_URL:
          "postgres://helix_migrator:Migration-DB_Secret!2026-A1b2C3d4E5f6G7h8@postgres:5432/helix",
        POSTGRES_TLS_CA_FILE: "/run/secrets/postgres_ca",
        HELIX_EDITORS_MIGRATIONS_ENABLED: "false",
        HELIX_IMAGE: "ghcr.io/billiondollarsolo/helix-workspace:latest",
      }),
    ).toThrow(/HELIX_IMAGE/u);
  });

  it("rejects conflicting inline and file-backed migration database credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "helix-migration-env-test-"));
    temporaryDirectories.push(directory);
    const databaseUrlPath = join(directory, "migration-database-url");
    writeFileSync(databaseUrlPath, "postgres://file:secret@postgres:5432/helix", { mode: 0o600 });

    expect(() =>
      loadMigrationEnv({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://inline:secret@postgres:5432/helix",
        DATABASE_URL_FILE: databaseUrlPath,
        POSTGRES_TLS_CA_FILE: "/run/secrets/postgres_ca",
      }),
    ).toThrow(/DATABASE_URL_FILE/u);
  });

  it.each([undefined, "true", "FALSE", "0", " false "])(
    "requires literal false for production editor migrations (%s)",
    (editorsMigrationsEnabled) => {
      expect(() =>
        loadMigrationEnv({
          NODE_ENV: "production",
          DATABASE_URL: "postgres://helix_migrator:secret@postgres:5432/helix",
          HELIX_EDITORS_MIGRATIONS_ENABLED: editorsMigrationsEnabled,
        }),
      ).toThrow(/HELIX_EDITORS_MIGRATIONS_ENABLED/u);
    },
  );
});
