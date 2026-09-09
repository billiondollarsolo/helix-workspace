import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0132 Meet recording governance migration", () => {
  it("links recordings to current meeting governance and removes copied viewer grants", async () => {
    const sql = await readFile(new URL("./0132_meet_recording_governance.sql", import.meta.url), "utf8");
    expect(sql).toContain("create table meet_recording_governance");
    expect(sql).toContain("retention_until timestamptz");
    expect(sql).toContain("legal_hold boolean not null default false");
    expect(sql).toContain("force row level security");
    expect(sql).toContain("object.kind = 'recording'");
    expect(sql).toContain("permission.actor_id is distinct from object.owner_actor_id");
  });
});
