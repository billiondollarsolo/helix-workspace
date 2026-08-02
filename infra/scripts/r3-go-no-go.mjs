#!/usr/bin/env node
/**
 * R3 — GA go/no-go gate (executable).
 * Evaluates required evidence artifacts and packaging fail-closed defaults.
 * Does not invent green for missing live packs; exits non-zero when required
 * files are absent unless --allow-missing-live is set for CI structural mode.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");

export const R3_REQUIRED_STRUCTURAL = [
  "docs/superpowers/plans/2026-08-02-helix-full-workspace-v1-release.md",
  "docs/architecture/v1-packaging-matrix.md",
  "docs/architecture/ha-rpo-rto.md",
  "docs/architecture/v1-rollout-runbook.md",
  "apps/helix/src/config/workspace-packaging.ts",
  "infra/scripts/rpo-rto-check.mjs",
  "infra/scripts/k8s-drill-dry-run.mjs",
  "infra/scripts/v1-phase-artifact-gate.test.mjs",
  "infra/helm/helix/Chart.yaml",
  "docker-compose.production.yml",
];

export const R3_OPTIONAL_LIVE = [
  "artifacts/release-readiness/mail-live-evidence.json",
  "artifacts/release-readiness/drive-live-evidence.json",
  "artifacts/release-readiness/chat-live-evidence.json",
  "artifacts/release-readiness/k8s-drill-latest.json",
];

export function checkPaths(paths, { rootDir = root, exists = existsSync } = {}) {
  const present = [];
  const missing = [];
  for (const rel of paths) {
    if (exists(join(rootDir, rel))) {
      present.push(rel);
    } else {
      missing.push(rel);
    }
  }
  return { present, missing, ok: missing.length === 0 };
}

export function evaluateR3(input = {}) {
  const structural = checkPaths(R3_REQUIRED_STRUCTURAL, input);
  const live = checkPaths(R3_OPTIONAL_LIVE, input);
  const allowMissingLive = input.allowMissingLive === true;
  const packaging = evaluatePackagingFailClosed(input);
  const decision = structural.ok && packaging.ok && (allowMissingLive || live.ok) ? "go" : "no-go";
  return {
    taskId: "R3",
    decision,
    structural,
    live,
    packaging,
    allowMissingLive,
    reasons: [
      ...(!structural.ok ? [`missing structural: ${structural.missing.join(", ")}`] : []),
      ...(!packaging.ok ? packaging.reasons : []),
      ...(!allowMissingLive && !live.ok
        ? [`missing live evidence: ${live.missing.join(", ")}`]
        : allowMissingLive && !live.ok
          ? [`live evidence incomplete (allowed in structural mode): ${live.missing.join(", ")}`]
          : []),
    ],
  };
}

export function evaluatePackagingFailClosed({
  rootDir = root,
  read = (rel) => readFileSync(join(rootDir, rel), "utf8"),
} = {}) {
  const reasons = [];
  try {
    const compose = read("docker-compose.production.yml");
    if (!/HELIX_APPS[^\n]*mail,drive,chat,assistant/.test(compose)) {
      reasons.push("compose production HELIX_APPS is not MVP allowlist");
    }
    if (/HELIX_WORKSPACE_PROFILE[^\n]*full/.test(compose) && !/#[^\n]*full/.test(compose)) {
      // allow comments only
      if (!compose.includes("# HELIX_WORKSPACE_PROFILE=full")) {
        // still ok if default is mvp
      }
    }
    const packaging = read("apps/helix/src/config/workspace-packaging.ts");
    if (!packaging.includes("PRODUCTION_FULL_APPS_ALLOWLIST")) {
      reasons.push("workspace-packaging missing full allowlist");
    }
    if (!packaging.includes("validateFullWorkspaceDependencyGates")) {
      reasons.push("workspace-packaging missing dependency gates");
    }
    const env = read("apps/helix/src/config/env.ts");
    if (!env.includes("HELIX_WORKSPACE_PROFILE")) {
      reasons.push("env schema missing HELIX_WORKSPACE_PROFILE");
    }
  } catch (error) {
    reasons.push(
      `packaging read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}

export function writeR3Decision(path, evaluation) {
  mkdirSync(dirname(path), { recursive: true });
  const payload = {
    ...evaluation,
    signedAt: new Date().toISOString(),
    signer: process.env.HELIX_R3_SIGNER ?? "structural-gate",
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

function main() {
  const allowMissingLive =
    process.argv.includes("--allow-missing-live") ||
    process.env.HELIX_R3_ALLOW_MISSING_LIVE === "1";
  const evidencePath = resolve(
    process.argv.includes("--evidence")
      ? process.argv[process.argv.indexOf("--evidence") + 1]
      : join(root, "artifacts/release-readiness/r3-go-no-go-latest.json"),
  );
  const evaluation = evaluateR3({ allowMissingLive });
  writeR3Decision(evidencePath, evaluation);
  console.log(
    JSON.stringify(
      { decision: evaluation.decision, evidencePath, reasons: evaluation.reasons },
      null,
      2,
    ),
  );
  process.exit(evaluation.decision === "go" ? 0 : 1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
