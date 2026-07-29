import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { pruneProductionDeploy } from "./prune-production-deploy.mjs";

function writePackage(root, name, version) {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version }));
}

function writeHelixDeployRoot(root) {
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "@helix/app", version: "1.0.0" }),
  );
  mkdirSync(join(root, "dist"), { recursive: true });
  writeFileSync(join(root, "dist/index.js"), "export {};\n");
}

describe("production deploy pruning", () => {
  it("removes only unreachable virtual-store entries and package-manager metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "helix-production-prune-test-"));
    const store = join(root, "node_modules/.pnpm");
    const app = join(store, "app@1.0.0/node_modules/app");
    const dependency = join(store, "dependency@2.0.0/node_modules/dependency");
    const orphan = join(store, "build-only@3.0.0/node_modules/build-only");
    try {
      writeHelixDeployRoot(root);
      writePackage(app, "app", "1.0.0");
      writePackage(dependency, "dependency", "2.0.0");
      writePackage(orphan, "build-only", "3.0.0");
      symlinkSync(".pnpm/app@1.0.0/node_modules/app", join(root, "node_modules/app"));
      symlinkSync(
        "../../dependency@2.0.0/node_modules/dependency",
        join(store, "app@1.0.0/node_modules/dependency"),
      );
      writeFileSync(join(store, "lock.yaml"), "lockfileVersion: 9\n");
      writeFileSync(join(root, "node_modules/.modules.yaml"), "virtualStoreDir: .pnpm\n");

      const result = pruneProductionDeploy(root);

      expect(result).toEqual({
        reachablePackages: 2,
        reachableStoreEntries: 2,
        removedEntries: 1,
      });
      expect(existsSync(join(store, "app@1.0.0"))).toBe(true);
      expect(existsSync(join(store, "dependency@2.0.0"))).toBe(true);
      expect(existsSync(join(store, "build-only@3.0.0"))).toBe(false);
      expect(existsSync(join(store, "lock.yaml"))).toBe(false);
      expect(existsSync(join(root, "node_modules/.modules.yaml"))).toBe(false);
      expect(readlinkSync(join(root, "node_modules/app"))).toContain("app@1.0.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed rather than producing an empty deployment", () => {
    const root = mkdtempSync(join(tmpdir(), "helix-production-prune-empty-test-"));
    try {
      writeHelixDeployRoot(root);
      mkdirSync(join(root, "node_modules/.pnpm"), { recursive: true });
      expect(() => pruneProductionDeploy(root)).toThrow("dependency graph is empty");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an arbitrary pnpm project as a destructive target", () => {
    const root = mkdtempSync(join(tmpdir(), "helix-production-prune-hostile-test-"));
    try {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "unrelated-project" }));
      mkdirSync(join(root, "dist"), { recursive: true });
      writeFileSync(join(root, "dist/index.js"), "export {};\n");
      mkdirSync(join(root, "node_modules/.pnpm/orphan@1.0.0"), { recursive: true });

      expect(() => pruneProductionDeploy(root)).toThrow("Refusing non-Helix");
      expect(existsSync(join(root, "node_modules/.pnpm/orphan@1.0.0"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
