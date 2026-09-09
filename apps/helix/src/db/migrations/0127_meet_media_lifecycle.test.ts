import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0127 Meet media lifecycle migration", () => {
  it("persists idempotent events, participant sessions, versioning, and empty-room expiry", async () => {
    const sql = await readFile(new URL("./0127_meet_media_lifecycle.sql", import.meta.url), "utf8");
    expect(sql).toContain("lifecycle_version bigint not null default 0");
    expect(sql).toContain("create table meet_media_events");
    expect(sql).toContain("primary key (org_id, event_id)");
    expect(sql).toContain("create table meet_participant_sessions");
    expect(sql).toContain("force row level security");
    expect(sql).toContain("helix_expire_empty_meet_rooms");
    expect(sql).toContain("for update skip locked");
    expect(sql).toContain("requires an unscoped worker context");
  });
});
