import { describe, expect, it } from "vitest";
import { drivePreviewUrl, enforceFullWorkspaceRoute } from "./mvp-boundary";

describe("storage-only MVP boundary", () => {
  it("allows full-workspace routes when the boundary is disabled", () => {
    expect(enforceFullWorkspaceRoute(false)).toBeUndefined();
  });

  it("redirects editor and collaboration routes to Drive", () => {
    try {
      enforceFullWorkspaceRoute(true);
      throw new Error("Expected storage-only route enforcement to redirect");
    } catch (error) {
      expect(error).toMatchObject({
        status: 307,
        options: { to: "/drive" },
      });
    }
  });

  it("builds an encoded, read-only Drive preview URL", () => {
    expect(drivePreviewUrl("folder/file id")).toBe("/api/drive/objects/folder%2Ffile%20id/preview");
  });
});
