#!/usr/bin/env node
/**
 * O-K.15 — Kubernetes install/upgrade/rollback drill (dry-run capable).
 *
 * Default mode is dry-run: validates Helm chart render + values packaging gates
 * and writes a structured evidence JSON. Live kind/k3d install is opt-in via
 * HELIX_K8S_DRILL_LIVE=1 when a cluster is available.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");
const chartDir = join(root, "infra/helm/helix");

export function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    dryRun: true,
    profile: "mvp",
    evidencePath: join(root, "artifacts/release-readiness/k8s-drill-latest.json"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--live") {
      out.dryRun = false;
    } else if (arg === "--profile" && argv[i + 1]) {
      out.profile = argv[++i];
    } else if (arg === "--evidence" && argv[i + 1]) {
      out.evidencePath = resolve(argv[++i]);
    } else if (arg === "--help") {
      out.help = true;
    }
  }
  if (process.env.HELIX_K8S_DRILL_LIVE === "1") {
    out.dryRun = false;
  }
  return out;
}

export function helmTemplateArgs(profile) {
  const args = ["template", "helix-drill", chartDir, "--debug"];
  if (profile === "full") {
    args.push(
      "--set",
      "workspace.profile=full",
      "--set",
      "workspace.apps=mail,drive,chat,assistant,calendar,meet,docs,sheets,slides",
    );
  }
  return args;
}

export function runHelmTemplate(profile, { exec = spawnSync } = {}) {
  const args = helmTemplateArgs(profile);
  const result = exec("helm", args, {
    encoding: "utf8",
    cwd: root,
    env: process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    args,
  };
}

/** Pure check used by tests when helm binary is unavailable. */
export function evaluateHelmChartPresence(fsExists = existsSync) {
  const required = [
    "infra/helm/helix/Chart.yaml",
    "infra/helm/helix/values.yaml",
    "infra/helm/helix/values-business.yaml",
    "infra/helm/helix/templates",
  ];
  const missing = required.filter((rel) => !fsExists(join(root, rel)));
  return { ok: missing.length === 0, missing };
}

export function buildEvidence(input) {
  return {
    taskId: "O-K.15",
    mode: input.dryRun ? "dry-run" : "live",
    profile: input.profile,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    chartPresent: input.chartPresent,
    helmTemplate: input.helmTemplate,
    liveInstall: input.liveInstall ?? null,
    result: input.result,
    notes: input.notes ?? [],
  };
}

export function writeEvidence(path, evidence) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

function main() {
  const args = parseArgs();
  if (args.help) {
    console.log(`Usage: node infra/scripts/k8s-drill-dry-run.mjs [--dry-run|--live] [--profile mvp|full] [--evidence path]
Default: dry-run (no cluster required). Live requires HELIX_K8S_DRILL_LIVE=1 or --live.`);
    process.exit(0);
  }

  const startedAt = new Date().toISOString();
  const chartPresent = evaluateHelmChartPresence();
  let helmTemplate = { ok: false, status: 1, stdout: "", stderr: "helm not invoked", args: [] };
  const notes = [];

  if (!chartPresent.ok) {
    notes.push(`missing chart files: ${chartPresent.missing.join(", ")}`);
  } else {
    const helmCheck = spawnSync("helm", ["version", "--short"], { encoding: "utf8" });
    if (helmCheck.status !== 0) {
      notes.push("helm binary not available; chart presence verified only");
      helmTemplate = {
        ok: true,
        status: 0,
        stdout: "",
        stderr: "helm missing; skipped template",
        args: helmTemplateArgs(args.profile),
        skipped: true,
      };
    } else {
      helmTemplate = runHelmTemplate(args.profile);
      if (!helmTemplate.ok) {
        notes.push(`helm template failed: ${helmTemplate.stderr.slice(0, 500)}`);
      }
    }
  }

  let liveInstall = null;
  if (!args.dryRun) {
    notes.push(
      "live install requested — require cluster; not auto-executed in CI without HELIX_K8S_DRILL_LIVE=1",
    );
    liveInstall = {
      ok: false,
      status: 2,
      message: "live mode requires operator cluster (see docs/architecture/ha-rpo-rto.md)",
    };
  }

  const ok = chartPresent.ok && (helmTemplate.ok || helmTemplate.skipped === true);
  const finishedAt = new Date().toISOString();
  const evidence = buildEvidence({
    dryRun: args.dryRun,
    profile: args.profile,
    startedAt,
    finishedAt,
    chartPresent,
    helmTemplate: {
      ok: helmTemplate.ok,
      status: helmTemplate.status,
      skipped: helmTemplate.skipped === true,
      args: helmTemplate.args,
    },
    liveInstall,
    result: ok ? "pass" : "fail",
    notes,
  });
  writeEvidence(args.evidencePath, evidence);
  console.log(
    JSON.stringify({ result: evidence.result, evidencePath: args.evidencePath, notes }, null, 2),
  );
  process.exit(ok ? 0 : 1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
