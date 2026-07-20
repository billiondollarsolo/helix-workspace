import postgres from "postgres";
import { env as loadValidatedEnv, type Env } from "../config/env.js";

const DEFAULT_DATABASE_URL = "postgres://helix:helix_dev_password@localhost:28432/helix";

export function resolveDatabaseUrl(
  source: NodeJS.ProcessEnv | Env = process.env,
): string {
  const url =
    "DATABASE_URL" in source && typeof source.DATABASE_URL === "string"
      ? source.DATABASE_URL
      : undefined;
  return url && url.length > 0 ? url : DEFAULT_DATABASE_URL;
}

export function resolveMigrationDatabaseUrl(
  source: NodeJS.ProcessEnv | Env = process.env,
): string {
  const migrationUrl =
    "HELIX_MIGRATION_DATABASE_URL" in source &&
    typeof source.HELIX_MIGRATION_DATABASE_URL === "string"
      ? source.HELIX_MIGRATION_DATABASE_URL
      : "MIGRATION_DATABASE_URL" in source && typeof source.MIGRATION_DATABASE_URL === "string"
        ? source.MIGRATION_DATABASE_URL
        : undefined;
  return migrationUrl && migrationUrl.length > 0
    ? migrationUrl
    : resolveDatabaseUrl(source);
}

export function createSqlClient(databaseUrl = resolveDatabaseUrl()): postgres.Sql {
  const poolMax = loadValidatedEnv().POSTGRES_POOL_MAX;
  return postgres(databaseUrl, {
    max: poolMax,
    prepare: false,
  });
}
