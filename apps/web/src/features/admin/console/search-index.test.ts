import { describe, expect, it } from "vitest";
import { ADMIN_NAV_GROUPS } from "@/features/admin/admin-console-data";
import { ADMIN_SEARCH_INDEX, searchAdminSettings } from "./search-index";

describe("admin settings search index", () => {
  it("indexes every page in the nav", () => {
    for (const group of ADMIN_NAV_GROUPS) {
      for (const item of group.items) {
        expect(ADMIN_SEARCH_INDEX.some((entry) => entry.section === item.id)).toBe(true);
      }
    }
  });

  it("finds settings by the words people search for", () => {
    expect(searchAdminSettings("dkim")[0]).toMatchObject({ section: "mail", tab: "domains" });
    expect(searchAdminSettings("mfa")[0]).toMatchObject({
      title: "Multi-factor authentication",
      section: "policies",
    });
    expect(searchAdminSettings("legal hold")[0]).toMatchObject({ section: "chat" });
    expect(searchAdminSettings("rclone")[0]).toMatchObject({ section: "drive" });
  });

  it("finds the three app switches in their app pages", () => {
    expect(searchAdminSettings("calendar invitations")[0]).toMatchObject({
      title: "Import calendar invitations from email",
      section: "calendar",
    });
    expect(searchAdminSettings("assistant searches")[0]).toMatchObject({
      section: "assistant",
      tab: "search",
    });
    expect(searchAdminSettings("s3")[0]).toMatchObject({ section: "drive" });
  });

  it("ranks title matches above keyword matches", () => {
    const results = searchAdminSettings("audit");
    expect(results[0]).toMatchObject({ title: "Audit log", section: "audit" });
  });

  it("says where each result lives", () => {
    expect(searchAdminSettings("spam filtering")[0]?.location).toBe("Workspace settings › Mail");
  });

  it("returns nothing for blank or unknown text", () => {
    expect(searchAdminSettings("   ")).toEqual([]);
    expect(searchAdminSettings("zzzz-not-a-setting")).toEqual([]);
  });

  it("caps the result count", () => {
    expect(searchAdminSettings("a", 3)).toHaveLength(3);
  });
});
