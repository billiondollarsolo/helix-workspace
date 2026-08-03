import { describe, expect, it } from "vitest";
import {
  PRODUCTION_FULL_APPS_ALLOWLIST,
  PRODUCTION_MVP_APPS_ALLOWLIST,
  PRODUCTION_MVP_DISABLED_MODULES,
  resolveWorkspacePackagingProfile,
  validateFullWorkspaceDependencyGates,
  validateWorkspaceAppsAllowlist,
} from "./workspace-packaging.js";

describe("workspace packaging profiles (PKG)", () => {
  it("defaults to mvp and resolves full aliases", () => {
    expect(resolveWorkspacePackagingProfile(undefined)).toBe("mvp");
    expect(resolveWorkspacePackagingProfile("")).toBe("mvp");
    expect(resolveWorkspacePackagingProfile("MVP")).toBe("mvp");
    expect(resolveWorkspacePackagingProfile("full")).toBe("full");
    expect(resolveWorkspacePackagingProfile("v1")).toBe("full");
    expect(resolveWorkspacePackagingProfile("full-workspace")).toBe("full");
  });

  it("accepts exact allowlists per profile", () => {
    expect(
      validateWorkspaceAppsAllowlist({
        profile: "mvp",
        apps: PRODUCTION_MVP_APPS_ALLOWLIST,
      }),
    ).toEqual([]);
    expect(
      validateWorkspaceAppsAllowlist({
        profile: "full",
        apps: PRODUCTION_FULL_APPS_ALLOWLIST,
      }),
    ).toEqual([]);
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["missing assistant", "mail,drive,chat"],
    ["extra editors", "mail,drive,chat,assistant,editors"],
    ["extra calendar", "mail,drive,chat,assistant,calendar"],
    ["extra docs", "mail,drive,chat,assistant,docs"],
    ["extra meet", "mail,drive,chat,assistant,meet"],
    ["extra sheets", "mail,drive,chat,assistant,sheets"],
    ["extra slides", "mail,drive,chat,assistant,slides"],
    ["reordered", "assistant,chat,drive,mail"],
    ["whitespace", "mail, drive, chat, assistant"],
    ["trailing comma", "mail,drive,chat,assistant,"],
    ["full allowlist under mvp", PRODUCTION_FULL_APPS_ALLOWLIST],
  ] as const)("rejects illegal MVP HELIX_APPS (%s)", (_label, apps) => {
    const issues = validateWorkspaceAppsAllowlist({ profile: "mvp", apps });
    expect(issues).toEqual([
      expect.objectContaining({
        variable: "HELIX_APPS",
        message: expect.stringMatching(/production MVP app allowlist/u),
      }),
    ]);
  });

  it.each([
    ["undefined", undefined],
    ["mvp allowlist under full", PRODUCTION_MVP_APPS_ALLOWLIST],
    ["missing meet", "mail,drive,chat,assistant,calendar,docs,sheets,slides"],
    ["reordered full", "mail,drive,chat,assistant,docs,calendar,meet,sheets,slides"],
    ["whitespace full", "mail, drive, chat, assistant, calendar, meet, docs, sheets, slides"],
  ] as const)("rejects illegal Full Workspace HELIX_APPS (%s)", (_label, apps) => {
    const issues = validateWorkspaceAppsAllowlist({ profile: "full", apps });
    expect(issues).toEqual([
      expect.objectContaining({
        variable: "HELIX_APPS",
        message: expect.stringMatching(/Full Workspace v1 app allowlist/u),
      }),
    ]);
  });

  it("documents MVP modules that production must force-disable", () => {
    expect([...PRODUCTION_MVP_DISABLED_MODULES]).toEqual(["docs", "calendar", "meet", "editors"]);
  });

  it("rejects meet without Jitsi config (fail-closed)", () => {
    const issues = validateFullWorkspaceDependencyGates({
      apps: PRODUCTION_FULL_APPS_ALLOWLIST,
      meetJitsiDomain: undefined,
      meetJitsiJwtSecret: "short",
      editorsMigrationsEnabled: "true",
      helixEditorsPinPresent: true,
      driveScannerKind: "clamav",
      securityTier: "business",
    });
    expect(issues.some((issue) => issue.variable === "MEET_JITSI_DOMAIN")).toBe(true);
    expect(issues.some((issue) => issue.variable === "MEET_JITSI_JWT_SECRET")).toBe(true);
  });

  it("rejects editors without migrations enabled", () => {
    const issues = validateFullWorkspaceDependencyGates({
      apps: "docs,sheets",
      editorsMigrationsEnabled: "false",
      helixEditorsPinPresent: true,
    });
    expect(issues.some((issue) => issue.variable === "HELIX_EDITORS_MIGRATIONS_ENABLED")).toBe(
      true,
    );
  });

  it("rejects business drive without clamav when scanner kind is known", () => {
    const issues = validateFullWorkspaceDependencyGates({
      apps: "drive",
      driveScannerKind: "noop",
      securityTier: "business",
    });
    expect(issues.some((issue) => issue.variable === "HELIX_DRIVE_SCANNER")).toBe(true);
  });
});
