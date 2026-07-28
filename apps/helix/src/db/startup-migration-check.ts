import type postgres from "postgres";
import { createSqlClient, resolveDatabaseUrl } from "./client.js";
import { resolvePlatformMigrationSources } from "./migration-sources.js";
import {
  listPendingMigrations,
  listUnknownAppliedMigrations,
  type MigrationSource,
  type PendingMigration,
  type UnknownAppliedMigration,
} from "./migration-runner.js";

export class PendingStartupMigrationsError extends Error {
  constructor(readonly pending: readonly PendingMigration[]) {
    super(startupMigrationErrorMessage(pending));
    this.name = "PendingStartupMigrationsError";
  }
}

export class IncompatibleStartupMigrationsError extends Error {
  constructor(readonly unknown: readonly UnknownAppliedMigration[]) {
    super(incompatibleMigrationErrorMessage(unknown));
    this.name = "IncompatibleStartupMigrationsError";
  }
}

export interface StartupMigrationCheckResult {
  readonly checked: boolean;
  readonly pending: readonly PendingMigration[];
  readonly unknown: readonly UnknownAppliedMigration[];
}

export interface StartupMigrationCheckOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly createSql?: () => postgres.Sql;
  readonly resolveSources?: () => Promise<readonly MigrationSource[]>;
  readonly listPending?: (
    sql: postgres.Sql,
    sources: readonly MigrationSource[],
  ) => Promise<readonly PendingMigration[]>;
  readonly listUnknownApplied?: (
    sql: postgres.Sql,
    sources: readonly MigrationSource[],
  ) => Promise<readonly UnknownAppliedMigration[]>;
}

export async function assertNoPendingStartupMigrations(
  options: StartupMigrationCheckOptions = {},
): Promise<StartupMigrationCheckResult> {
  const env = options.env ?? process.env;
  if (!shouldCheckStartupMigrations(env)) {
    return { checked: false, pending: [], unknown: [] };
  }

  // Application replicas perform this read-only check with the least-privilege
  // runtime credential. The elevated migration credential belongs only to the
  // one-shot migrator process.
  const sql = options.createSql?.() ?? createSqlClient(resolveDatabaseUrl());
  try {
    const sources = await (options.resolveSources?.() ?? resolvePlatformMigrationSources());
    const [pending, unknown] = await Promise.all([
      options.listPending?.(sql, sources) ?? listPendingMigrations(sql, sources),
      options.listUnknownApplied?.(sql, sources) ?? listUnknownAppliedMigrations(sql, sources),
    ]);
    if (unknown.length > 0) {
      throw new IncompatibleStartupMigrationsError(unknown);
    }
    if (pending.length > 0) {
      throw new PendingStartupMigrationsError(pending);
    }
    return { checked: true, pending, unknown };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function incompatibleMigrationErrorMessage(unknown: readonly UnknownAppliedMigration[]): string {
  const preview = unknown
    .slice(0, 10)
    .map((migration) => `${migration.namespace}/${migration.name}`)
    .join(", ");
  const suffix = unknown.length > 10 ? `, and ${String(unknown.length - 10)} more` : "";
  return [
    "Database schema is newer than this Helix application image.",
    `Unknown applied migrations: ${preview}${suffix}.`,
    "Deploy a compatible image; never delete migration history or attempt an ad-hoc downgrade.",
  ].join(" ");
}

export function shouldCheckStartupMigrations(env: NodeJS.ProcessEnv): boolean {
  const override = env.HELIX_STARTUP_MIGRATION_CHECK?.trim().toLowerCase();
  if (override === "false" || override === "0" || override === "off") {
    return false;
  }
  if (override === "true" || override === "1" || override === "on") {
    return true;
  }
  return true;
}

function startupMigrationErrorMessage(pending: readonly PendingMigration[]): string {
  const preview = pending
    .slice(0, 10)
    .map((migration) => `${migration.namespace}/${migration.name}`)
    .join(", ");
  const suffix = pending.length > 10 ? `, and ${String(pending.length - 10)} more` : "";
  return [
    "Database schema has pending migrations.",
    "Run the dedicated Helix migration job before starting application replicas.",
    `Pending: ${preview}${suffix}.`,
    "Set HELIX_STARTUP_MIGRATION_CHECK=false only for intentional one-off diagnostics.",
  ].join(" ");
}
