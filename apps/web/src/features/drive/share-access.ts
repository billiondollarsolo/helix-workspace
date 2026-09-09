/* Shared share/access primitives for the Drive surfaces.
 *
 * The Drive shell's inline share panel and the standalone share dialog present
 * the same role vocabulary and accept the same free-text recipient input, so
 * the role options and the actor-id/actor-ref split live here rather than being
 * mirrored in both components. */

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** Split typed recipients into actor ids (UUIDs) and free-text refs (emails,
 *  handles) so the backend can resolve each kind on its own path. */
export function driveShareTargetsFromInput(targets: readonly string[]): {
  readonly actorIds: readonly string[];
  readonly actorRefs: readonly string[];
} {
  const actorIds: string[] = [];
  const actorRefs: string[] = [];
  for (const target of targets) {
    if (UUID_PATTERN.test(target)) {
      actorIds.push(target);
    } else {
      actorRefs.push(target);
    }
  }
  return { actorIds, actorRefs };
}

/** Coerce an arbitrary role string from a <select> back into the union. */
export function driveAccessRoleValue(role: string): DriveAccessRole {
  return role === "commenter" || role === "editor" ? role : "reader";
}

export function driveAccessRoleLabel(role: string): string {
  return DRIVE_ACCESS_ROLE_OPTIONS.find((option) => option.role === role)?.label ?? role;
}
