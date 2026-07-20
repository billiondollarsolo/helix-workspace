import { DRIVE_ROLES, type DriveRole } from "@helix/contracts";

export { DRIVE_ROLES, type DriveRole };

const ROLE_RANK: Record<DriveRole, number> = {
  reader: 0,
  commenter: 1,
  editor: 2,
  owner: 3,
};

export function driveRoleRank(role: DriveRole): number {
  return ROLE_RANK[role];
}

/** Maps legacy `"viewer"` → `"reader"`; unknown values floor to `"reader"`. */
export function normalizeDriveRole(raw: string): DriveRole {
  if (raw === "viewer") return "reader";
  if ((DRIVE_ROLES as readonly string[]).includes(raw)) {
    return raw as DriveRole;
  }
  return "reader";
}

export function hasRoleAtLeast(role: DriveRole, min: DriveRole): boolean {
  return driveRoleRank(role) >= driveRoleRank(min);
}
