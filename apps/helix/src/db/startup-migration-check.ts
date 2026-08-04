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

/** How many migration names an operator-facing error lists before truncating. */
const MIGRATION_PREVIEW_LIMIT = 10;

/** Comma-joined `namespace/name` list, truncated so the error stays readable. */
function migrationPreview(
  migrations: readonly { readonly namespace: string; readonly name: string }[],
): string {
  const preview = migrations
    .slice(0, MIGRATION_PREVIEW_LIMIT)
    .map((migration) => `${migration.namespace}/${migration.name}`)
    .join(", ");
  const suffix =
    migrations.length > MIGRATION_PREVIEW_LIMIT
      ? `, and ${String(migrations.length - MIGRATION_PREVIEW_LIMIT)} more`
      : "";
  return `${preview}${suffix}`;
}

function incompatibleMigrationErrorMessage(unknown: readonly UnknownAppliedMigration[]): string {
  return [
    "Database schema is newer than this Helix application image.",
    `Unknown applied migrations: ${migrationPreview(unknown)}.`,
    "Deploy a compatible image; never delete migration history or attempt an ad-hoc downgrade.",
  ].join(" ");
}

export function shouldCheckStartupMigrations(env: NodeJS.ProcessEnv): boolean {
  // The check is on by default: only an explicit opt-out disables it, so any
  // unrecognized value (including "true"/"1"/"on") keeps it enabled.
  const override = env.HELIX_STARTUP_MIGRATION_CHECK?.trim().toLowerCase();
  return override !== "false" && override !== "0" && override !== "off";
}

function startupMigrationErrorMessage(pending: readonly PendingMigration[]): string {
  return [
    "Database schema has pending migrations.",
    "Run the dedicated Helix migration job before starting application replicas.",
    `Pending: ${migrationPreview(pending)}.`,
    "Set HELIX_STARTUP_MIGRATION_CHECK=false only for intentional one-off diagnostics.",
  ].join(" ");
}
