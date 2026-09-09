import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0138 meet host controls migration", () => {
  it("keeps control state bounded, tenant-bound, and its audit immutable", async () => {
    const sql = await readFile(new URL("./0138_meet_host_controls.sql", import.meta.url), "utf8");
    expect(sql).toContain("foreign key (org_id, host_actor_id) references actors (org_id, id)");
    expect(sql).toContain("cardinality(banned_participant_subjects) <= 1000");
    expect(sql).toContain("force row level security");
    expect(sql).toContain("meet_control_events_no_update_or_delete");
    expect(sql).toContain("host.transfer");
  });
});
