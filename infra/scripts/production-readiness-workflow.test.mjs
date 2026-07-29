import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
const qualityWorkflow = readFileSync(resolve(".github/workflows/quality-gates.yml"), "utf8");
const sourceJob = qualityWorkflow.slice(
  qualityWorkflow.indexOf("  source-and-helm-quality:"),
  qualityWorkflow.indexOf("\n  platform-mode-matrix:"),
);
const liveDemoJob = qualityWorkflow.slice(
  qualityWorkflow.indexOf("  backend-live-demo-data:"),
  qualityWorkflow.indexOf("\n  accessibility-and-load:"),
);

describe("production-readiness source workflow", () => {
  it("runs the complete root source gates exactly once", () => {
    for (const command of ["pnpm typecheck", "pnpm lint", "pnpm build"]) {
      expect(sourceJob.split(`run: ${command}`)).toHaveLength(2);
    }
    expect(sourceJob.indexOf("run: pnpm typecheck")).toBeLessThan(
      sourceJob.indexOf("run: pnpm lint"),
    );
    expect(sourceJob.indexOf("run: pnpm lint")).toBeLessThan(sourceJob.indexOf("run: pnpm build"));
  });

  it("runs one named, fail-closed production-readiness contract suite", () => {
    expect(qualityWorkflow).toContain("run: pnpm quality:production-readiness-contract:test");
    const command = packageJson.scripts["quality:production-readiness-contract:test"];
    expect(command).toContain("node infra/scripts/negative-security-matrix.mjs");
    for (const test of [
      "infra/scripts/production-compose.test.mjs",
      "infra/scripts/production-image-workflow.test.mjs",
      "infra/scripts/supply-chain-workflow.test.mjs",
      "infra/scripts/production-dependency-audit.test.mjs",
      "infra/scripts/negative-security-matrix.test.mjs",
      "infra/scripts/backup-manifest.test.mjs",
      "infra/scripts/production-readiness-workflow.test.mjs",
    ]) {
      expect(command).toContain(test);
    }
  });

  it("keeps the V2 live integration row outside static CI claims", () => {
    expect(packageJson.scripts["quality:negative-security-matrix"]).toBe(
      "node infra/scripts/negative-security-matrix.mjs",
    );
    expect(sourceJob).not.toContain("DATABASE_URL");
    expect(sourceJob).not.toContain("live-postgres");
  });

  it("executes the mandatory V2 tenant boundary against migrated live PostgreSQL", () => {
    const migration = liveDemoJob.indexOf("name: Run editor-owned database migrations");
    const tenantIsolation = liveDemoJob.indexOf("name: Prove live PostgreSQL tenant isolation");
    expect(migration).toBeGreaterThanOrEqual(0);
    expect(tenantIsolation).toBeGreaterThan(migration);
    expect(liveDemoJob).toContain("src/platform/tenancy/cross-tenant-isolation.test.ts");
    expect(liveDemoJob).toContain("does not expose beta Drive data to an acme actor");
    expect(liveDemoJob).toContain(
      "DATABASE_URL: postgres://helix:helix_dev_password@127.0.0.1:39532/helix_demo_smoke",
    );
  });
});
