import { describe, expect, it } from "vitest";
import {
  DEFAULT_MULTIPART_PART_SIZE,
  planMultipartParts,
  shouldUseMultipartUpload,
  validateCompletedParts,
} from "./multipart.js";

describe("shouldUseMultipartUpload", () => {
  it("is false when size is missing or under threshold", () => {
    expect(shouldUseMultipartUpload(undefined)).toBe(false);
    expect(shouldUseMultipartUpload(DEFAULT_MULTIPART_PART_SIZE)).toBe(false);
    expect(shouldUseMultipartUpload(DEFAULT_MULTIPART_PART_SIZE + 1)).toBe(true);
  });
});

describe("planMultipartParts", () => {
  it("splits into contiguous ranges", () => {
    const plan = planMultipartParts(20, 8);
    expect(plan.partCount).toBe(3);
    expect(plan.parts).toEqual([
      { partNumber: 1, start: 0, end: 8, size: 8 },
      { partNumber: 2, start: 8, end: 16, size: 8 },
      { partNumber: 3, start: 16, end: 20, size: 4 },
    ]);
  });

  it("returns empty plan for zero size", () => {
    expect(planMultipartParts(0).parts).toEqual([]);
  });
});

describe("validateCompletedParts", () => {
  it("accepts contiguous etagged parts", () => {
    expect(
      validateCompletedParts(
        [
          { partNumber: 2, etag: "b" },
          { partNumber: 1, etag: "a" },
        ],
        2,
      ),
    ).toEqual({ ok: true });
  });

  it("rejects gaps or missing etags", () => {
    expect(validateCompletedParts([{ partNumber: 1, etag: "a" }], 2).ok).toBe(false);
    expect(validateCompletedParts([{ partNumber: 1, etag: "  " }], 1).ok).toBe(false);
  });
});
