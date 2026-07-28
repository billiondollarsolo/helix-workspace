#!/usr/bin/env node

import { lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_EXCEPTIONS = resolve(REPO_ROOT, "infra/security/pnpm-audit-exceptions.json");
const HIGH_SEVERITIES = new Set(["high", "critical"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const GHSA =
  /^GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}$/u;

function parseJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to parse ${label} ${path}: ${detail}`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

export function validateExceptions(document) {
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    document.schemaVersion !== 1 ||
    !Array.isArray(document.exceptions)
  ) {
    throw new Error("Audit exceptions must use schemaVersion 1 and contain an exceptions array");
  }

  const keys = new Set();
  for (const [index, exception] of document.exceptions.entries()) {
    const label = `exceptions[${index}]`;
    if (exception === null || typeof exception !== "object" || Array.isArray(exception)) {
      throw new Error(`${label} must be an object`);
    }
    if (!GHSA.test(exception.advisory ?? "")) {
      throw new Error(`${label}.advisory must be a canonical GHSA identifier`);
    }
    assertNonEmptyString(exception.package, `${label}.package`);
    assertNonEmptyString(exception.owner, `${label}.owner`);
    assertNonEmptyString(exception.rationale, `${label}.rationale`);
    if (!ISO_DATE.test(exception.expiresOn ?? "")) {
      throw new Error(`${label}.expiresOn must be an ISO calendar date`);
    }
    normalizedDate(exception.expiresOn);
    if (
      !Array.isArray(exception.allowedVersions) ||
      exception.allowedVersions.length === 0 ||
      exception.allowedVersions.some(
        (version) => typeof version !== "string" || version.trim().length === 0,
      )
    ) {
      throw new Error(`${label}.allowedVersions must contain exact package versions`);
    }
    const key = `${exception.advisory}:${exception.package}`;
    if (keys.has(key)) {
      throw new Error(`Duplicate audit exception ${key}`);
    }
    if (new Set(exception.allowedVersions).size !== exception.allowedVersions.length) {
      throw new Error(`${label}.allowedVersions must not contain duplicates`);
    }
    keys.add(key);
  }

  return document.exceptions;
}

function normalizedDate(value) {
  if (!ISO_DATE.test(value)) {
    throw new Error(`Audit evaluation date must use YYYY-MM-DD, received ${value}`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Audit evaluation date is not a valid calendar date: ${value}`);
  }
  return value;
}

function highAdvisories(report, inventory) {
  if (
    report === null ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    report.advisories === null ||
    typeof report.advisories !== "object" ||
    Array.isArray(report.advisories)
  ) {
    throw new Error("pnpm audit did not return an advisories object");
  }

  return Object.values(report.advisories)
    .filter((advisory) => HIGH_SEVERITIES.has(advisory?.severity))
    .map((advisory) => {
      if (
        typeof advisory.module_name !== "string" ||
        advisory.module_name.length === 0 ||
        typeof advisory.github_advisory_id !== "string" ||
        !GHSA.test(advisory.github_advisory_id) ||
        !Array.isArray(advisory.findings) ||
        advisory.findings.length === 0 ||
        advisory.findings.some(
          (finding) => typeof finding?.version !== "string" || finding.version.length === 0,
        )
      ) {
        throw new Error("pnpm audit returned a malformed high/critical advisory");
      }
      if (inventory === undefined) return advisory;
      const installedVersions = inventory.get(advisory.module_name) ?? new Set();
      return {
        ...advisory,
        findings: (Array.isArray(advisory.findings) ? advisory.findings : []).filter((finding) =>
          installedVersions.has(finding?.version),
        ),
      };
    })
    .filter((advisory) => advisory.findings.length > 0);
}

export function evaluateAudit(report, exceptionDocument, asOf, inventory) {
  const evaluationDate = normalizedDate(asOf);
  const exceptions = validateExceptions(exceptionDocument);
  const usedExceptions = new Set();
  const failures = [];
  const accepted = [];

  for (const advisory of highAdvisories(report, inventory)) {
    const advisoryId = advisory.github_advisory_id;
    const packageName = advisory.module_name;
    const severity = advisory.severity;
    const versions = [
      ...new Set(
        (Array.isArray(advisory.findings) ? advisory.findings : [])
          .map((finding) => finding?.version)
          .filter((version) => typeof version === "string" && version.length > 0),
      ),
    ];
    const key = `${advisoryId}:${packageName}`;
    const exception = exceptions.find(
      (candidate) => candidate.advisory === advisoryId && candidate.package === packageName,
    );

    if (
      severity === "critical" ||
      exception === undefined ||
      exception.expiresOn < evaluationDate ||
      versions.length === 0 ||
      versions.some((version) => !exception.allowedVersions.includes(version))
    ) {
      failures.push({ advisoryId, packageName, severity, versions });
      continue;
    }

    usedExceptions.add(key);
    accepted.push({ advisoryId, packageName, severity, versions, expiresOn: exception.expiresOn });
  }

  const unusedExceptions = exceptions
    .map((exception) => `${exception.advisory}:${exception.package}`)
    .filter((key) => !usedExceptions.has(key));

  return { accepted, failures, unusedExceptions };
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function currentUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

function packageDirectories(nodeModulesPath) {
  let entries;
  try {
    entries = readdirSync(nodeModulesPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const directories = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const path = join(nodeModulesPath, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const scopedEntry of readdirSync(path, { withFileTypes: true })) {
        if (scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) {
          directories.push(join(path, scopedEntry.name));
        }
      }
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) directories.push(path);
  }
  return directories;
}

function productionDependencyPackages(deployRoot) {
  const packages = [];
  const visited = new Set();

  function visit(candidate) {
    let packageRoot;
    try {
      if (!lstatSync(candidate).isDirectory() && !lstatSync(candidate).isSymbolicLink()) return;
      packageRoot = realpathSync(candidate);
    } catch {
      return;
    }
    if (visited.has(packageRoot)) return;
    visited.add(packageRoot);

    const manifest = parseJsonFile(join(packageRoot, "package.json"), "deployed package manifest");
    if (
      typeof manifest.name !== "string" ||
      manifest.name.length === 0 ||
      typeof manifest.version !== "string" ||
      manifest.version.length === 0
    ) {
      throw new Error(`Deployed package manifest is missing name/version: ${packageRoot}`);
    }
    packages.push({ name: manifest.name, version: manifest.version, root: packageRoot });

    let virtualNodeModules = dirname(packageRoot);
    if (basename(virtualNodeModules).startsWith("@")) {
      virtualNodeModules = dirname(virtualNodeModules);
    }
    if (virtualNodeModules.includes("/node_modules/.pnpm/")) {
      for (const dependency of packageDirectories(virtualNodeModules)) visit(dependency);
    }
    for (const dependency of packageDirectories(join(packageRoot, "node_modules"))) {
      visit(dependency);
    }
  }

  for (const dependency of packageDirectories(join(deployRoot, "node_modules"))) {
    visit(dependency);
  }
  if (packages.length === 0) {
    throw new Error("The deployed production dependency inventory is empty");
  }
  return packages;
}

export function productionDependencyInventory(deployRoot) {
  const inventory = new Map();
  for (const dependency of productionDependencyPackages(deployRoot)) {
    const versions = inventory.get(dependency.name) ?? new Set();
    versions.add(dependency.version);
    inventory.set(dependency.name, versions);
  }
  return inventory;
}

function validateLegacyBraceGlobCompatibility(deployRoot) {
  const packages = productionDependencyPackages(deployRoot);
  const requireFromHere = createRequire(import.meta.url);
  for (const version of ["3.1.5", "5.1.9"]) {
    const candidate = packages.find(
      (dependency) => dependency.name === "minimatch" && dependency.version === version,
    );
    if (candidate === undefined) {
      throw new Error(`Production dependency tree is missing minimatch@${version}`);
    }
    const minimatch = requireFromHere(join(candidate.root, "minimatch.js"));
    if (
      typeof minimatch !== "function" ||
      minimatch("report-a.csv", "report-{a,b}.csv") !== true ||
      minimatch("report-c.csv", "report-{a,b}.csv") !== false
    ) {
      throw new Error(`minimatch@${version} cannot consume the patched brace-expansion API`);
    }
  }

  const braceExpansion = packages.find(
    (dependency) => dependency.name === "brace-expansion" && dependency.version === "5.0.8",
  );
  if (braceExpansion === undefined) {
    throw new Error("Production dependency tree must resolve brace-expansion@5.0.8");
  }
  const braceModule = requireFromHere(braceExpansion.root);
  if (typeof braceModule?.expand !== "function") {
    throw new Error("brace-expansion@5.0.8 must expose its bounded expansion API");
  }
  const bounded = braceModule.expand("{a,b}".repeat(300), {
    max: 100_000,
    maxLength: 4_096,
  });
  const totalLength = bounded.reduce((sum, value) => sum + value.length, 0);
  if (bounded.length === 0 || totalLength > 4_096) {
    throw new Error("brace-expansion maxLength did not bound adversarial expansion output");
  }
}

function createProductionInventory() {
  const deployRoot = mkdtempSync(join(tmpdir(), "helix-production-dependencies-"));
  const result = spawnSync(
    "pnpm",
    ["--filter", "@helix/app", "deploy", "--prod", "--ignore-scripts", deployRoot],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, CI: "true" },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error) {
    rmSync(deployRoot, { recursive: true, force: true });
    throw new Error(`Unable to create the production dependency tree: ${result.error.message}`);
  }
  if (result.status !== 0) {
    rmSync(deployRoot, { recursive: true, force: true });
    throw new Error(
      `Unable to create the production dependency tree: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  try {
    validateLegacyBraceGlobCompatibility(deployRoot);
    return productionDependencyInventory(deployRoot);
  } finally {
    rmSync(deployRoot, { recursive: true, force: true });
  }
}

function runPnpmAudit() {
  const packageDocument = parseJsonFile(resolve(REPO_ROOT, "package.json"), "package manifest");
  if (packageDocument.packageManager !== "pnpm@9.15.9") {
    throw new Error("The production audit runner requires packageManager pnpm@9.15.9");
  }

  const result = spawnSync("pnpm", ["audit", "--prod", "--audit-level", "high", "--json"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, CI: "true" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Unable to execute pnpm audit: ${result.error.message}`);
  }
  if (result.signal !== null) {
    throw new Error(`pnpm audit terminated by signal ${result.signal}`);
  }
  if (result.stdout.trim().length === 0) {
    throw new Error(`pnpm audit returned no JSON report: ${result.stderr.trim()}`);
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    throw new Error(`pnpm audit returned malformed JSON: ${result.stderr.trim()}`);
  }

  if (result.status !== 0 && highAdvisories(report).length === 0) {
    throw new Error(`pnpm audit failed without a high/critical advisory: ${result.stderr.trim()}`);
  }
  return report;
}

export function main() {
  const reportPath = argumentValue("--report");
  const exceptionsPath = resolve(argumentValue("--exceptions") ?? DEFAULT_EXCEPTIONS);
  const asOf = argumentValue("--as-of") ?? currentUtcDate();
  const report =
    reportPath === undefined
      ? runPnpmAudit()
      : parseJsonFile(resolve(reportPath), "pnpm audit report");
  const exceptions = parseJsonFile(exceptionsPath, "audit exceptions");
  const inventory = createProductionInventory();
  const result = evaluateAudit(report, exceptions, asOf, inventory);

  for (const exception of result.accepted) {
    process.stdout.write(
      `Accepted time-bounded audit exception ${exception.advisoryId} for ${exception.packageName}@${exception.versions.join(",")} through ${exception.expiresOn}\n`,
    );
  }

  if (result.failures.length > 0) {
    for (const failure of result.failures) {
      process.stderr.write(
        `Blocked ${failure.severity} advisory ${failure.advisoryId ?? "unknown"} in ${failure.packageName ?? "unknown"}@${failure.versions.join(",") || "unknown"}\n`,
      );
    }
  }
  if (result.unusedExceptions.length > 0) {
    process.stderr.write(
      `Remove or revalidate unused audit exceptions: ${result.unusedExceptions.join(", ")}\n`,
    );
  }
  if (result.failures.length > 0 || result.unusedExceptions.length > 0) {
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    "Production dependency audit passed: no unexcepted high/critical advisories\n",
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Production dependency audit failed closed: ${detail}\n`);
    process.exitCode = 1;
  }
}
