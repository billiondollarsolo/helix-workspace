import { describe, expect, it } from "vitest";
import { ADMIN_NAV_GROUPS, ADMIN_SECTION_IDS, isAdminSectionId } from "./admin-console-data";

describe("admin section registry", () => {
  /* Helix is free and open source with no plans or billing, so the console has
     no billing, plan or upgrade section at all. */
  it("has no billing section", () => {
    const shown = ADMIN_NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id));
    expect(shown).not.toContain("billing");
    expect(ADMIN_SECTION_IDS).not.toContain("billing");
    expect(isAdminSectionId("billing")).toBe(false);
  });

  it("accepts every nav section and rejects unknown ids", () => {
    for (const id of ADMIN_SECTION_IDS) {
      expect(isAdminSectionId(id)).toBe(true);
    }
    expect(isAdminSectionId("domains")).toBe(true);
    expect(isAdminSectionId("not-a-section")).toBe(false);
  });

  it("never renders an empty nav group", () => {
    for (const group of ADMIN_NAV_GROUPS) {
      expect(group.items.length).toBeGreaterThan(0);
    }
  });
});
