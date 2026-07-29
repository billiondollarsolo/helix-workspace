import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type postgres from "postgres";

export interface MigrationSource {
  readonly namespace: string;
  readonly directory?: string;
  readonly migrations?: readonly InlineSqlMigration[];
}

export interface InlineSqlMigration {
  readonly name: string;
  readonly sql: string | readonly string[];
}

export interface AppliedMigration {
  readonly namespace: string;
  readonly name: string;
}

export interface PendingMigration {
  readonly namespace: string;
  readonly name: string;
}

export interface UnknownAppliedMigration {
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
  const connection = await sql.reserve();
  let locked = false;

  try {
    // Session advisory locks are connection-bound. Reserve one connection for
    // the entire migration run so another pool connection cannot accidentally
    // execute migrations outside the lock or attempt to unlock the wrong
    // PostgreSQL session.
    await connection`select pg_advisory_lock(${migrationLockKey})`;
    locked = true;
    await ensureMigrationTable(connection);
    for (const source of sources) {
      const migrations = await listMigrations(source);
      for (const migration of migrations) {
        const name = migration.name;
        const existing = await connection<{ exists: boolean }[]>`
          select exists(
            select 1 from schema_migrations where namespace = ${source.namespace} and name = ${name}
          ) as exists
        `;

        if (existing[0]?.exists === true) {
          skipped.push({ namespace: source.namespace, name });
          continue;
        }

        const statement = migration.sql;
        await runReservedTransaction(connection, async () => {
          const statements: readonly string[] =
            typeof statement === "string" ? [statement] : statement;
          for (const sqlStatement of statements) {
            await connection.unsafe(sqlStatement);
          }
          await connection`
            insert into schema_migrations (namespace, name)
            values (${source.namespace}, ${name})
          `;
        });
        applied.push({ namespace: source.namespace, name });
      }
    }
  } finally {
    try {
      if (locked) {
        await connection`select pg_advisory_unlock(${migrationLockKey})`;
      }
    } finally {
      connection.release();
    }
  }

  return { applied, skipped };
}

async function runReservedTransaction(
  connection: postgres.ReservedSql,
  callback: () => Promise<void>,
): Promise<void> {
  // postgres.js 3.4.x declares ReservedSql.begin() in its public types but the
  // runtime object returned by reserve() does not attach that method. Execute
  // the transaction control statements on the reserved connection directly so
  // the advisory lock and every migration statement remain on one session.
  await connection.unsafe("begin");
  try {
    await callback();
    await connection.unsafe("commit");
  } catch (error) {
    try {
      await connection.unsafe("rollback");
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "Migration failed and its reserved transaction could not be rolled back",
      );
    }
    throw error;
  }
}

export async function listPendingMigrations(
  sql: postgres.Sql,
  sources: readonly MigrationSource[],
): Promise<readonly PendingMigration[]> {
  await ensureMigrationTable(sql);
  const pending: PendingMigration[] = [];
  for (const source of sources) {
    const migrations = await listMigrations(source);
    const appliedRows = await sql<{ readonly name: string }[]>`
      select name from schema_migrations where namespace = ${source.namespace}
    `;
    const applied = new Set(appliedRows.map((row) => row.name));
    for (const migration of migrations) {
      if (!applied.has(migration.name)) {
        pending.push({ namespace: source.namespace, name: migration.name });
      }
    }
  }
  return pending;
}

/**
 * Find migration rows for an enabled namespace that the running application
 * image does not contain. This indicates that the database is newer than the
 * image's compatible schema range.
 */
export async function listUnknownAppliedMigrations(
  sql: postgres.Sql,
  sources: readonly MigrationSource[],
): Promise<readonly UnknownAppliedMigration[]> {
  await ensureMigrationTable(sql);
  const unknown: UnknownAppliedMigration[] = [];
  for (const source of sources) {
    const known = new Set((await listMigrations(source)).map((migration) => migration.name));
    const appliedRows = await sql<{ readonly name: string }[]>`
      select name from schema_migrations where namespace = ${source.namespace}
    `;
    for (const row of appliedRows) {
      if (!known.has(row.name)) {
        unknown.push({ namespace: source.namespace, name: row.name });
      }
    }
  }
  return unknown;
}

async function ensureMigrationTable(sql: postgres.Sql): Promise<void> {
  const existing = await sql<{ readonly exists: boolean }[]>`
    select to_regclass('public.schema_migrations') is not null as exists
  `;
  if (existing[0]?.exists === true) {
    return;
  }
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

async function listMigrations(source: MigrationSource): Promise<readonly InlineSqlMigration[]> {
  const fileMigrations =
    source.directory === undefined
      ? []
      : await Promise.all(
          (await listSqlMigrations(source.directory)).map(async (file) => ({
            name: basename(file),
            sql: await readFile(file, "utf8"),
          })),
        );
  return [...fileMigrations, ...(source.migrations ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

const migrationLockKey = 0x48454c49;
