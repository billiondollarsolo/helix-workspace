import { describe, expect, it } from "vitest";
import { distinctStoredBytes, projectQuota } from "./quota.js";

describe("projectQuota", () => {
  it("flags exceeded when used + delta crosses the limit", () => {
    expect(projectQuota({ usedBytes: 90, limitBytes: 100, byteDelta: 20 })).toEqual({
      projectedBytes: 110,
      exceeded: true,
    });
  });

  it("stays within budget at the boundary", () => {
    expect(projectQuota({ usedBytes: 80, limitBytes: 100, byteDelta: 20 }).exceeded).toBe(false);
  });
});

describe("distinctStoredBytes", () => {
  it("counts each storage key once", () => {
    expect(
      distinctStoredBytes([
        { storageKey: "k1", byteSize: 10 },
        { storageKey: "k1", byteSize: 10 },
        { storageKey: "k2", byteSize: 5 },
      ]),
    ).toBe(15);
  });
});
