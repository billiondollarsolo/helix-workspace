import type postgres from "postgres";
import { createSqlClient, resolveMigrationDatabaseUrl } from "./client.js";
import { resolvePlatformMigrationSources } from "./migration-sources.js";
import {
  listPendingMigrations,
  type MigrationSource,
  type PendingMigration,
} from "./migration-runner.js";

export class PendingStartupMigrationsError extends Error {
  constructor(readonly pending: readonly PendingMigration[]) {
    super(startupMigrationErrorMessage(pending));
    this.name = "PendingStartupMigrationsError";
  }
}

export interface StartupMigrationCheckResult {
  readonly checked: boolean;
  readonly pending: readonly PendingMigration[];
}

export interface StartupMigrationCheckOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly createSql?: () => postgres.Sql;
  readonly resolveSources?: () => Promise<readonly MigrationSource[]>;
  readonly listPending?: (
    sql: postgres.Sql,
    sources: readonly MigrationSource[],
  ) => Promise<readonly PendingMigration[]>;
}

export async function assertNoPendingStartupMigrations(
  options: StartupMigrationCheckOptions = {},
): Promise<StartupMigrationCheckResult> {
  const env = options.env ?? process.env;
  if (!shouldCheckStartupMigrations(env)) {
    return { checked: false, pending: [] };
  }

  const sql = options.createSql?.() ?? createSqlClient(resolveMigrationDatabaseUrl());
  try {
    const sources = await (options.resolveSources?.() ?? resolvePlatformMigrationSources());
    const pending = await (options.listPending?.(sql, sources) ?? listPendingMigrations(sql, sources));
    if (pending.length > 0) {
      throw new PendingStartupMigrationsError(pending);
    }
    return { checked: true, pending };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function shouldCheckStartupMigrations(env: NodeJS.ProcessEnv): boolean {
  const override = env.HELIX_STARTUP_MIGRATION_CHECK?.trim().toLowerCase();
  if (override === "false" || override === "0" || override === "off") {
    return false;
  }
  if (override === "true" || override === "1" || override === "on") {
    return true;
  }
  return env.NODE_ENV !== "production";
}

function startupMigrationErrorMessage(pending: readonly PendingMigration[]): string {
  const preview = pending
    .slice(0, 10)
    .map((migration) => `${migration.namespace}/${migration.name}`)
    .join(", ");
  const suffix =
    pending.length > 10 ? `, and ${String(pending.length - 10)} more` : "";
  return [
    "Database schema has pending migrations.",
    "Run `pnpm --filter @helix/app db:migrate` before starting Helix so realtime editors do not run against stale tables.",
    `Pending: ${preview}${suffix}.`,
    "Set HELIX_STARTUP_MIGRATION_CHECK=false only for intentional one-off diagnostics.",
  ].join(" ");
}
