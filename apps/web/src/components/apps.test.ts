import { describe, expect, it } from "vitest";
import { workspaceAppsForBuild } from "./apps";

describe("workspaceAppsForBuild", () => {
  it("limits MVP packaging to mail, drive, chat, assistant, and admin", () => {
    const ids = workspaceAppsForBuild(true).map((app) => app.id);
    expect(ids).toEqual(["mail", "drive", "chat", "assistant", "admin"]);
    expect(ids).not.toContain("meet");
    expect(ids).not.toContain("calendar");
    expect(ids).not.toContain("docs");
  });

  it("exposes the full registry when MVP-only packaging is off", () => {
    const ids = workspaceAppsForBuild(false).map((app) => app.id);
    expect(ids).toEqual([
      "mail",
      "calendar",
      "drive",
      "docs",
      "sheets",
      "slides",
      "meet",
      "chat",
      "assistant",
      "admin",
    ]);
  });
});
