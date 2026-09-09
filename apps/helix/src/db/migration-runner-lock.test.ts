import { describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import { runMigrations } from "./migration-runner.js";

describe("migration runner connection safety", () => {
  it("holds the advisory lock, checks, and transactions on one reserved connection", async () => {
    const statements: string[] = [];
    const unsafeStatements: string[] = [];
    const release = vi.fn();

    const reserved = Object.assign(
      async (strings: TemplateStringsArray) => {
        const statement = compactSql(strings);
        statements.push(statement);
        if (statement.includes("to_regclass")) {
          return [{ exists: false }];
        }
        if (statement.includes("select exists")) {
          return [{ exists: false }];
        }
        return [];
      },
      {
        unsafe: vi.fn(async (statement: string) => {
          unsafeStatements.push(statement);
          return [];
        }),
        release,
      },
    ) as unknown as postgres.ReservedSql;

    const rootQuery = vi.fn();
    const sql = Object.assign(rootQuery, {
      reserve: vi.fn(async () => reserved),
    }) as unknown as postgres.Sql;

    await expect(
      runMigrations(sql, [
        {
          namespace: "platform",
          migrations: [{ name: "0001_safe.sql", sql: "select 42" }],
        },
      ]),
    ).resolves.toEqual({
      applied: [{ namespace: "platform", name: "0001_safe.sql" }],
      skipped: [],
    });

    expect(rootQuery).not.toHaveBeenCalled();
    expect(sql.reserve).toHaveBeenCalledTimes(1);
    expect(statements[0]).toContain("pg_advisory_lock");
    expect(statements.at(-1)).toContain("pg_advisory_unlock");
    expect(unsafeStatements).toEqual(["begin", "select 42", "commit"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("rolls back a failed migration on the reserved connection", async () => {
    const unsafeStatements: string[] = [];
    const release = vi.fn();
    const failure = new Error("unsafe migration failed");
    const reserved = Object.assign(
      async (strings: TemplateStringsArray) => {
        const statement = compactSql(strings);
        if (statement.includes("to_regclass")) {
          return [{ exists: true }];
        }
        if (statement.includes("select exists")) {
          return [{ exists: false }];
        }
        return [];
      },
      {
        unsafe: vi.fn(async (statement: string) => {
          unsafeStatements.push(statement);
          if (statement === "select broken") {
            throw failure;
          }
          return [];
        }),
        release,
      },
    ) as unknown as postgres.ReservedSql;
    const sql = Object.assign(vi.fn(), {
      reserve: vi.fn(async () => reserved),
    }) as unknown as postgres.Sql;

    await expect(
      runMigrations(sql, [
        {
          namespace: "platform",
          migrations: [{ name: "0001_broken.sql", sql: "select broken" }],
        },
      ]),
    ).rejects.toBe(failure);

    expect(unsafeStatements).toEqual(["begin", "select broken", "rollback"]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("releases the reserved connection when lock acquisition fails", async () => {
    const release = vi.fn();
    const reserved = Object.assign(
      vi.fn(async () => {
        throw new Error("lock unavailable");
      }),
      { release },
    ) as unknown as postgres.ReservedSql;
    const sql = Object.assign(vi.fn(), {
      reserve: vi.fn(async () => reserved),
    }) as unknown as postgres.Sql;

    await expect(runMigrations(sql, [])).rejects.toThrow("lock unavailable");
    expect(release).toHaveBeenCalledTimes(1);
  });
});

function compactSql(strings: TemplateStringsArray): string {
  return strings.join("?").replace(/\s+/gu, " ").trim();
}
