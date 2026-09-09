import { describe, expect, it } from "vitest";
import {
  adminSearchForKey,
  resolveClosedSearchParam,
  validateAdminSectionSearch,
} from "./admin-section-search";

describe("validateAdminSectionSearch", () => {
  it("keeps known keys and drops empty values", () => {
    expect(
      validateAdminSectionSearch({
        tab: " spam ",
        tier: "enterprise",
        q: "",
        junk: "x",
      }),
    ).toEqual({ tab: "spam", tier: "enterprise" });
  });
});

describe("resolveClosedSearchParam", () => {
  const tabs = ["outbound", "inbound", "deliveries"] as const;

  it("accepts allowed values and falls back on unknown", () => {
    expect(resolveClosedSearchParam("inbound", tabs, "outbound")).toBe("inbound");
    expect(resolveClosedSearchParam("nope", tabs, "outbound")).toBe("outbound");
    expect(resolveClosedSearchParam(undefined, tabs, "outbound")).toBe("outbound");
  });
});

describe("adminSearchForKey", () => {
  it("omits defaults and empty strings", () => {
    expect(adminSearchForKey("tab", "providers", "providers")).toEqual({});
    expect(adminSearchForKey("tab", "spam", "providers")).toEqual({ tab: "spam" });
    expect(adminSearchForKey("q", "")).toEqual({});
    expect(adminSearchForKey("q", "mira")).toEqual({ q: "mira" });
  });
});
