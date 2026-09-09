import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0166 calendar scheduling resources", () => {
  it("persists profiles and prevents approved resource overlap", async () => {
    const migration = await readFile(
      new URL("./0166_calendar_scheduling_resources.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("external_availability text not null default 'none'");
    expect(migration).toContain("external_availability in ('none', 'busy')");
    expect(migration).toContain("approval_policy in ('auto', 'manual')");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("raise exclusion_violation");
    expect(migration).toContain("cal_resource_bookings_no_overlap");
    expect(migration).toContain("force row level security");
    expect(migration).toContain("helix_validate_calendar_scheduling_tenant");
  });
});
