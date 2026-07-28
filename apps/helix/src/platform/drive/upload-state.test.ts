import { describe, expect, it } from "vitest";
import {
  DRIVE_UPLOAD_STATES,
  assertDriveUploadStateTransition,
  canTransitionDriveUploadState,
  isDriveFileAvailable,
  userFacingDriveUploadState,
} from "./upload-state.js";

describe("Drive upload state machine", () => {
  it("allows the production upload, scan, and trash lifecycle", () => {
    for (const [from, to] of [
      ["pending_upload", "uploaded"],
      ["uploaded", "scanning"],
      ["scanning", "active"],
      ["scanning", "quarantined"],
      ["scanning", "scan_failed"],
      ["active", "trashed"],
      ["scan_failed", "scanning"],
    ] as const) {
      expect(canTransitionDriveUploadState(from, to)).toBe(true);
      expect(() => {
        assertDriveUploadStateTransition(from, to);
      }).not.toThrow();
    }
  });

  it("rejects transitions that could publish unverified bytes", () => {
    for (const [from, to] of [
      ["pending_upload", "active"],
      ["uploaded", "active"],
      ["quarantined", "active"],
      ["scan_failed", "active"],
    ] as const) {
      expect(canTransitionDriveUploadState(from, to)).toBe(false);
      expect(() => {
        assertDriveUploadStateTransition(from, to);
      }).toThrow(`Illegal Drive upload state transition: ${from} -> ${to}`);
    }
  });

  it("exposes a safe user-facing status for every persisted state", () => {
    for (const state of DRIVE_UPLOAD_STATES) {
      const status = userFacingDriveUploadState(state);
      expect(status.label.length).toBeGreaterThan(0);
      expect(status.available).toBe(isDriveFileAvailable(state));
    }
    expect(DRIVE_UPLOAD_STATES.filter(isDriveFileAvailable)).toEqual(["active"]);
  });
});
