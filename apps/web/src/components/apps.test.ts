import { describe, expect, it } from "vitest";
import { workspaceAppsForBuild } from "./apps";

describe("Workspace application packaging", () => {
  it("exposes only the approved core Workspace surfaces in the MVP build", () => {
    expect(workspaceAppsForBuild(true).map((app) => app.id)).toEqual([
      "mail",
      "drive",
      "chat",
      "assistant",
      "admin",
    ]);
  });

  it("keeps editor surfaces available to explicit future/development builds", () => {
    expect(workspaceAppsForBuild(false).map((app) => app.id)).toEqual([
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
