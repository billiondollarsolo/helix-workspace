import { redirect } from "@tanstack/react-router";
import { CORE_WORKSPACE_STORAGE_ONLY } from "@/components/apps";

/**
 * Prevents editor and collaboration surfaces from being reached directly in
 * the storage-only deployment, even when a stale bookmark bypasses app-nav
 * filtering.
 */
export function enforceFullWorkspaceRoute(
  storageOnly: boolean = CORE_WORKSPACE_STORAGE_ONLY,
): void {
  if (!storageOnly) {
    return;
  }
  // TanStack Router signals navigation by throwing a redirect.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  throw redirect({ to: "/drive" });
}

/** The raw Drive preview endpoint is read-only and safe for MVP file viewing. */
export function drivePreviewUrl(objectId: string): string {
  return `/api/drive/objects/${encodeURIComponent(objectId)}/preview`;
}
