import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0133 Meet recording consent migration", () => {
  it("stores immutable per-join consent and short-lived recording authorization evidence", async () => {
    const sql = await readFile(
      new URL("./0133_meet_recording_consent.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("create table meet_recording_consents");
    expect(sql).toContain("recording_active boolean not null default false");
    expect(sql).toContain("'recording.started', 'recording.ended'");
    expect(sql).toContain("consent_policy = 'explicit-all-parties'");
    expect(sql).toContain("jurisdiction = 'global'");
    expect(sql).toContain("create table meet_recording_authorizations");
    expect(sql).toContain("claimed_at timestamptz");
    expect(sql).toContain("recording_upload_claimed_at timestamptz");
    expect(sql).toContain("cardinality(participant_subjects) = cardinality(consent_ids)");
    expect(sql).toContain("force row level security");
    expect(sql).toContain("update (claimed_at, recording_upload_claimed_at)");
  });
});
