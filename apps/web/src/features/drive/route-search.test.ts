import { describe, expect, it } from "vitest";
import { driveItemsInputFromRouteSearch, validateDriveRouteSearch } from "./queries";

describe("drive route search", () => {
  it("normalizes route search params for Drive list prefetching", () => {
    const search = validateDriveRouteSearch({
      file: " ",
      id: "33333333-3333-4333-8333-333333333333",
      folder: " root ",
      includeTrashed: "true",
      q: "  budget  ",
    });

    expect(search).toEqual({
      file: "33333333-3333-4333-8333-333333333333",
      folder: undefined,
      includeTrashed: true,
      q: "budget",
    });
    expect(driveItemsInputFromRouteSearch(search)).toEqual({
      folderId: null,
      includeTrashed: true,
      query: "budget",
      limit: 50,
      scope: "trash",
    });
  });

  it("keeps folder route state in the same shape used by Drive queries", () => {
    const search = validateDriveRouteSearch({
      folder: "44444444-4444-4444-8444-444444444444",
      includeTrashed: "0",
      q: "",
    });

    expect(search).toEqual({
      file: undefined,
      folder: "44444444-4444-4444-8444-444444444444",
      includeTrashed: undefined,
      q: undefined,
    });
    expect(driveItemsInputFromRouteSearch(search)).toEqual({
      folderId: "44444444-4444-4444-8444-444444444444",
      includeTrashed: false,
      query: "",
      limit: 100,
      scope: "my",
    });
  });

  it("keeps Workspace-style Drive scopes from route state", () => {
    const search = validateDriveRouteSearch({
      folder: "44444444-4444-4444-8444-444444444444",
      scope: "starred",
    });

    expect(search).toEqual({
      file: undefined,
      folder: "44444444-4444-4444-8444-444444444444",
      includeTrashed: undefined,
      q: undefined,
      scope: "starred",
    });
    expect(driveItemsInputFromRouteSearch(search)).toEqual({
      folderId: null,
      includeTrashed: false,
      query: "",
      limit: 100,
      scope: "starred",
    });
  });

  it("keeps folder navigation inside Shared with me", () => {
    const search = validateDriveRouteSearch({
      folder: "44444444-4444-4444-8444-444444444444",
      scope: "shared",
    });
    expect(driveItemsInputFromRouteSearch(search)).toEqual({
      folderId: "44444444-4444-4444-8444-444444444444",
      includeTrashed: false,
      query: "",
      limit: 100,
      scope: "shared",
    });
  });

  it("ignores folder filters when route state is scoped to trash", () => {
    expect(
      driveItemsInputFromRouteSearch({
        folder: "44444444-4444-4444-8444-444444444444",
        includeTrashed: true,
      }),
    ).toEqual({
      folderId: null,
      includeTrashed: true,
      query: "",
      limit: 100,
      scope: "trash",
    });
  });
});
