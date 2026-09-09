import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0145 search index durability migration", () => {
  it("defines leased retries, DLQ replay, checkpoints, and cancellable shadow jobs", async () => {
    const migration = await readFile(
      new URL("./0145_search_index_durability.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("create table search_index_mutations");
    expect(migration).toContain("for update skip locked");
    expect(migration).toContain("dead_lettered");
    expect(migration).toContain("helix_replay_search_index_mutation");
    expect(migration).toContain("create table search_index_checkpoints");
    expect(migration).toContain("create table search_reindex_jobs");
    expect(migration).toContain("source_cursor jsonb");
    expect(migration).toContain("helix_cancel_search_reindex_job");
    expect(migration).toContain("force row level security");
  });
});
