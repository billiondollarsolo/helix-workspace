import { pathToFileURL } from "node:url";
import { z } from "zod";
import { backfillMailBodies } from "../platform/mail/body-backfill.js";
import { createSqlClient, resolveMigrationDatabaseUrl } from "./client.js";
import { env } from "../config/env.js";
import { createOperatorStorageResolver } from "./storage-runtime.js";

export function parseMailBodyBackfillArgs(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== "--org-id")
    throw new Error(
      "Usage: db:backfill:mail-bodies --org-id <uuid>. Requires a migration credential and a current database/object-store backup.",
    );
  return z.string().uuid().parse(args[1]);
}

async function main() {
  const orgId = parseMailBodyBackfillArgs(process.argv.slice(2).filter((arg) => arg !== "--"));
  const sql = createSqlClient(resolveMigrationDatabaseUrl(env()), { poolMax: 1 });
  try {
    await sql`set role helix_migration_owner`;
    const result = await backfillMailBodies(sql, createOperatorStorageResolver(sql), orgId);
    console.log(JSON.stringify({ orgId, ...result }));
  } finally {
    await sql.end();
  }
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
