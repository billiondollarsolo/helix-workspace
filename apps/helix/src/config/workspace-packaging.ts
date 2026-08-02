/**
 * PKG — production workspace packaging profiles (MVP vs Full Workspace v1).
 * Full profile requires explicit HELIX_WORKSPACE_PROFILE=full and dependency gates.
 */

export type WorkspacePackagingProfile = "mvp" | "full";

export const PRODUCTION_MVP_APPS_ALLOWLIST = "mail,drive,chat,assistant";
export const PRODUCTION_FULL_APPS_ALLOWLIST =
  "mail,drive,chat,assistant,calendar,meet,docs,sheets,slides";

export const PRODUCTION_MVP_DISABLED_MODULES = ["docs", "calendar", "meet", "editors"] as const;

export interface PackagingIssue {
  readonly variable: string;
  readonly message: string;
}

export function resolveWorkspacePackagingProfile(
  raw: string | undefined | null,
): WorkspacePackagingProfile {
  const value = (raw ?? "mvp").trim().toLowerCase();
  if (value === "full" || value === "v1" || value === "full-workspace") {
    return "full";
  }
  return "mvp";
}

export function approvedAppsAllowlist(profile: WorkspacePackagingProfile): string {
  return profile === "full" ? PRODUCTION_FULL_APPS_ALLOWLIST : PRODUCTION_MVP_APPS_ALLOWLIST;
}

/** Exact production allowlist match (no reordering, no extra whitespace). */
export function allowlistsEqual(a: string | undefined | null, b: string): boolean {
  return (a ?? "") === b;
}

export function appsSet(raw: string | undefined | null): ReadonlySet<string> {
  if (raw === undefined || raw === null || raw.length === 0) {
    return new Set();
  }
  return new Set(
    raw
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => part.length > 0),
  );
}

/**
 * Fail-closed dependency gates when Full Workspace apps are enabled.
 * Call only for profile=full or when HELIX_APPS includes gated apps.
 */
export function validateFullWorkspaceDependencyGates(input: {
  readonly apps: string;
  readonly meetJitsiDomain?: string | undefined;
  readonly meetJitsiJwtSecret?: string | undefined;
  readonly editorsMigrationsEnabled?: string | undefined;
  readonly helixEditorsPinPresent?: boolean | undefined;
  readonly driveScannerKind?: string | undefined;
  readonly securityTier?: string | undefined;
}): readonly PackagingIssue[] {
  const issues: PackagingIssue[] = [];
  const apps = appsSet(input.apps);

  if (apps.has("meet")) {
    if (input.meetJitsiDomain === undefined || input.meetJitsiDomain.trim().length === 0) {
      issues.push({
        variable: "MEET_JITSI_DOMAIN",
        message: "is required when meet is in HELIX_APPS (Full Workspace)",
      });
    }
    if (input.meetJitsiJwtSecret === undefined || input.meetJitsiJwtSecret.trim().length < 32) {
      issues.push({
        variable: "MEET_JITSI_JWT_SECRET",
        message: "must be a strong secret (≥32 chars) when meet is enabled",
      });
    }
  }

  const editorsEnabled =
    apps.has("docs") || apps.has("sheets") || apps.has("slides") || apps.has("editors");
  if (editorsEnabled) {
    if (input.editorsMigrationsEnabled !== "true") {
      issues.push({
        variable: "HELIX_EDITORS_MIGRATIONS_ENABLED",
        message: "must be true when docs/sheets/slides are in HELIX_APPS",
      });
    }
    if (input.helixEditorsPinPresent === false) {
      issues.push({
        variable: "HELIX_EDITORS_PIN",
        message: "helix-editors pin/process must be present when editors apps are enabled",
      });
    }
  }

  if (apps.has("drive")) {
    const tier = (input.securityTier ?? "personal").toLowerCase();
    if (
      (tier === "business" || tier === "enterprise" || tier === "sovereign") &&
      input.driveScannerKind !== undefined &&
      input.driveScannerKind !== "clamav"
    ) {
      issues.push({
        variable: "HELIX_DRIVE_SCANNER",
        message: "Business+ drive requires ClamAV when Full Workspace packaging is active",
      });
    }
  }

  return issues;
}

export function validateWorkspaceAppsAllowlist(input: {
  readonly profile: WorkspacePackagingProfile;
  readonly apps: string | undefined;
}): readonly PackagingIssue[] {
  const expected = approvedAppsAllowlist(input.profile);
  if (!allowlistsEqual(input.apps, expected)) {
    return [
      {
        variable: "HELIX_APPS",
        message:
          input.profile === "full"
            ? "must exactly match the Full Workspace v1 app allowlist"
            : "must exactly match the approved production MVP app allowlist",
      },
    ];
  }
  return [];
}
