import { describe, expect, it } from "vitest";
import { DEFAULT_HELIX_MODE, isSaas, isSingleTenant, resolveHelixMode } from "./index.js";

describe("HELIX_MODE helpers", () => {
  it("defaults to single-tenant", () => {
    expect(DEFAULT_HELIX_MODE).toBe("single-tenant");
    expect(resolveHelixMode()).toBe("single-tenant");
    expect(isSingleTenant()).toBe(true);
    expect(isSaas()).toBe(false);
  });

  it("resolves explicit mode values and loaded config objects", () => {
    expect(resolveHelixMode("multi-tenant-saas")).toBe("multi-tenant-saas");
    expect(isSaas({ mode: "multi-tenant-saas" })).toBe(true);
    expect(isSingleTenant({ mode: "multi-tenant-saas" })).toBe(false);
  });
});
