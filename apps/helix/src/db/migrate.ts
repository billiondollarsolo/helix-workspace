import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSqlClient } from "./client.js";
import { runMigrations } from "./migration-runner.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const sql = createSqlClient();

try {
  const result = await runMigrations(sql, [
    {
      namespace: "platform",
      directory: join(currentDir, "migrations"),
    },
  ]);
  console.log(
    `Applied ${String(result.applied.length)} migrations, skipped ${String(result.skipped.length)} migrations.`,
  );
} finally {
  await sql.end();
}
