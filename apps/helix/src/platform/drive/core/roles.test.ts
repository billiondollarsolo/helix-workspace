import { describe, expect, it } from "vitest";
import { DRIVE_ROLES, driveRoleRank, hasRoleAtLeast, normalizeDriveRole } from "./roles.js";

describe("drive roles", () => {
  it("orders reader < commenter < editor < owner", () => {
    expect(driveRoleRank("reader")).toBeLessThan(driveRoleRank("commenter"));
    expect(driveRoleRank("commenter")).toBeLessThan(driveRoleRank("editor"));
    expect(driveRoleRank("editor")).toBeLessThan(driveRoleRank("owner"));
  });

  it("normalizes the legacy 'viewer' vocab to 'reader'", () => {
    expect(normalizeDriveRole("viewer")).toBe("reader");
    expect(normalizeDriveRole("editor")).toBe("editor");
    expect(normalizeDriveRole("unknown")).toBe("reader");
  });

  it("hasRoleAtLeast respects rank", () => {
    expect(hasRoleAtLeast("owner", "editor")).toBe(true);
    expect(hasRoleAtLeast("reader", "editor")).toBe(false);
    expect(hasRoleAtLeast("commenter", "commenter")).toBe(true);
  });

  it("exposes the four canonical roles", () => {
    expect(DRIVE_ROLES).toEqual(["reader", "commenter", "editor", "owner"]);
  });
});
