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
  return input.uploadState === "active" && input.available !== false;
}

export function openDenialMessage(state: DriveUploadState | null | undefined): string {
  const view = driveUploadStatusView(state);
  if (view === null) {
    return "This file is not available yet.";
  }
  switch (view.state) {
    case "pending_upload":
    case "uploaded":
    case "scanning":
      return `${view.label}. Download is disabled until the security scan finishes.`;
    case "quarantined":
      return "This file is quarantined and cannot be shared or downloaded.";
    case "scan_failed":
      return "Security scan failed for this file. Download is disabled.";
    case "trashed":
      return "This file is in trash. Restore it before downloading.";
    case "active":
      return "This file is available.";
  }
}
