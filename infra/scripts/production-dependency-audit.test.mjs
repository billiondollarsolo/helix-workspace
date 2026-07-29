import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  evaluateAudit,
  productionDependencyInventory,
  validateExceptions,
} from "./production-dependency-audit.mjs";

const exception = {
  schemaVersion: 1,
  exceptions: [
    {
      advisory: "GHSA-2345-2345-2345",
      package: "time-bounded-example",
      allowedVersions: ["1.2.3"],
      expiresOn: "2026-08-11",
      owner: "security",
      rationale: "Synthetic test fixture for exact-version exception enforcement.",
    },
  ],
};

function report(advisories = {}) {
  return { advisories };
}

function advisory({
  id = "GHSA-2345-2345-2345",
  module = "time-bounded-example",
  severity = "high",
  versions = ["1.2.3"],
} = {}) {
  return {
    github_advisory_id: id,
    module_name: module,
    severity,
    findings: versions.map((version) => ({ version, paths: [] })),
  };
}

describe("production dependency audit", () => {
  it("accepts only an exact, unexpired high-severity exception", () => {
    expect(evaluateAudit(report({ 1: advisory() }), exception, "2026-07-28")).toEqual({
      accepted: [
        {
          advisoryId: "GHSA-2345-2345-2345",
          packageName: "time-bounded-example",
          severity: "high",
          versions: ["1.2.3"],
          expiresOn: "2026-08-11",
        },
      ],
      failures: [],
      unusedExceptions: [],
    });
  });

  it.each([
    ["a new high advisory", advisory({ id: "GHSA-2345-2345-2345", module: "new-risk" })],
    ["a critical advisory", advisory({ severity: "critical" })],
    ["an unapproved version", advisory({ versions: ["1.1.15"] })],
  ])("fails closed for %s", (_label, candidate) => {
    const result = evaluateAudit(report({ 1: candidate }), exception, "2026-07-28");
    expect(result.failures).toHaveLength(1);
  });

  it("fails after an exception expires", () => {
    const result = evaluateAudit(report({ 1: advisory() }), exception, "2026-08-12");
    expect(result.failures).toHaveLength(1);
    expect(result.unusedExceptions).toEqual(["GHSA-2345-2345-2345:time-bounded-example"]);
  });

  it("requires stale exceptions to be removed when the advisory disappears", () => {
    expect(evaluateAudit(report(), exception, "2026-07-28").unusedExceptions).toEqual([
      "GHSA-2345-2345-2345:time-bounded-example",
    ]);
  });

  it("excludes optional peers and dev tools absent from the deployed production tree", () => {
    const inventory = new Map([["time-bounded-example", new Set(["1.2.3"])]]);
    const result = evaluateAudit(
      report({
        1: advisory(),
        2: advisory({
          id: "GHSA-2345-2345-2345",
          module: "vitest",
          severity: "critical",
          versions: ["2.1.9"],
        }),
      }),
      exception,
      "2026-07-28",
      inventory,
    );
    expect(result.failures).toEqual([]);
    expect(result.accepted).toHaveLength(1);
  });

  it("rejects malformed exception records", () => {
    expect(() =>
      validateExceptions({
        schemaVersion: 1,
        exceptions: [{ ...exception.exceptions[0], allowedVersions: [] }],
      }),
    ).toThrow("allowedVersions");
  });

  it("rejects a malformed high-severity registry record instead of filtering it out", () => {
    expect(() =>
      evaluateAudit(
        report({
          1: {
            github_advisory_id: "GHSA-2345-2345-2345",
            module_name: "malformed",
            severity: "high",
            findings: [],
          },
        }),
        exception,
        "2026-07-28",
        new Map(),
      ),
    ).toThrow("malformed high/critical advisory");
  });

  it("walks only dependencies reachable from a deployed node_modules tree", () => {
    const root = mkdtempSync(join(tmpdir(), "helix-production-inventory-test-"));
    const virtualStore = join(root, "node_modules/.pnpm");
    const production = join(virtualStore, "production@1.0.0/node_modules/production");
    const dependency = join(virtualStore, "dependency@2.0.0/node_modules/dependency");
    const orphan = join(virtualStore, "orphan@3.0.0/node_modules/orphan");
    try {
      for (const [directory, name, version] of [
        [production, "production", "1.0.0"],
        [dependency, "dependency", "2.0.0"],
        [orphan, "orphan", "3.0.0"],
      ]) {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "package.json"), JSON.stringify({ name, version }));
      }
      symlinkSync(
        ".pnpm/production@1.0.0/node_modules/production",
        join(root, "node_modules/production"),
      );
      symlinkSync(
        "../../dependency@2.0.0/node_modules/dependency",
        join(virtualStore, "production@1.0.0/node_modules/dependency"),
      );

      const inventory = productionDependencyInventory(root);

      expect([...inventory.get("production")]).toEqual(["1.0.0"]);
      expect([...inventory.get("dependency")]).toEqual(["2.0.0"]);
      expect(inventory.has("orphan")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the fixed brace expansion with narrow compatibility patches", () => {
    const manifest = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    expect(manifest.pnpm.overrides["brace-expansion"]).toBe("5.0.8");
    expect(manifest.pnpm.patchedDependencies).toEqual({
      "minimatch@3.1.5": "patches/minimatch@3.1.5.patch",
      "minimatch@5.1.9": "patches/minimatch@5.1.9.patch",
    });

    for (const patchPath of Object.values(manifest.pnpm.patchedDependencies)) {
      const patch = readFileSync(resolve(patchPath), "utf8");
      expect(patch).toContain("typeof braceExpansion === 'function'");
      expect(patch).not.toContain("deleted file mode");
    }
  });
});
