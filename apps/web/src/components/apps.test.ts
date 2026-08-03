import { describe, expect, it } from "vitest";
import { workspaceAppsForBuild } from "./apps";

/** Primary launcher apps under VITE_HELIX_MVP_ONLY=true (production MVP). */
const MVP_PRIMARY_APP_IDS = ["mail", "drive", "chat", "assistant", "admin"] as const;
const FULL_WORKSPACE_EXCLUDED_FROM_MVP = ["calendar", "docs", "sheets", "slides", "meet"] as const;

describe("workspaceAppsForBuild", () => {
  it("limits MVP packaging to mail, drive, chat, assistant, and admin", () => {
    const ids = workspaceAppsForBuild(true).map((app) => app.id);
    expect(ids).toEqual([...MVP_PRIMARY_APP_IDS]);
    for (const excluded of FULL_WORKSPACE_EXCLUDED_FROM_MVP) {
      expect(ids, excluded).not.toContain(excluded);
    }
  });

  it.each([...FULL_WORKSPACE_EXCLUDED_FROM_MVP])(
    "does not advertise %s as a primary MVP launcher app",
    (appId) => {
      expect(workspaceAppsForBuild(true).map((app) => app.id)).not.toContain(appId);
    },
  );

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
    for (const excluded of FULL_WORKSPACE_EXCLUDED_FROM_MVP) {
      expect(ids).toContain(excluded);
    }
  });
});
