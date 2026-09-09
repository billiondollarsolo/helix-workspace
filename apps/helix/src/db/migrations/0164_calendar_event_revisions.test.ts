import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0164 calendar event revisions", () => {
  it("creates bounded tenant-isolated append-only snapshots", async () => {
    const migration = await readFile(
      new URL("./0164_calendar_event_revisions.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("primary key (org_id, event_id, revision)");
    expect(migration).toContain("octet_length(snapshot::text) <= 1048576");
    expect(migration).toContain("cal_event_revisions_immutable");
    expect(migration).toContain("alter table cal_event_revisions force row level security");
    expect(migration).toContain("grant select, insert on cal_event_revisions to helix_app");
    expect(migration).not.toContain("grant update");
    expect(migration).not.toContain("grant delete");
  });
});
