import { describe, expect, it } from "vitest";
import type { GlobalSearchHit } from "./api";
import { validateSearchRouteSearch } from "./route-search";
import { searchHitSnippet, searchHitTarget, searchHitTitle } from "./search-hits";

describe("search hit routing", () => {
  it("maps each indexed type onto its surface URL state", () => {
    expect(
      searchHitTarget({ id: "m", type: "mail", attributes: { threadId: "t-1", messageId: "x" } }),
    ).toEqual({ to: "/mail", search: { thread: "t-1" } });
    expect(searchHitTarget({ id: "c", type: "chat", attributes: { roomId: "r-1" } })).toEqual({
      to: "/chat",
      search: { room: "r-1" },
    });
    expect(
      searchHitTarget({ id: "d", type: "drive", attributes: { fileId: "f-1", kind: "folder" } }),
    ).toEqual({ to: "/drive", search: { folder: "f-1" } });
    expect(
      searchHitTarget({
        id: "e",
        type: "calendar",
        attributes: { eventId: "e-1", startsAt: "2026-10-12T09:00:00.000Z" },
      }),
    ).toEqual({ to: "/calendar", search: { event: "e-1", date: "2026-10-12" } });
  });

  it("titles untitled mail and quotes only message text", () => {
    const hit: GlobalSearchHit = {
      id: "m",
      type: "mail",
      body: "Ava Stone <ava@helix.test>\nben@helix.test, Cara <cara@helix.test>\nThe harbor review moved to Thursday.",
      attributes: { fromName: "Ava Stone" },
    };
    expect(searchHitTitle(hit)).toBe("(no subject)");
    expect(searchHitSnippet(hit, "harbor")).toBe("The harbor review moved to Thursday.");
    expect(searchHitSnippet({ id: "d", type: "drive", body: "harbor.md" }, "harbor")).toBe("");
  });

  it("crops long message text around the first match", () => {
    const hit: GlobalSearchHit = {
      id: "c",
      type: "chat",
      body: `${"intro ".repeat(60)}harbor ${"tail ".repeat(60)}`,
    };
    const snippet = searchHitSnippet(hit, "harbor", 80);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("harbor");
  });

  it("accepts only known filters on /search", () => {
    expect(validateSearchRouteSearch({ q: " harbor ", type: "people" })).toEqual({
      q: "harbor",
      type: "people",
    });
    expect(validateSearchRouteSearch({ q: "", type: "docs" })).toEqual({});
  });
});
