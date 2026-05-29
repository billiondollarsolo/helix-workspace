import postgres from "postgres";

const DEFAULT_DATABASE_URL = "postgres://helix:helix_dev_password@localhost:28432/helix";

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

export function resolveMigrationDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.HELIX_MIGRATION_DATABASE_URL ?? env.MIGRATION_DATABASE_URL ?? resolveDatabaseUrl(env);
}

export function createSqlClient(databaseUrl = resolveDatabaseUrl()): postgres.Sql {
  return postgres(databaseUrl, {
    max: Number.parseInt(process.env.POSTGRES_POOL_MAX ?? "10", 10),
    prepare: false,
  });
}
