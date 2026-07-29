import { createSqlClient, resolveMigrationDatabaseUrl } from "./client.js";
import { loadEnv } from "../config/env.js";
import { resolvePlatformMigrationSources } from "./migration-sources.js";
import { runMigrations } from "./migration-runner.js";

// This one-shot process parses only the operational schema. It receives the
// elevated migration credential but none of the provider secrets or listener
// configuration required by an application replica.
const migrationEnv = loadEnv();
const sql = createSqlClient(resolveMigrationDatabaseUrl(migrationEnv), {
  poolMax: migrationEnv.POSTGRES_POOL_MAX,
});

try {
  const sources = await resolvePlatformMigrationSources(migrationEnv);
  const result = await runMigrations(sql, sources);
  console.log(
    `Applied ${String(result.applied.length)} migrations, skipped ${String(result.skipped.length)} migrations.`,
  );
} finally {
  await sql.end();
}
