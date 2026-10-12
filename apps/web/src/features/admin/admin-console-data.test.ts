import { describe, expect, it } from "vitest";
import {
  ADMIN_NAV_GROUPS,
  ADMIN_SECTION_IDS,
  hasAdminConsoleAccess,
  isAdminSectionId,
} from "./admin-console-data";

describe("admin section registry", () => {
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

describe("hasAdminConsoleAccess", () => {
  it("opens the console for wildcard and dotted admin grants", () => {
    expect(hasAdminConsoleAccess(["*"])).toBe(true);
    expect(hasAdminConsoleAccess(["admin.*"])).toBe(true);
    expect(hasAdminConsoleAccess(["mail.read", "admin.audit.read"])).toBe(true);
  });

  it("keeps members, the bare legacy marker and look-alikes out", () => {
    expect(hasAdminConsoleAccess([])).toBe(false);
    expect(hasAdminConsoleAccess(["mail.read", "drive.write"])).toBe(false);
    expect(hasAdminConsoleAccess(["admin"])).toBe(false);
    expect(hasAdminConsoleAccess(["administrator", "mail.admin"])).toBe(false);
  });
});
