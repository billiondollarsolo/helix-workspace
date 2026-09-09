import { describe, expect, it } from "vitest";
import {
  DRIVE_PLATFORM_DEFAULT_ORPHAN_GRACE_HOURS,
  DRIVE_PLATFORM_DEFAULT_TRASH_RETENTION_DAYS,
  describeDriveAdminUnavailable,
  formatLifecycleSummary,
  formatQuotaSummary,
  lifecycleFormFromPolicy,
  mapLifecycleFormToToolInput,
} from "./drive-admin-api";

describe("drive-admin-api mappers (D11)", () => {
  it("maps a valid lifecycle form to tool input", () => {
    expect(
      mapLifecycleFormToToolInput({
        trashRetentionDays: String(DRIVE_PLATFORM_DEFAULT_TRASH_RETENTION_DAYS),
        orphanGraceHours: String(DRIVE_PLATFORM_DEFAULT_ORPHAN_GRACE_HOURS),
      }),
    ).toEqual({
      trashRetentionDays: DRIVE_PLATFORM_DEFAULT_TRASH_RETENTION_DAYS,
      orphanGraceHours: DRIVE_PLATFORM_DEFAULT_ORPHAN_GRACE_HOURS,
    });
  });

  it("rejects out-of-range lifecycle fields", () => {
    expect(
      mapLifecycleFormToToolInput({ trashRetentionDays: "0", orphanGraceHours: "24" }),
    ).toMatch(/Trash retention/);
    expect(
      mapLifecycleFormToToolInput({ trashRetentionDays: "30", orphanGraceHours: "9999" }),
    ).toMatch(/Orphan grace/);
  });

  it("hydrates form fields from a policy view", () => {
    expect(
      lifecycleFormFromPolicy({
        orgId: "11111111-1111-4111-8111-111111111111",
        trashRetentionDays: 90,
        orphanGraceHours: 12,
        updatedByActorId: null,
        updatedAt: null,
        configured: false,
      }),
    ).toEqual({ trashRetentionDays: "90", orphanGraceHours: "12" });
  });

  it("formats quota and lifecycle summaries for operators", () => {
    expect(
      formatQuotaSummary({
        orgId: "11111111-1111-4111-8111-111111111111",
        usedBytes: 1024,
        limitBytes: 2048,
        unlimited: false,
        percentUsed: 50,
      }),
    ).toMatch(/50%/);
    expect(
      formatLifecycleSummary({
        orgId: "11111111-1111-4111-8111-111111111111",
        trashRetentionDays: 30,
        orphanGraceHours: 24,
        updatedByActorId: null,
        updatedAt: null,
        configured: false,
      }),
    ).toMatch(/platform default/);
  });

  it("explains missing admin.drive scope honestly", () => {
    expect(describeDriveAdminUnavailable(new Error("403 Forbidden"))).toMatch(/admin\.drive/);
  });
});
