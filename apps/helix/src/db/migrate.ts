import { createSqlClient, resolveMigrationDatabaseUrl } from "./client.js";
import { resolvePlatformMigrationSources } from "./migration-sources.js";
import { runMigrations } from "./migration-runner.js";
import { env } from "../config/env.js";

const sql = createSqlClient(resolveMigrationDatabaseUrl());

try {
  const sources = await resolvePlatformMigrationSources();
  const result = await runMigrations(sql, sources, { deploymentRegion: env().HELIX_REGION });
  console.log(
    `Applied ${String(result.applied.length)} migrations, skipped ${String(result.skipped.length)} migrations.`,
  );
} finally {
  await sql.end();
}
