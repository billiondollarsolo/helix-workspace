import { describe, expect, it } from "vitest";
import { canOpenDriveObject, driveUploadStatusView, openDenialMessage } from "./upload-status-ui";

describe("Drive upload status UI (D8)", () => {
  it.each([
    ["pending_upload", false, "Waiting for upload"],
    ["uploaded", false, "Queued for security scan"],
    ["scanning", false, "Scanning for malware"],
    ["active", true, "Available"],
    ["quarantined", false, "Quarantined"],
    ["scan_failed", false, "Security scan failed"],
    ["trashed", false, "In trash"],
  ] as const)("maps %s → available=%s / label", (state, available, label) => {
    const view = driveUploadStatusView(state);
    expect(view).not.toBeNull();
    expect(view?.available).toBe(available);
    expect(view?.label).toBe(label);
    expect(canOpenDriveObject({ uploadState: state })).toBe(available);
  });

  it("denies when either available=false or a non-active upload state is present", () => {
    expect(canOpenDriveObject({ available: false })).toBe(false);
    expect(canOpenDriveObject({ available: true, uploadState: "quarantined" })).toBe(false);
    expect(canOpenDriveObject({ available: true, uploadState: "active" })).toBe(true);
  });

  it("defaults unknown/legacy entries to openable for backward compatibility", () => {
    expect(canOpenDriveObject({})).toBe(true);
    expect(canOpenDriveObject({ uploadState: undefined })).toBe(true);
  });

  it("explains open denials for quarantine and processing states", () => {
    expect(openDenialMessage("quarantined")).toMatch(/quarantined/i);
    expect(openDenialMessage("scanning")).toMatch(/security scan/i);
    expect(openDenialMessage("scan_failed")).toMatch(/scan failed/i);
  });
});
