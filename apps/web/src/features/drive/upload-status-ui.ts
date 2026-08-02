/* Drive upload/scan lifecycle presentation helpers (D8).
 *
 * Pure helpers so list/grid badges and open-path denials stay consistent with
 * the server `userFacingDriveUploadState` labels without importing server code.
 */

import type { DriveUploadState } from "@helix/contracts";

export interface DriveUploadStatusView {
  readonly state: DriveUploadState;
  readonly label: string;
  readonly available: boolean;
  readonly terminal: boolean;
  /** Semantic tone for badges / alerts. */
  readonly tone: "neutral" | "progress" | "danger" | "success";
}

const STATUS_VIEWS: Readonly<Record<DriveUploadState, DriveUploadStatusView>> = {
  pending_upload: {
    state: "pending_upload",
    label: "Waiting for upload",
    available: false,
    terminal: false,
    tone: "progress",
  },
  uploaded: {
    state: "uploaded",
    label: "Queued for security scan",
    available: false,
    terminal: false,
    tone: "progress",
  },
  scanning: {
    state: "scanning",
    label: "Scanning for malware",
    available: false,
    terminal: false,
    tone: "progress",
  },
  active: {
    state: "active",
    label: "Available",
    available: true,
    terminal: true,
    tone: "success",
  },
  quarantined: {
    state: "quarantined",
    label: "Quarantined",
    available: false,
    terminal: true,
    tone: "danger",
  },
  scan_failed: {
    state: "scan_failed",
    label: "Security scan failed",
    available: false,
    terminal: true,
    tone: "danger",
  },
  trashed: {
    state: "trashed",
    label: "In trash",
    available: false,
    terminal: true,
    tone: "neutral",
  },
};

export function driveUploadStatusView(
  state: DriveUploadState | null | undefined,
): DriveUploadStatusView | null {
  if (state === null || state === undefined) return null;
  if (!(state in STATUS_VIEWS)) return null;
  return STATUS_VIEWS[state];
}

/** Content open/download/share is only allowed for active objects. */
export function canOpenDriveObject(input: {
  readonly uploadState?: DriveUploadState | null | undefined;
  readonly available?: boolean | null | undefined;
}): boolean {
  // Either signal may deny; both must allow (or be omitted for legacy rows).
  if (input.available === false) return false;
  const view = driveUploadStatusView(input.uploadState);
  if (view !== null && !view.available) return false;
  if (input.available === true) return true;
  // Unknown / omitted state: treat as available for backward compatibility
  // with entries that predate uploadState on the wire.
  return view === null ? true : view.available;
}

export function openDenialMessage(
  state: DriveUploadState | null | undefined,
): string {
  const view = driveUploadStatusView(state);
  if (view === null) {
    return "This file is not available yet.";
  }
  switch (view.state) {
    case "pending_upload":
    case "uploaded":
    case "scanning":
      return `${view.label}. Open and download are disabled until the security scan finishes.`;
    case "quarantined":
      return "This file is quarantined and cannot be opened, shared, or downloaded.";
    case "scan_failed":
      return "Security scan failed for this file. Open and download are disabled.";
    case "trashed":
      return "This file is in trash. Restore it before opening.";
    case "active":
      return "This file is available.";
  }
}

export function badgeStyleForTone(tone: DriveUploadStatusView["tone"]): {
  readonly background: string;
  readonly color: string;
  readonly border: string;
} {
  switch (tone) {
    case "danger":
      return {
        background: "var(--danger-soft, #fef2f2)",
        color: "var(--danger, #dc2626)",
        border: "1px solid var(--danger, #dc2626)",
      };
    case "progress":
      return {
        background: "var(--accent-soft, #eff6ff)",
        color: "var(--accent, #2563eb)",
        border: "1px solid var(--accent, #2563eb)",
      };
    case "success":
      return {
        background: "var(--surface-2, #f8fafc)",
        color: "var(--text-2, #475569)",
        border: "1px solid var(--border, #e2e8f0)",
      };
    case "neutral":
    default:
      return {
        background: "var(--surface-2, #f8fafc)",
        color: "var(--text-3, #64748b)",
        border: "1px solid var(--border, #e2e8f0)",
      };
  }
}
