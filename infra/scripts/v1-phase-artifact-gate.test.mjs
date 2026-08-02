/**
 * Structural gate for Full Workspace v1 Ops / Validation / PKG / Rollout artifacts.
 * Ensures required deploy, HA, and packaging documents/scripts exist on the tree
 * without inventing live drill green.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "../..");

function mustExist(rel) {
  const path = join(root, rel);
  expect(existsSync(path), `missing required artifact: ${rel}`).toBe(true);
  return path;
}

function read(rel) {
  return readFileSync(mustExist(rel), "utf8");
}

describe("Full Workspace v1 phase artifact gate (O/V/PKG/R)", () => {
  it("ships Docker Compose production track artifacts (O-DOCKER)", () => {
    const compose = read("docker-compose.production.yml");
    expect(compose).toMatch(/HELIX_APPS|helix/i);
    mustExist("infra/scripts/production-compose.test.mjs");
    mustExist("infra/scripts/backup.sh");
    mustExist("docs/deployment-production.md");
  });

  it("ships Kubernetes / Helm track artifacts (O-K8S)", () => {
    mustExist("infra/helm/helix/Chart.yaml");
    mustExist("infra/helm/helix/values.yaml");
    mustExist("infra/helm/helix/values-business.yaml");
    const chart = read("infra/helm/helix/Chart.yaml");
    expect(chart).toMatch(/name:\s*helix/i);
  });

  it("ships compose↔helm parity and HA RPO/RTO contracts (O-X / O)", () => {
    const parity = read("docs/architecture/compose-helm-parity.md");
    expect(parity.toLowerCase()).toMatch(/compose|helm|parity/);
    const ha = read("docs/architecture/ha-rpo-rto.md");
    expect(ha).toMatch(/RPO|RTO/);
    mustExist("docs/backup-restore.md");
    mustExist("infra/scripts/failure-recovery-runner.mjs");
    mustExist("infra/scripts/live-restore-drill-smoke.sh");
  });

  it("ships validation and live-evidence harnesses (V)", () => {
    for (const rel of [
      "infra/scripts/mail-live-evidence-smoke.mjs",
      "infra/scripts/drive-live-evidence-smoke.mjs",
      "infra/scripts/chat-live-evidence-smoke.mjs",
      "infra/scripts/agent-live-evidence-smoke.mjs",
      "infra/scripts/negative-security-matrix.mjs",
      "infra/scripts/final-release-artifacts.mjs",
      "docs/final-release-readiness.md",
    ]) {
      mustExist(rel);
    }
  });

  it("ships packaging matrix and fail-closed MVP defaults until full profile", () => {
    const matrix = read("docs/architecture/v1-packaging-matrix.md");
    expect(matrix).toMatch(/Full Workspace|HELIX_APPS|VITE_HELIX_MVP_ONLY/);
    const packaging = read("apps/helix/src/config/workspace-packaging.ts");
    expect(packaging).toMatch(/PRODUCTION_FULL_APPS_ALLOWLIST|resolveWorkspacePackagingProfile/);
    const assertions = read("apps/helix/src/config/production-assertions.ts");
    expect(assertions).toMatch(/validateWorkspaceAppsAllowlist|workspace-packaging/);
    const env = read("apps/helix/src/config/env.ts");
    expect(env).toMatch(/HELIX_WORKSPACE_PROFILE/);
  });

  it("ships O-K.15 drill, ED.10 budgets, and R3 go/no-go executables", () => {
    mustExist("infra/scripts/k8s-drill-dry-run.mjs");
    mustExist("infra/scripts/k8s-drill-dry-run.test.mjs");
    mustExist("infra/scripts/r3-go-no-go.mjs");
    mustExist("infra/scripts/r3-go-no-go.test.mjs");
    mustExist("apps/web/src/features/docs/editor-perf-budget.ts");
    mustExist("apps/web/src/features/docs/editor-perf-budget.test.ts");
    const drill = read("infra/scripts/k8s-drill-dry-run.mjs");
    expect(drill).toMatch(/O-K\.15|dry-run|buildEvidence/);
    const r3 = read("infra/scripts/r3-go-no-go.mjs");
    expect(r3).toMatch(/evaluateR3|go|no-go/);
    const budgets = read("apps/web/src/features/docs/editor-perf-budget.ts");
    expect(budgets).toMatch(/EDITOR_PERF_BUDGETS|evaluateEditorOpenBudget/);
  });

  it("ships SaaS deferral ADR for S+ after R3", () => {
    const adr = read("docs/architecture/adr-0012-public-saas-deferred-after-v1-ga.md");
    expect(adr.toLowerCase()).toMatch(/saas|defer/);
  });
});
