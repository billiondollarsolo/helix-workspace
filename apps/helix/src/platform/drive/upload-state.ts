import { DRIVE_UPLOAD_STATES, type DriveUploadState } from "@helix/contracts";

export { DRIVE_UPLOAD_STATES };
export type { DriveUploadState };

const TRANSITIONS: Readonly<Record<DriveUploadState, readonly DriveUploadState[]>> = {
  pending_upload: ["uploaded", "trashed"],
  uploaded: ["scanning", "trashed"],
  scanning: ["active", "quarantined", "scan_failed", "trashed"],
  active: ["trashed"],
  quarantined: ["trashed"],
  scan_failed: ["scanning", "trashed"],
  trashed: ["active", "quarantined", "scan_failed"],
};

export function isDriveUploadState(value: unknown): value is DriveUploadState {
  return typeof value === "string" && DRIVE_UPLOAD_STATES.includes(value as DriveUploadState);
}

export function canTransitionDriveUploadState(
  from: DriveUploadState,
  to: DriveUploadState,
): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function assertDriveUploadStateTransition(
  from: DriveUploadState,
  to: DriveUploadState,
): void {
  if (!canTransitionDriveUploadState(from, to)) {
    throw new Error(`Illegal Drive upload state transition: ${from} -> ${to}`);
  }
}

export function isDriveFileAvailable(state: DriveUploadState): boolean {
  return state === "active";
}

export function userFacingDriveUploadState(state: DriveUploadState): {
  readonly label: string;
  readonly available: boolean;
  readonly terminal: boolean;
} {
  switch (state) {
    case "pending_upload":
      return { label: "Waiting for upload", available: false, terminal: false };
    case "uploaded":
      return { label: "Queued for security scan", available: false, terminal: false };
    case "scanning":
      return { label: "Scanning for malware", available: false, terminal: false };
    case "active":
      return { label: "Available", available: true, terminal: true };
    case "quarantined":
      return { label: "Quarantined", available: false, terminal: true };
    case "scan_failed":
      return { label: "Security scan failed", available: false, terminal: true };
    case "trashed":
      return { label: "In trash", available: false, terminal: true };
  }
}
