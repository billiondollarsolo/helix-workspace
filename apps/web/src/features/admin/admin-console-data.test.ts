import { describe, expect, it } from "vitest";
import {
  ADMIN_NAV_GROUPS,
  ADMIN_NAV_GROUPS_FOR_BUILD,
  ADMIN_SECTION_IDS,
  isAdminSectionId,
} from "./admin-console-data";

describe("admin section capabilities", () => {
  /* Billing is metered SaaS plumbing. On a self-hosted build the endpoints
     answer 404, so a nav slot for it leads only to that section's own error. */
  it("omits billing from the nav on a build without it", () => {
    const shown = ADMIN_NAV_GROUPS_FOR_BUILD.flatMap((group) => group.items.map((item) => item.id));
    expect(shown).not.toContain("billing");
    // Everything else still ships.
    expect(shown).toContain("domains");
    expect(shown).toContain("workspace-settings");
  });

  it("404s /admin/billing rather than leaving it reachable by URL", () => {
    // Hiding the link while the route still renders would leave a page that
    // can only ever show "billing may not be enabled for this workspace".
    expect(isAdminSectionId("billing")).toBe(false);
    expect(isAdminSectionId("domains")).toBe(true);
    expect(isAdminSectionId("not-a-section")).toBe(false);
  });

  it("keeps billing in the id list so the section registry stays exhaustive", () => {
    /* `SECTION_CONTENT` is keyed by `AdminSectionId`; dropping the id from the
       type would make a hosted build's billing entry a type error. The section
       is gated, not deleted. */
    expect(ADMIN_SECTION_IDS).toContain("billing");
  });

  it("drops a group that a build empties rather than rendering a bare heading", () => {
    for (const group of ADMIN_NAV_GROUPS_FOR_BUILD) {
      expect(group.items.length).toBeGreaterThan(0);
    }
    // Organization keeps Domains and Workspace settings, so it survives.
    expect(ADMIN_NAV_GROUPS_FOR_BUILD.map((group) => group.title)).toEqual(
      ADMIN_NAV_GROUPS.map((group) => group.title),
    );
  });
});
