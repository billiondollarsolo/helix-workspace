/* Drive role vocabulary shared by the share dialog and the details panel. */

import type { DriveAccessRole } from "./api";

/** Role choices offered in the share UIs, in escalating-permission order. */
export const DRIVE_ACCESS_ROLE_OPTIONS: ReadonlyArray<{
  readonly role: DriveAccessRole;
  readonly label: string;
}> = [
  { role: "reader", label: "Viewer" },
  { role: "commenter", label: "Commenter" },
  { role: "editor", label: "Editor" },
];

/** Coerce an arbitrary role string from a <select> back into the union. */
export function driveAccessRoleValue(role: string): DriveAccessRole {
  return role === "commenter" || role === "editor" ? role : "reader";
}

export function driveAccessRoleLabel(role: string): string {
  if (role === "owner") return "Owner";
  return DRIVE_ACCESS_ROLE_OPTIONS.find((option) => option.role === role)?.label ?? role;
}
