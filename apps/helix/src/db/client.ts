import postgres from "postgres";
import { env as loadValidatedEnv, type Env, type MigrationEnv } from "../config/env.js";
import {
  resolvePostgresSsl,
  type PostgresConnectionEnvironment,
} from "../config/postgres-connection.js";
import {
  assertProductionDeploymentConfiguration,
  assertProductionPostgresConfiguration,
} from "../config/production-assertions.js";

const DEFAULT_DATABASE_URL = "postgres://helix:helix_dev_password@localhost:28432/helix";

export interface DatabaseUrlEnvironment {
  readonly DATABASE_URL?: string | undefined;
  readonly HELIX_MIGRATION_DATABASE_URL?: string | undefined;
  readonly MIGRATION_DATABASE_URL?: string | undefined;
}

/** Read a field that is present on the source object and holds a string value. */
function presentStringField(source: object, key: string): string | undefined {
  if (!(key in source)) {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function resolveDatabaseUrl(source: DatabaseUrlEnvironment | Env = process.env): string {
  const url = presentStringField(source, "DATABASE_URL");
  return url && url.length > 0 ? url : DEFAULT_DATABASE_URL;
}

export function resolveMigrationDatabaseUrl(
  source: DatabaseUrlEnvironment | Env = process.env,
): string {
  // The first *present* string override wins, and only then is it tested for
  // emptiness: a present-but-empty HELIX_MIGRATION_DATABASE_URL therefore falls
  // through to DATABASE_URL rather than to MIGRATION_DATABASE_URL.
  const migrationUrl =
    presentStringField(source, "HELIX_MIGRATION_DATABASE_URL") ??
    presentStringField(source, "MIGRATION_DATABASE_URL");
  return migrationUrl && migrationUrl.length > 0 ? migrationUrl : resolveDatabaseUrl(source);
}

export interface SqlClientOptions {
  readonly poolMax?: number;
  readonly environment?: PostgresConnectionEnvironment;
  readonly readTlsFile?: (path: string) => Buffer;
}

export function createSqlClient(
  databaseUrl = resolveDatabaseUrl(),
  options: SqlClientOptions = {},
): postgres.Sql {
  const validatedEnv = loadValidatedEnv();
  return createConfiguredSqlClient(databaseUrl, {
    poolMax: options.poolMax ?? validatedEnv.POSTGRES_POOL_MAX,
    environment: options.environment ?? validatedEnv,
    readTlsFile: options.readTlsFile,
  });
}

export interface MigrationSqlClientOptions {
  readonly readTlsFile?: (path: string) => Buffer;
}

/**
 * Build the one-shot migrator connection without loading application-only
 * production configuration.
 */
export function createMigrationSqlClient(
  migrationEnv: MigrationEnv,
  options: MigrationSqlClientOptions = {},
): postgres.Sql {
  const databaseUrl = resolveMigrationDatabaseUrl(migrationEnv);
  assertProductionDeploymentConfiguration(migrationEnv);
  assertProductionPostgresConfiguration(databaseUrl, migrationEnv);
  return createConfiguredSqlClient(databaseUrl, {
    poolMax: migrationEnv.POSTGRES_POOL_MAX,
    environment: migrationEnv,
    readTlsFile: options.readTlsFile,
  });
}

interface ConfiguredSqlClientOptions {
  readonly poolMax: number;
  readonly environment: PostgresConnectionEnvironment;
  readonly readTlsFile: ((path: string) => Buffer) | undefined;
}

function createConfiguredSqlClient(
  databaseUrl: string,
  options: ConfiguredSqlClientOptions,
): postgres.Sql {
  const ssl = resolvePostgresSsl(options.environment, options.readTlsFile);
  return postgres(databaseUrl, {
    max: options.poolMax,
    prepare: false,
    ssl,
  });
}
