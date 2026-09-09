import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0147 calendar time semantics", () => {
  it("stores canonical instants beside closed local-time semantics", async () => {
    const migration = await readFile(
      new URL("./0147_calendar_time_semantics.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("time_semantics in ('zoned', 'floating', 'all_day')");
    expect(migration).toContain("starts_local");
    expect(migration).toContain("ends_local");
    expect(migration).toContain("pg_timezone_names");
    expect(migration).toContain("all_day = (time_semantics = 'all_day')");
  });
});
