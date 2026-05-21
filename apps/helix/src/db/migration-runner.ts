import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type postgres from "postgres";

export interface MigrationSource {
  readonly namespace: string;
  readonly directory: string;
}

export interface AppliedMigration {
  readonly namespace: string;
  readonly name: string;
}

export interface MigrationRunResult {
  readonly applied: readonly AppliedMigration[];
  readonly skipped: readonly AppliedMigration[];
}

export async function runMigrations(
  sql: postgres.Sql,
  sources: readonly MigrationSource[],
): Promise<MigrationRunResult> {
  const applied: AppliedMigration[] = [];
  const skipped: AppliedMigration[] = [];

  await sql`select pg_advisory_lock(${migrationLockKey})`;
  try {
    await ensureMigrationTable(sql);
    for (const source of sources) {
      const files = await listSqlMigrations(source.directory);
      for (const file of files) {
        const name = basename(file);
        const existing = await sql<{ exists: boolean }[]>`
          select exists(
            select 1 from schema_migrations where namespace = ${source.namespace} and name = ${name}
          ) as exists
        `;

        if (existing[0]?.exists === true) {
          skipped.push({ namespace: source.namespace, name });
          continue;
        }

        const statement = await readFile(file, "utf8");
        await sql.begin(async (tx) => {
          await tx.unsafe(statement);
          await tx`
            insert into schema_migrations (namespace, name)
            values (${source.namespace}, ${name})
          `;
        });
        applied.push({ namespace: source.namespace, name });
      }
    }
  } finally {
    await sql`select pg_advisory_unlock(${migrationLockKey})`;
  }

  return { applied, skipped };
}

async function ensureMigrationTable(sql: postgres.Sql): Promise<void> {
  await sql`
    create table if not exists schema_migrations (
      namespace text not null,
      name text not null,
      applied_at timestamptz not null default now(),
      primary key (namespace, name)
    )
  `;
}

async function listSqlMigrations(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

const migrationLockKey = 0x48454c49;
