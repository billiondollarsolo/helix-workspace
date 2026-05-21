import { describe, expect, it } from "vitest";
import { validateSearchRouteSearch } from "./index";

describe("search route", () => {
  it("validates query and result type URL state", () => {
    expect(
      validateSearchRouteSearch({
        q: " launch ",
        types: ["docs,drive", "unknown", "mail"],
      }),
    ).toEqual({
      q: "launch",
      types: ["docs", "drive", "mail"],
    });

    expect(validateSearchRouteSearch({ q: " ", type: "calendar" })).toEqual({
      types: ["calendar"],
    });
  });
});
