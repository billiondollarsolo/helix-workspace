import { DRIVE_ROLES, driveRoleSchema, type DriveRole } from "@helix/contracts";

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

export function parseDriveRole(raw: string): DriveRole {
  return driveRoleSchema.parse(raw);
}

export function hasRoleAtLeast(role: DriveRole, min: DriveRole): boolean {
  return driveRoleRank(role) >= driveRoleRank(min);
}
