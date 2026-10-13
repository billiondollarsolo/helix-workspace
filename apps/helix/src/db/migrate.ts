import type postgres from "postgres";
import { loadMigrationEnv } from "../config/env.js";
import { createMigrationSqlClient } from "./client.js";
import { runMigrations } from "./migration-runner.js";
import { resolvePlatformMigrationSources } from "./migration-sources.js";
import { waitForPostgresPrerequisites } from "./postgres-prerequisites.js";

/** `database on host:port as user`, never the password. */
function describeMigrationTarget(client: postgres.Sql): string {
  const { host, port, database, user } = client.options;
  return `${database} on ${String(host[0])}:${String(port[0])} as ${user}`;
}

// This one-shot process parses only the operational schema. It receives the
// elevated migration credential but none of the provider secrets or listener
// configuration required by an application replica.
const migrationEnv = loadMigrationEnv();
const sql = createMigrationSqlClient(migrationEnv);
// Say which database is about to change. This script reads only the process
// environment, not a .env file, and falls back to the local development
// default: on a host with several stacks that is easily the wrong one.
console.log(`Migrating ${describeMigrationTarget(sql)}.`);

try {
  // Fail before the first migration with an actionable message when the server
  // is too old or a required extension (pgvector) cannot be created by this
  // non-superuser owner, instead of a bare "permission denied" mid-run.
  const prerequisites = await waitForPostgresPrerequisites(sql, {
    phase: "migration",
    waitSeconds: migrationEnv.HELIX_MIGRATION_DATABASE_WAIT_SECONDS,
    onRetry: (_error, remainingMs) => {
      console.warn(
        `PostgreSQL is not reachable yet; retrying for up to ${String(Math.ceil(remainingMs / 1000))}s.`,
      );
    },
  });
  for (const warning of prerequisites.warnings) {
    console.warn(warning);
  }
  const sources = await resolvePlatformMigrationSources();
  const result = await runMigrations(sql, sources, { deploymentRegion: migrationEnv.HELIX_REGION });
  console.log(
    `Applied ${String(result.applied.length)} migrations, skipped ${String(result.skipped.length)} migrations.`,
  );
} finally {
  await sql.end();
}
