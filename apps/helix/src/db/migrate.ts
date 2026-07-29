import { loadMigrationEnv } from "../config/env.js";
import { createMigrationSqlClient } from "./client.js";
import { resolvePlatformMigrationSources } from "./migration-sources.js";
import { runMigrations } from "./migration-runner.js";

// This one-shot process parses only the operational schema. It receives the
// elevated migration credential but none of the provider secrets or listener
// configuration required by an application replica.
const migrationEnv = loadMigrationEnv();
const sql = createMigrationSqlClient(migrationEnv);

try {
  const sources = await resolvePlatformMigrationSources(migrationEnv);
  const result = await runMigrations(sql, sources);
  console.log(
    `Applied ${String(result.applied.length)} migrations, skipped ${String(result.skipped.length)} migrations.`,
  );
} finally {
  await sql.end();
}
