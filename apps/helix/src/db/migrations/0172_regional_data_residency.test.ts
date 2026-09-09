import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("./0172_regional_data_residency.sql", import.meta.url),
  "utf8",
);

describe("0172 regional data residency", () => {
  it("makes placement canonical, storage-aligned, and immutable", () => {
    expect(migration).toContain("orgs_region_canonical_check");
    expect(migration).toContain("orgs_byo_storage_region_check");
    expect(migration).toContain("byo_config->'storage'->>'region' = region");
    expect(migration).toContain("before update of region on orgs");
    expect(migration).toContain("org region is immutable");
  });
});
