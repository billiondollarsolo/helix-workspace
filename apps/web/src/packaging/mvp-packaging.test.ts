import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { workspaceAppsForBuild } from "@/components/apps";
import {
  isMvpOnlyBuild,
  mvpBundleBoundaryViolation,
  MVP_ROUTE_FILE_IGNORE_PATTERN,
} from "./mvp-packaging";

/** Full Workspace / non-route paths that must not appear in the MVP a11y matrix. */
const FULL_WORKSPACE_A11Y_PATH_PREFIXES = [
  "/docs",
  "/calendar",
  "/meet",
  "/sheets",
  "/slides",
] as const;

describe("production MVP packaging", () => {
  it("activates only for the exact production opt-in", () => {
    expect(isMvpOnlyBuild("true")).toBe(true);
    expect(isMvpOnlyBuild("TRUE")).toBe(false);
    expect(isMvpOnlyBuild("1")).toBe(false);
    expect(isMvpOnlyBuild(undefined)).toBe(false);
  });

  it("pairs VITE_HELIX_MVP_ONLY opt-in with the launcher allowlist filter", () => {
    // Build-time flag → runtime filter used by Rail/AppLauncher (apps.ts).
    const mvpOnly = isMvpOnlyBuild("true");
    expect(mvpOnly).toBe(true);
    expect(workspaceAppsForBuild(mvpOnly).map((app) => app.id)).toEqual([
      "mail",
      "drive",
      "chat",
      "assistant",
      "admin",
    ]);
    expect(workspaceAppsForBuild(isMvpOnlyBuild(undefined)).map((app) => app.id)).toContain(
      "calendar",
    );
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

  it("keeps the a11y quality-gates route matrix MVP-only", () => {
    const routesFile = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../quality-gates.routes.json",
    );
    const config = JSON.parse(readFileSync(routesFile, "utf8")) as {
      routes: Array<{ path: string }>;
    };
    expect(Array.isArray(config.routes)).toBe(true);
    expect(config.routes.length).toBeGreaterThan(0);

    for (const route of config.routes) {
      const pathOnly = route.path.split("?")[0] ?? route.path;
      for (const prefix of FULL_WORKSPACE_A11Y_PATH_PREFIXES) {
        expect(
          pathOnly === prefix || pathOnly.startsWith(`${prefix}/`),
          `${route.path} must not be Full Workspace path ${prefix}`,
        ).toBe(false);
      }
    }

    const paths = config.routes.map((route) => route.path.split("?")[0] ?? route.path);
    expect(paths).toContain("/mail");
    expect(paths).toContain("/drive");
    expect(paths).toContain("/chat");
    expect(paths).toContain("/assistant");
    expect(paths).toContain("/admin");
    expect(paths).toContain("/login");
  });
});
