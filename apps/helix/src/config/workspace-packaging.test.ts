import { describe, expect, it } from "vitest";
import {
  PRODUCTION_FULL_APPS_ALLOWLIST,
  PRODUCTION_MVP_APPS_ALLOWLIST,
  resolveWorkspacePackagingProfile,
  validateFullWorkspaceDependencyGates,
  validateWorkspaceAppsAllowlist,
} from "./workspace-packaging.js";

describe("workspace packaging profiles (PKG)", () => {
  it("defaults to mvp and resolves full aliases", () => {
    expect(resolveWorkspacePackagingProfile(undefined)).toBe("mvp");
    expect(resolveWorkspacePackagingProfile("full")).toBe("full");
    expect(resolveWorkspacePackagingProfile("v1")).toBe("full");
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
