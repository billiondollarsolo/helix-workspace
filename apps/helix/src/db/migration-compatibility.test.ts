import { describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import { listUnknownAppliedMigrations } from "./migration-runner.js";

describe("migration compatibility range", () => {
  it("reports applied migrations that are absent from the running image", async () => {
    const sql = queuedSql([
      [{ exists: true }],
      [{ name: "0001_known.sql" }, { name: "9999_future.sql" }],
    ]);

    await expect(
      listUnknownAppliedMigrations(sql, [
        {
          namespace: "platform",
          migrations: [{ name: "0001_known.sql", sql: "select 1" }],
        },
      ]),
    ).resolves.toEqual([{ namespace: "platform", name: "9999_future.sql" }]);
  });

  it("accepts an exact applied migration set", async () => {
    const sql = queuedSql([[{ exists: true }], [{ name: "0001_known.sql" }]]);

    await expect(
      listUnknownAppliedMigrations(sql, [
        {
          namespace: "platform",
          migrations: [{ name: "0001_known.sql", sql: "select 1" }],
        },
      ]),
    ).resolves.toEqual([]);
  });
});

function queuedSql(results: readonly unknown[]): postgres.Sql {
  const queue = [...results];
  return vi.fn(async () => queue.shift()) as unknown as postgres.Sql;
}
