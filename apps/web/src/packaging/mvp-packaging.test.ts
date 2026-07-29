import { describe, expect, it } from "vitest";
import {
  isMvpOnlyBuild,
  mvpBundleBoundaryViolation,
  MVP_ROUTE_FILE_IGNORE_PATTERN,
} from "./mvp-packaging";

describe("production MVP packaging", () => {
  it("activates only for the exact production opt-in", () => {
    expect(isMvpOnlyBuild("true")).toBe(true);
    expect(isMvpOnlyBuild("TRUE")).toBe(false);
    expect(isMvpOnlyBuild("1")).toBe(false);
    expect(isMvpOnlyBuild(undefined)).toBe(false);
  });

  it("excludes editor and deferred collaboration route directories", () => {
    const ignoredRoute = new RegExp(MVP_ROUTE_FILE_IGNORE_PATTERN);

    for (const surface of ["calendar", "docs", "sheets", "slides", "meet", "pdf"]) {
      expect(ignoredRoute.test(surface), surface).toBe(true);
    }
    for (const retained of ["mail", "drive", "open", "media", "chat", "assistant", "admin"]) {
      expect(ignoredRoute.test(retained), retained).toBe(false);
    }
  });

  it("fails closed on native route, feature, conversion, and editor package modules", () => {
    const forbiddenIds = [
      "/repo/apps/web/src/routes/_shell/docs/$documentId.tsx",
      "/repo/apps/web/src/routes/_shell/pdf/$objectId.tsx?tsr-split",
      "/repo/apps/web/src/features/sheets/native-spreadsheet-editor.tsx",
      "/repo/apps/web/src/features/_open/converters.ts",
      "/repo/node_modules/@helix/editors-ui/dist/index.js",
      "/repo/node_modules/@tiptap/extension-collaboration/dist/index.js",
      "/repo/node_modules/yjs/dist/yjs.mjs",
      "/repo/node_modules/pdf-lib/es/index.js",
      "/repo/node_modules/@pdf-lib/standard-fonts/es/index.js",
    ];

    for (const moduleId of forbiddenIds) {
      expect(mvpBundleBoundaryViolation(moduleId), moduleId).not.toBeNull();
    }
  });

  it("permits storage and read-only preview modules", () => {
    const retainedIds = [
      "/repo/apps/web/src/routes/_shell/drive/index.tsx",
      "/repo/apps/web/src/routes/_shell/open/$objectId.tsx",
      "/repo/apps/web/src/routes/_shell/media/$objectId.tsx",
      "/repo/apps/web/src/features/_open/ui/ImportedDocumentRenderer.tsx",
      "/repo/apps/web/src/features/drive/file-thumbnail.tsx",
      "/repo/node_modules/pdfjs-dist/build/pdf.mjs",
      "/repo/node_modules/@helix/editors-format-loader/dist/index.js",
    ];

    for (const moduleId of retainedIds) {
      expect(mvpBundleBoundaryViolation(moduleId), moduleId).toBeNull();
    }
  });
});
