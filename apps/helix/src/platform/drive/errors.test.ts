import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/api-error.js";
import {
  DriveForbiddenError,
  DriveNotFoundError,
  DriveQuotaExceededError,
  DriveStorageQuotaExceededError,
} from "./errors.js";

describe("drive errors", () => {
  it("DriveNotFoundError is ApiError not_found", () => {
    const e = new DriveNotFoundError("gone");
    expect(e).toBeInstanceOf(ApiError);
    expect(e.code).toBe("not_found");
    expect(e.statusCode).toBe(404);
  });

  it("DriveForbiddenError is ApiError forbidden", () => {
    const e = new DriveForbiddenError("nope");
    expect(e.code).toBe("forbidden");
    expect(e.statusCode).toBe(403);
  });

  it("quota error carries projected bytes", () => {
    const e = new DriveQuotaExceededError("org", 100, 150);
    expect(e.statusCode).toBe(409);
    expect(e.projectedBytes).toBe(150);
    expect(new DriveStorageQuotaExceededError("org", 1, 2)).toBeInstanceOf(
      DriveQuotaExceededError,
    );
  });
});
