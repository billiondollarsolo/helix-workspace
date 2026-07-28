#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  MAIL_EXTERNAL_TARGETS,
  MAIL_LIVE_SCENARIOS,
  validateMailLiveEvidence,
} from "./mail-live-evidence-smoke.mjs";
import { AGENT_LIVE_SCENARIOS, validateAgentLiveEvidence } from "./agent-live-evidence-smoke.mjs";
import {
  RESTORE_DRILL_SCENARIOS,
  validateRestoreDrillEvidence,
} from "./restore-drill-evidence.mjs";

const SENSITIVE_KEY_PATTERN = /(password|secret|token|authorization|cookie|key|credential)/iu;

const usage = `Usage: infra/scripts/release-readiness-manifest.mjs [options]

Build a redacted, deterministic release-readiness manifest for the paired
helix-workspace and helix-editors revisions.

Options:
  --workspace-dir <path>       Default: current directory
  --editors-dir <path>         Default: ../helix-editors
  --evidence-dir <path>        Required unless HELIX_RELEASE_EVIDENCE_DIR is set
  --require-evidence <path>    Required relative evidence path; repeatable
  --mail-live-evidence <path>  Validate and require passed local M7 Mail evidence
  --agent-live-evidence <path> Validate and require passed A7 Agent evidence
  --restore-drill-evidence <path>
                               Validate and require passed O4 restore evidence
  --require-external-mail-evidence
                               Also require passed provider/Gmail/Microsoft evidence
  --image-digest <digest>      Application image digest (legacy option name)
  --application-image-digest <digest>
                               Application image digest
  --web-image-digest <digest>  Web edge image digest
  --output <path>              Write JSON to this file as well as stdout
  --timestamp <ISO-8601>       Explicit timestamp for reproducible automation/tests
  --help                       Show this help

Environment:
  HELIX_RELEASE_EVIDENCE_DIR
  HELIX_EDITORS_DIR
  HELIX_IMAGE_DIGEST
  HELIX_APPLICATION_IMAGE_DIGEST
  HELIX_WEB_IMAGE_DIGEST
  HELIX_MODE
  HELIX_SECURITY_TIER
  HELIX_ENABLED_APPS           Comma-separated stable app IDs
  HELIX_ENABLED_FEATURES       Comma-separated stable feature IDs
`;

if (isMain()) {
  await main();
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2), process.cwd(), process.env);
    if (options.help) {
      process.stdout.write(usage);
      process.exit(0);
    }
    const manifest = await buildReleaseReadinessManifest(options);
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    if (options.output !== undefined) {
      await mkdir(dirname(options.output), { recursive: true });
      await writeFile(options.output, serialized, "utf8");
    }
    process.stdout.write(serialized);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`release-readiness manifest failed: ${message}\n`);
    process.exit(1);
  }
}

export async function buildReleaseReadinessManifest(options) {
  if (options.applicationImageDigest === undefined) {
    throw new Error(
      "--application-image-digest, --image-digest, HELIX_APPLICATION_IMAGE_DIGEST, or HELIX_IMAGE_DIGEST is required",
    );
  }
  if (options.webImageDigest === undefined) {
    throw new Error("--web-image-digest or HELIX_WEB_IMAGE_DIGEST is required");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(options.applicationImageDigest)) {
    throw new Error("application image digest must be an OCI sha256 digest");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(options.webImageDigest)) {
    throw new Error("web image digest must be an OCI sha256 digest");
  }
  const workspace = collectRepository(options.workspaceDir, "helix-workspace");
  const editors = collectRepository(options.editorsDir, "helix-editors");
  const dirtyRepositories = [workspace, editors].filter((repository) => repository.dirty);
  if (dirtyRepositories.length > 0) {
    throw new Error(
      `repository worktree must be clean: ${dirtyRepositories
        .map((repository) => repository.name)
        .join(", ")}`,
    );
  }

  const evidence = await collectEvidence(options.evidenceDir, options.output);
  const evidencePaths = new Set(evidence.map((entry) => entry.path));
  const missingEvidence = options.requiredEvidence.filter((path) => !evidencePaths.has(path));
  if (missingEvidence.length > 0) {
    throw new Error(`required evidence missing: ${missingEvidence.join(", ")}`);
  }
  if (evidence.length === 0) {
    throw new Error(`evidence directory contains no files: ${options.evidenceDir}`);
  }
  const mailEvidence = await validateRequiredMailEvidence(options, evidencePaths);
  const agentEvidence = await validateRequiredAgentEvidence(options, evidencePaths);
  const restoreEvidence = await validateRequiredRestoreEvidence(options, evidencePaths);

  const timestamp = canonicalTimestamp(options.timestamp);
  const raw = {
    schemaVersion: 2,
    generatedAt: timestamp,
    repositories: { workspace, editors },
    runtime: {
      node: process.version,
      pnpm: commandOutput("pnpm", ["--version"], options.workspaceDir),
    },
    deployment: {
      mode: options.environment.HELIX_MODE ?? "single-tenant",
      securityTier: options.environment.HELIX_SECURITY_TIER ?? "personal",
      enabledApps: csvList(options.environment.HELIX_ENABLED_APPS),
      enabledFeatures: csvList(options.environment.HELIX_ENABLED_FEATURES),
      images: {
        application: options.applicationImageDigest,
        web: options.webImageDigest,
      },
    },
    database: {
      migrationHead: await discoverMigrationHead(options.workspaceDir),
    },
    evidence: {
      root: basename(options.evidenceDir),
      required: [...options.requiredEvidence].sort(),
      files: evidence,
      ...(mailEvidence === undefined ? {} : { mail: mailEvidence }),
      ...(agentEvidence === undefined ? {} : { agent: agentEvidence }),
      ...(restoreEvidence === undefined ? {} : { restore: restoreEvidence }),
    },
  };
  return redactSensitive(raw);
}

export function parseArgs(args, cwd, environment = process.env) {
  const options = {
    workspaceDir: resolve(cwd),
    editorsDir: resolve(cwd, environment.HELIX_EDITORS_DIR ?? "../helix-editors"),
    evidenceDir:
      environment.HELIX_RELEASE_EVIDENCE_DIR === undefined
        ? undefined
        : resolve(cwd, environment.HELIX_RELEASE_EVIDENCE_DIR),
    requiredEvidence: [],
    mailLiveEvidence: undefined,
    agentLiveEvidence: undefined,
    restoreDrillEvidence: undefined,
    requireExternalMailEvidence: false,
    applicationImageDigest:
      environment.HELIX_APPLICATION_IMAGE_DIGEST ?? environment.HELIX_IMAGE_DIGEST,
    webImageDigest: environment.HELIX_WEB_IMAGE_DIGEST,
    output: undefined,
    timestamp: undefined,
    environment,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--require-external-mail-evidence") {
      options.requireExternalMailEvidence = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    switch (argument) {
      case "--workspace-dir":
        options.workspaceDir = resolve(cwd, value);
        break;
      case "--editors-dir":
        options.editorsDir = resolve(cwd, value);
        break;
      case "--evidence-dir":
        options.evidenceDir = resolve(cwd, value);
        break;
      case "--require-evidence":
        options.requiredEvidence.push(normalizeRelativePath(value));
        break;
      case "--mail-live-evidence":
        options.mailLiveEvidence = normalizeRelativePath(value);
        break;
      case "--agent-live-evidence":
        options.agentLiveEvidence = normalizeRelativePath(value);
        break;
      case "--restore-drill-evidence":
        options.restoreDrillEvidence = normalizeRelativePath(value);
        break;
      case "--image-digest":
      case "--application-image-digest":
        options.applicationImageDigest = value;
        break;
      case "--web-image-digest":
        options.webImageDigest = value;
        break;
      case "--output":
        options.output = resolve(cwd, value);
        break;
      case "--timestamp":
        options.timestamp = value;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!options.help && options.evidenceDir === undefined) {
    throw new Error("--evidence-dir or HELIX_RELEASE_EVIDENCE_DIR is required");
  }
  if (options.requireExternalMailEvidence && options.mailLiveEvidence === undefined) {
    throw new Error("--require-external-mail-evidence requires --mail-live-evidence");
  }
  return options;
}

async function validateRequiredRestoreEvidence(options, evidencePaths) {
  if (options.restoreDrillEvidence === undefined) return undefined;
  if (!evidencePaths.has(options.restoreDrillEvidence)) {
    throw new Error(`required restore drill evidence missing: ${options.restoreDrillEvidence}`);
  }
  const path = resolve(options.evidenceDir, options.restoreDrillEvidence);
  let evidence;
  try {
    evidence = validateRestoreDrillEvidence(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(
      `invalid restore drill evidence: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const incomplete = RESTORE_DRILL_SCENARIOS.filter(
    (scenario) => evidence.scenarios[scenario].status !== "passed",
  );
  if (evidence.mode !== "live" || evidence.status !== "passed" || incomplete.length > 0) {
    throw new Error(
      `restore drill evidence is incomplete: ${incomplete.join(", ") || evidence.status}`,
    );
  }
  return {
    path: options.restoreDrillEvidence,
    status: evidence.status,
    rpoHours: evidence.metrics.rpoHours,
    rtoHours: evidence.metrics.rtoHours,
    scenarios: RESTORE_DRILL_SCENARIOS.map((scenario) => ({
      name: scenario,
      status: evidence.scenarios[scenario].status,
    })),
  };
}

async function validateRequiredAgentEvidence(options, evidencePaths) {
  if (options.agentLiveEvidence === undefined) return undefined;
  if (!evidencePaths.has(options.agentLiveEvidence)) {
    throw new Error(`required Agent live evidence missing: ${options.agentLiveEvidence}`);
  }
  const path = resolve(options.evidenceDir, options.agentLiveEvidence);
  let evidence;
  try {
    evidence = validateAgentLiveEvidence(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(
      `invalid Agent live evidence: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const incomplete = AGENT_LIVE_SCENARIOS.filter(
    (scenario) => evidence.scenarios[scenario].status !== "passed",
  );
  if (evidence.status !== "passed" || incomplete.length > 0) {
    throw new Error(
      `Agent live evidence is incomplete: ${incomplete.join(", ") || evidence.status}`,
    );
  }
  return {
    path: options.agentLiveEvidence,
    status: evidence.status,
    scenarios: AGENT_LIVE_SCENARIOS.map((scenario) => ({
      name: scenario,
      status: evidence.scenarios[scenario].status,
    })),
  };
}

async function validateRequiredMailEvidence(options, evidencePaths) {
  if (options.mailLiveEvidence === undefined) return undefined;
  if (!evidencePaths.has(options.mailLiveEvidence)) {
    throw new Error(`required Mail live evidence missing: ${options.mailLiveEvidence}`);
  }
  const path = resolve(options.evidenceDir, options.mailLiveEvidence);
  let evidence;
  try {
    evidence = validateMailLiveEvidence(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    throw new Error(
      `invalid Mail live evidence: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const failedLocal = MAIL_LIVE_SCENARIOS.filter(
    (scenario) => evidence.local[scenario].status !== "passed",
  );
  if (evidence.status !== "passed" || failedLocal.length > 0) {
    throw new Error(
      `Mail live evidence is incomplete: ${failedLocal.join(", ") || evidence.status}`,
    );
  }
  if (options.requireExternalMailEvidence) {
    const incompleteExternal = MAIL_EXTERNAL_TARGETS.filter(
      (target) => evidence.external[target].status !== "passed",
    );
    if (incompleteExternal.length > 0) {
      throw new Error(`external Mail evidence is incomplete: ${incompleteExternal.join(", ")}`);
    }
  }
  return {
    path: options.mailLiveEvidence,
    status: evidence.status,
    local: Object.fromEntries(
      MAIL_LIVE_SCENARIOS.map((scenario) => [scenario, evidence.local[scenario].status]),
    ),
    external: Object.fromEntries(
      MAIL_EXTERNAL_TARGETS.map((target) => [target, evidence.external[target].status]),
    ),
  };
}

export function redactSensitive(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => redactSensitive(entry));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSensitive(entry),
      ]),
    );
  }
  return value;
}

function collectRepository(directory, name) {
  const sha = commandOutput("git", ["rev-parse", "HEAD"], directory);
  const branch = commandOutput("git", ["rev-parse", "--abbrev-ref", "HEAD"], directory);
  const porcelain = commandOutput(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    directory,
  );
  return {
    name,
    sha,
    branch,
    dirty: porcelain.length > 0,
  };
}

async function collectEvidence(root, outputPath) {
  const rootStat = await stat(root).catch(() => null);
  if (rootStat === null || !rootStat.isDirectory()) {
    throw new Error(`evidence directory does not exist: ${root}`);
  }
  const output = outputPath === undefined ? null : resolve(outputPath);
  const files = [];
  await walk(root, async (absolutePath) => {
    if (output !== null && resolve(absolutePath) === output) {
      return;
    }
    const bytes = await readFile(absolutePath);
    files.push({
      path: normalizeRelativePath(relative(root, absolutePath)),
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(directory, visit) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path, visit);
    } else if (entry.isFile()) {
      await visit(path);
    }
  }
}

async function discoverMigrationHead(workspaceDir) {
  const migrationDir = resolve(workspaceDir, "apps/helix/src/db/migrations");
  const entries = await readdir(migrationDir);
  const migrations = entries
    .filter((entry) => /^\d+_.+\.sql$/u.test(entry))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  const head = migrations.at(-1);
  if (head === undefined) {
    throw new Error(`no SQL migrations found in ${migrationDir}`);
  }
  return head;
}

function commandOutput(command, args, cwd) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const detail =
      error !== null && typeof error === "object" && "stderr" in error
        ? String(error.stderr).trim()
        : "";
    throw new Error(
      `command failed in ${cwd}: ${command} ${args.join(" ")}${detail.length > 0 ? ` (${detail})` : ""}`,
    );
  }
}

function csvList(value) {
  if (value === undefined) {
    return [];
  }
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].sort();
}

function normalizeRelativePath(value) {
  const normalized = value.split(sep).join("/");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`evidence path must be relative and stay inside the evidence root: ${value}`);
  }
  return normalized;
}

function canonicalTimestamp(value) {
  const date = value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  return date.toISOString();
}

function isMain() {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}
