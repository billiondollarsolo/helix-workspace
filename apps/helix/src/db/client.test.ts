import { afterEach, describe, expect, it } from "vitest";
import { loadMigrationEnv, resetEnvCacheForTests } from "../config/env.js";
import { assertProductionPostgresConfiguration } from "../config/production-assertions.js";
import {
  createMigrationSqlClient,
  resolveDatabaseUrl,
  resolveMigrationDatabaseUrl,
} from "./client.js";

const originalNodeEnv = process.env.NODE_ENV;
const originalDatabaseUrl = process.env.DATABASE_URL;

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

afterEach(() => {
  restoreEnvironmentValue("NODE_ENV", originalNodeEnv);
  restoreEnvironmentValue("DATABASE_URL", originalDatabaseUrl);
  resetEnvCacheForTests();
});

describe("database URL resolution", () => {
  it("uses the local development database URL by default", () => {
    expect(resolveDatabaseUrl({})).toBe(
      "postgres://helix:helix_dev_password@localhost:28432/helix",
    );
  });

  it("uses DATABASE_URL for the runtime app connection", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgres://app/runtime" })).toBe(
      "postgres://app/runtime",
    );
  });

  it("allows migrations to use elevated database credentials", () => {
    expect(
      resolveMigrationDatabaseUrl({
        DATABASE_URL: "postgres://app/runtime",
        HELIX_MIGRATION_DATABASE_URL: "postgres://admin/migrations",
      }),
    ).toBe("postgres://admin/migrations");
  });

  it("keeps MIGRATION_DATABASE_URL as a shorter alias for local tooling", () => {
    expect(
      resolveMigrationDatabaseUrl({
        DATABASE_URL: "postgres://app/runtime",
        MIGRATION_DATABASE_URL: "postgres://admin/alias",
      }),
    ).toBe("postgres://admin/alias");
  });
});

describe("dedicated migration connection", () => {
  const productionDatabaseUrl =
    "postgres://helix_migrator:Migration-DB_Secret!2026-A1b2C3d4E5f6G7h8@postgres:5432/helix";
  const productionMigrationSource = {
    ...productionImageEnvironment,
    NODE_ENV: "production",
    DATABASE_URL: productionDatabaseUrl,
    POSTGRES_TLS_CA_FILE: "/run/secrets/postgres_ca",
    POSTGRES_POOL_MAX: "2",
    HELIX_EDITORS_MIGRATIONS_ENABLED: "false",
    // These application-only values are deliberately invalid. The migration
    // process must neither parse nor assert them.
    PORT: "not-a-port",
    REDIS_URL: "not-a-redis-url",
  };

  it("constructs a production client from only migration settings", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    resetEnvCacheForTests();

    const migrationEnv = loadMigrationEnv(productionMigrationSource);
    const databaseUrl = resolveMigrationDatabaseUrl(migrationEnv);
    expect(() => {
      assertProductionPostgresConfiguration(databaseUrl, migrationEnv);
    }).not.toThrow();

    const sql = createMigrationSqlClient(migrationEnv, {
      readTlsFile: () => Buffer.from("test-ca"),
    });
    await sql.end();
  });

  it("rejects missing, weak, and non-PostgreSQL production database URLs", () => {
    expect(() =>
      loadMigrationEnv({
        NODE_ENV: "production",
        POSTGRES_TLS_CA_FILE: "/run/secrets/postgres_ca",
      }),
    ).toThrow(/DATABASE_URL/u);

    for (const databaseUrl of [
      "postgres://helix_migrator:weak@postgres:5432/helix",
      "https://helix_migrator:Migration-DB_Secret!2026-A1b2C3d4E5f6G7h8@postgres/helix",
    ]) {
      const migrationEnv = loadMigrationEnv({
        ...productionMigrationSource,
        DATABASE_URL: databaseUrl,
      });
      expect(() => {
        assertProductionPostgresConfiguration(databaseUrl, migrationEnv);
      }).toThrow(/DATABASE_URL/u);
    }
  });

  it("rejects missing, incomplete, and unreadable production TLS configuration", () => {
    const missingCaEnv = loadMigrationEnv({
      ...productionMigrationSource,
      POSTGRES_TLS_CA_FILE: undefined,
    });
    expect(() => {
      assertProductionPostgresConfiguration(productionDatabaseUrl, missingCaEnv);
    }).toThrow(/POSTGRES_TLS_CA_FILE/u);

    const incompleteMtlsEnv = loadMigrationEnv({
      ...productionMigrationSource,
      POSTGRES_TLS_CERT_FILE: "/run/secrets/postgres_client_cert",
    });
    expect(() => {
      assertProductionPostgresConfiguration(productionDatabaseUrl, incompleteMtlsEnv);
    }).toThrow(/POSTGRES_TLS_CERT_FILE/u);

    const migrationEnv = loadMigrationEnv(productionMigrationSource);
    expect(() =>
      createMigrationSqlClient(migrationEnv, {
        readTlsFile: () => {
          throw new Error("unreadable");
        },
      }),
    ).toThrow(/unreadable or invalid/u);
  });
});

function restoreEnvironmentValue(name: "NODE_ENV" | "DATABASE_URL", value: string | undefined) {
  if (name === "NODE_ENV") {
    if (value === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = value;
    }
    return;
  }

  if (value === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = value;
  }
}
