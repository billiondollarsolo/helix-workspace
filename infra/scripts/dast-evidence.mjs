#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";
import {
  attachReleaseEvidenceBinding,
  releaseEvidenceBindingFromEnvironment,
  validateReleaseEvidenceBinding,
} from "./release-evidence-binding.mjs";

export const DAST_EVIDENCE_SCHEMA = "helix.dast-evidence.v1";
export const ZAP_STABLE_IMAGE =
  "ghcr.io/zaproxy/zaproxy:stable@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2";
export const DAST_MAX_TIMEOUT_SECONDS = 1_800;

const RAW_REPORT_NAME = "zap-report.json";
const MAX_RAW_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_DISPOSITIONS_BYTES = 1024 * 1024;
const SEVERITIES = ["informational", "low", "medium", "high", "critical"];
const FINAL_BLOCKING_SEVERITIES = ["high", "critical"];
const DISPOSITION_SEVERITIES = ["low", "medium"];
const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|credential|password|private.?key|secret|token)/iu;
const usage = `Usage:
  node infra/scripts/dast-evidence.mjs \\
    --target <https-or-loopback-origin> \\
    --confirm-disposable-target \\
    --output <evidence.json> \\
    [--dispositions <dispositions.json>] \\
    [--timeout-seconds <60-${String(DAST_MAX_TIMEOUT_SECONDS)}>]

  node infra/scripts/dast-evidence.mjs --validate <evidence.json> [--require-pass]

The live runner requires all four HELIX_RELEASE_* binding variables. It never
persists the target URL, ZAP request/response bodies, cookies, or raw findings.
`;

if (isMain()) {
  await main();
}

async function main() {
  try {
    const options = parseDastArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage);
      return;
    }
    if (options.validate !== undefined) {
      const evidence = JSON.parse(await readBoundedFile(options.validate, MAX_RAW_REPORT_BYTES));
      const expectedBinding = options.requirePass
        ? releaseEvidenceBindingFromEnvironment(process.env)
        : undefined;
      if (options.requirePass && expectedBinding === undefined) {
        throw new Error("--require-pass requires the complete HELIX_RELEASE_* evidence binding");
      }
      validateDastEvidence(evidence, {
        requirePass: options.requirePass,
        expectedBinding,
      });
      process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
      return;
    }
    const evidence = await runDastScan(options, process.env);
    await writeSafeEvidence(options.output, evidence);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    if (evidence.status !== "passed") {
      throw new Error("DAST evidence did not pass the release policy");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`DAST evidence failed: ${message}\n`);
    process.exitCode = 1;
  }
}

export function parseDastArgs(args) {
  const options = {
    target: undefined,
    confirmDisposableTarget: false,
    output: undefined,
    dispositions: undefined,
    timeoutSeconds: 900,
    validate: undefined,
    requirePass: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--confirm-disposable-target") {
      options.confirmDisposableTarget = true;
      continue;
    }
    if (argument === "--require-pass") {
      options.requirePass = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    switch (argument) {
      case "--target":
        options.target = value;
        break;
      case "--output":
        options.output = resolve(value);
        break;
      case "--dispositions":
        options.dispositions = resolve(value);
        break;
      case "--timeout-seconds":
        options.timeoutSeconds = strictInteger(value, "--timeout-seconds");
        break;
      case "--validate":
        options.validate = resolve(value);
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.help) return options;
  if (options.validate !== undefined) {
    if (
      options.target !== undefined ||
      options.output !== undefined ||
      options.dispositions !== undefined ||
      options.confirmDisposableTarget
    ) {
      throw new Error("--validate cannot be combined with live scan options");
    }
    return options;
  }
  if (options.requirePass) {
    throw new Error("--require-pass is valid only with --validate");
  }
  if (options.target === undefined || options.output === undefined) {
    throw new Error("--target and --output are required for a live DAST run");
  }
  if (!options.confirmDisposableTarget) {
    throw new Error("--confirm-disposable-target is required for a live DAST run");
  }
  if (options.timeoutSeconds < 60 || options.timeoutSeconds > DAST_MAX_TIMEOUT_SECONDS) {
    throw new Error(`--timeout-seconds must be between 60 and ${String(DAST_MAX_TIMEOUT_SECONDS)}`);
  }
  options.validatedTarget = validateDastTarget(options.target);
  return options;
}

export function validateDastTarget(value) {
  let target;
  try {
    target = new URL(value);
  } catch {
    throw new Error("DAST target must be an absolute URL");
  }
  if (target.username !== "" || target.password !== "") {
    throw new Error("DAST target must not contain URL userinfo");
  }
  if (target.search !== "") {
    throw new Error("DAST target must not contain a query string");
  }
  if (target.hash !== "") {
    throw new Error("DAST target must not contain a fragment");
  }
  if (target.pathname !== "/" && target.pathname !== "") {
    throw new Error("DAST target must be an origin URL without a path");
  }
  const loopback = isLoopbackHostname(target.hostname);
  if (target.protocol !== "https:" && !(loopback && target.protocol === "http:")) {
    throw new Error("DAST target must use HTTPS unless it is an explicit loopback target");
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error("DAST target protocol is unsupported");
  }
  return {
    url: target.origin,
    kind: loopback ? "loopback" : "https",
    originSha256: `sha256:${createHash("sha256").update(target.origin).digest("hex")}`,
  };
}

export async function runDastScan(options, environment = {}) {
  if (options.validatedTarget === undefined) {
    throw new Error("live DAST options were not validated");
  }
  const binding = releaseEvidenceBindingFromEnvironment(environment);
  if (binding === undefined) {
    throw new Error("live DAST requires the complete HELIX_RELEASE_* evidence binding");
  }
  const dispositions =
    options.dispositions === undefined
      ? []
      : validateDispositionInput(
          JSON.parse(await readBoundedFile(options.dispositions, MAX_DISPOSITIONS_BYTES)),
        );
  const workDirectory = await mkdtemp(resolve(tmpdir(), "helix-dast-"));
  // The official image runs as its non-root `zap` user. This randomized
  // directory contains only the transient raw report and is removed after
  // parsing, but it must cross the host/container UID boundary.
  await chmod(workDirectory, 0o777);
  const started = new Date();
  let execution = { outcome: "scanner_error", exitCode: null, reportParsed: false };
  let findings = [];
  try {
    const docker = spawnSync(
      "docker",
      buildZapDockerArgs({
        workDirectory,
        targetUrl: options.validatedTarget.url,
        timeoutSeconds: options.timeoutSeconds,
      }),
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: options.timeoutSeconds * 1_000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
    );
    const rawPath = resolve(workDirectory, RAW_REPORT_NAME);
    let reportParsed = false;
    try {
      findings = summarizeZapReport(
        JSON.parse(await readBoundedFile(rawPath, MAX_RAW_REPORT_BYTES)),
      );
      reportParsed = true;
    } catch {
      findings = [];
    }
    execution = classifyZapExecution({
      status: docker.status,
      errorCode: docker.error?.code,
      reportParsed,
    });
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
  const completed = new Date();
  return buildDastEvidence({
    started,
    completed,
    timeoutSeconds: options.timeoutSeconds,
    target: options.validatedTarget,
    execution,
    findings,
    dispositions,
    binding,
  });
}

export function summarizeZapReport(raw) {
  if (!isRecord(raw)) {
    throw new Error("ZAP JSON report must be an object");
  }
  const sites = Array.isArray(raw.site) ? raw.site : Array.isArray(raw.sites) ? raw.sites : null;
  if (sites === null) {
    throw new Error("ZAP JSON report must contain a site array");
  }
  const findings = new Map();
  for (const site of sites) {
    if (!isRecord(site)) continue;
    const alerts = Array.isArray(site.alerts) ? site.alerts : [];
    for (const alert of alerts) {
      if (!isRecord(alert)) continue;
      const name = safeFindingName(alert.alert ?? alert.name ?? "Unnamed ZAP finding");
      const alertRef = safeAlertRef(alert.alertRef ?? alert.pluginid ?? alert.pluginId, name);
      const severity = zapSeverity(alert);
      const count = positiveCount(
        alert.count,
        Array.isArray(alert.instances) ? alert.instances.length : 1,
      );
      const existing = findings.get(alertRef);
      if (existing === undefined) {
        findings.set(alertRef, { alertRef, name, severity, count });
      } else {
        existing.count += count;
        if (SEVERITIES.indexOf(severity) > SEVERITIES.indexOf(existing.severity)) {
          existing.severity = severity;
        }
      }
    }
  }
  return [...findings.values()].sort((left, right) => left.alertRef.localeCompare(right.alertRef));
}

export function buildZapDockerArgs({ workDirectory, targetUrl, timeoutSeconds }) {
  return [
    "run",
    "--rm",
    "--network",
    "host",
    "--volume",
    `${workDirectory}:/zap/wrk:rw`,
    ZAP_STABLE_IMAGE,
    "zap-baseline.py",
    "-t",
    targetUrl,
    "-J",
    `/zap/wrk/${RAW_REPORT_NAME}`,
    "-I",
    "-m",
    String(Math.max(1, Math.floor(timeoutSeconds / 60))),
  ];
}

export function classifyZapExecution({ status, errorCode, reportParsed }) {
  return {
    outcome:
      errorCode === "ETIMEDOUT"
        ? "timed_out"
        : errorCode !== undefined || ![0, 1, 2].includes(status) || !reportParsed
          ? "scanner_error"
          : "completed",
    exitCode: Number.isInteger(status) ? status : null,
    reportParsed,
  };
}

export function buildDastEvidence({
  started,
  completed,
  timeoutSeconds,
  target,
  execution,
  findings,
  dispositions,
  binding,
}) {
  const summary = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const finding of findings) {
    summary[finding.severity] += finding.count;
  }
  summary.total = SEVERITIES.reduce((total, severity) => total + summary[severity], 0);
  const requiredDispositionRefs = findings
    .filter((finding) => DISPOSITION_SEVERITIES.includes(finding.severity))
    .map((finding) => finding.alertRef);
  const dispositionRefs = new Set(dispositions.map((entry) => entry.alertRef));
  const dispositionsComplete = requiredDispositionRefs.every((ref) => dispositionRefs.has(ref));
  const blockingFindings = summary.high + summary.critical;
  const evidence = {
    schema: DAST_EVIDENCE_SCHEMA,
    mode: "live",
    status:
      execution.outcome === "completed" && blockingFindings === 0 && dispositionsComplete
        ? "passed"
        : "failed",
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    durationMs: completed.getTime() - started.getTime(),
    scanner: {
      name: "OWASP ZAP",
      image: ZAP_STABLE_IMAGE,
    },
    target: {
      kind: target.kind,
      originSha256: target.originSha256,
    },
    execution,
    policy: {
      failOn: FINAL_BLOCKING_SEVERITIES,
      dispositionsRequiredFor: DISPOSITION_SEVERITIES,
      timeoutSeconds,
    },
    summary,
    findings,
    dispositions,
  };
  attachReleaseEvidenceBinding(evidence, binding);
  return validateDastEvidence(evidence);
}

export function validateDastEvidence(evidence, options = {}) {
  assertRecord(evidence, "DAST evidence");
  assertExactKeys(
    evidence,
    [
      "completedAt",
      "dispositions",
      "durationMs",
      "execution",
      "findings",
      "mode",
      "policy",
      "scanner",
      "schema",
      "startedAt",
      "status",
      "summary",
      "target",
    ],
    ["releaseBinding"],
    "DAST evidence",
  );
  if (evidence.schema !== DAST_EVIDENCE_SCHEMA) throw new Error("invalid DAST evidence schema");
  if (!["static", "live"].includes(evidence.mode)) throw new Error("invalid DAST evidence mode");
  if (!["not_run", "passed", "failed"].includes(evidence.status)) {
    throw new Error("invalid DAST evidence status");
  }
  canonicalTimestamp(evidence.startedAt, "DAST startedAt");
  canonicalTimestamp(evidence.completedAt, "DAST completedAt");
  const elapsed = Date.parse(evidence.completedAt) - Date.parse(evidence.startedAt);
  if (
    !Number.isInteger(evidence.durationMs) ||
    evidence.durationMs < 0 ||
    evidence.durationMs !== elapsed
  ) {
    throw new Error("DAST durationMs must equal the canonical timestamp interval");
  }
  assertExactObject(
    evidence.scanner,
    {
      name: "OWASP ZAP",
      image: ZAP_STABLE_IMAGE,
    },
    "DAST scanner",
  );
  assertRecord(evidence.target, "DAST target");
  assertExactKeys(evidence.target, ["kind", "originSha256"], [], "DAST target");
  if (!["https", "loopback", "none"].includes(evidence.target.kind)) {
    throw new Error("invalid DAST target kind");
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(evidence.target.originSha256)) {
    throw new Error("DAST target origin hash must be a sha256 digest");
  }
  assertRecord(evidence.execution, "DAST execution");
  assertExactKeys(
    evidence.execution,
    ["exitCode", "outcome", "reportParsed"],
    [],
    "DAST execution",
  );
  if (
    !["not_run", "completed", "scanner_error", "timed_out"].includes(evidence.execution.outcome)
  ) {
    throw new Error("invalid DAST execution outcome");
  }
  if (evidence.execution.exitCode !== null && !Number.isInteger(evidence.execution.exitCode)) {
    throw new Error("DAST execution exitCode must be an integer or null");
  }
  if (typeof evidence.execution.reportParsed !== "boolean") {
    throw new Error("DAST execution reportParsed must be boolean");
  }
  validatePolicy(evidence.policy);
  const findings = validateFindings(evidence.findings);
  const dispositions = validateDispositionInput(evidence.dispositions, {
    minimumDeadline: evidence.completedAt.slice(0, 10),
  });
  const summary = validateSummary(evidence.summary, findings);
  validateModeConsistency(evidence);
  validateDispositionReferences(findings, dispositions);
  if (evidence.status === "passed" || options.requirePass) {
    validateDispositionCoverage(findings, dispositions);
  }
  if (summary.high > 0 || summary.critical > 0) {
    if (evidence.status === "passed") {
      throw new Error("passed DAST evidence cannot contain High or Critical findings");
    }
  }
  if (evidence.releaseBinding !== undefined) {
    validateReleaseEvidenceBinding(evidence.releaseBinding, options.expectedBinding);
  }
  if (options.requirePass) {
    if (evidence.mode !== "live") throw new Error("final DAST evidence cannot be static");
    if (evidence.status === "not_run") throw new Error("final DAST evidence cannot be not_run");
    if (evidence.status !== "passed") throw new Error("final DAST evidence must be passed");
    if (evidence.execution.outcome !== "completed" || !evidence.execution.reportParsed) {
      throw new Error("final DAST evidence requires a completed scanner execution");
    }
    if (evidence.releaseBinding === undefined) {
      throw new Error("final DAST evidence requires a release binding");
    }
  }
  return evidence;
}

export function createStaticDastEvidence(now = new Date()) {
  const timestamp = now.toISOString();
  return {
    schema: DAST_EVIDENCE_SCHEMA,
    mode: "static",
    status: "not_run",
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
    scanner: { name: "OWASP ZAP", image: ZAP_STABLE_IMAGE },
    target: { kind: "none", originSha256: `sha256:${"0".repeat(64)}` },
    execution: { outcome: "not_run", exitCode: null, reportParsed: false },
    policy: {
      failOn: FINAL_BLOCKING_SEVERITIES,
      dispositionsRequiredFor: DISPOSITION_SEVERITIES,
      timeoutSeconds: 900,
    },
    summary: {
      informational: 0,
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
      total: 0,
    },
    findings: [],
    dispositions: [],
  };
}

function validatePolicy(policy) {
  assertRecord(policy, "DAST policy");
  assertExactKeys(
    policy,
    ["dispositionsRequiredFor", "failOn", "timeoutSeconds"],
    [],
    "DAST policy",
  );
  if (JSON.stringify(policy.failOn) !== JSON.stringify(FINAL_BLOCKING_SEVERITIES)) {
    throw new Error("DAST policy must fail on High and Critical findings");
  }
  if (JSON.stringify(policy.dispositionsRequiredFor) !== JSON.stringify(DISPOSITION_SEVERITIES)) {
    throw new Error("DAST policy must require Medium and Low dispositions");
  }
  if (
    !Number.isInteger(policy.timeoutSeconds) ||
    policy.timeoutSeconds < 60 ||
    policy.timeoutSeconds > DAST_MAX_TIMEOUT_SECONDS
  ) {
    throw new Error("DAST policy timeout is outside the bounded range");
  }
}

function validateFindings(findings) {
  if (!Array.isArray(findings)) throw new Error("DAST findings must be an array");
  if (findings.length > 10_000) throw new Error("DAST findings exceed the evidence bound");
  const refs = new Set();
  for (const finding of findings) {
    assertRecord(finding, "DAST finding");
    assertExactKeys(finding, ["alertRef", "count", "name", "severity"], [], "DAST finding");
    if (!/^[A-Za-z0-9._:-]{1,64}$/u.test(finding.alertRef) || refs.has(finding.alertRef)) {
      throw new Error("DAST finding alertRef must be unique and safe");
    }
    refs.add(finding.alertRef);
    if (
      typeof finding.name !== "string" ||
      finding.name.length < 1 ||
      finding.name.length > 160 ||
      containsControlCharacter(finding.name)
    ) {
      throw new Error("DAST finding name must be bounded printable text");
    }
    if (!SEVERITIES.includes(finding.severity)) throw new Error("invalid DAST finding severity");
    if (!Number.isInteger(finding.count) || finding.count < 1) {
      throw new Error("DAST finding count must be a positive integer");
    }
  }
  return findings;
}

function validateDispositionInput(dispositions, options = {}) {
  if (!Array.isArray(dispositions)) throw new Error("DAST dispositions must be an array");
  const refs = new Set();
  for (const disposition of dispositions) {
    assertRecord(disposition, "DAST disposition");
    assertExactKeys(
      disposition,
      ["alertRef", "deadline", "decision", "owner", "rationale", "severity"],
      [],
      "DAST disposition",
    );
    if (!/^[A-Za-z0-9._:-]{1,64}$/u.test(disposition.alertRef) || refs.has(disposition.alertRef)) {
      throw new Error("DAST disposition alertRef must be unique and safe");
    }
    refs.add(disposition.alertRef);
    if (!DISPOSITION_SEVERITIES.includes(disposition.severity)) {
      throw new Error("DAST dispositions are only valid for Medium or Low findings");
    }
    if (!["accepted", "mitigated", "false_positive"].includes(disposition.decision)) {
      throw new Error("invalid DAST disposition decision");
    }
    boundedText(disposition.owner, 1, 120, "DAST disposition owner");
    boundedText(disposition.rationale, 1, 500, "DAST disposition rationale");
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(disposition.deadline)) {
      throw new Error("DAST disposition deadline must use YYYY-MM-DD");
    }
    const deadline = new Date(`${disposition.deadline}T00:00:00.000Z`);
    if (
      !Number.isFinite(deadline.getTime()) ||
      deadline.toISOString().slice(0, 10) !== disposition.deadline
    ) {
      throw new Error("DAST disposition deadline is invalid");
    }
    if (options.minimumDeadline !== undefined && disposition.deadline < options.minimumDeadline) {
      throw new Error("DAST disposition deadline was already expired at scan completion");
    }
  }
  return dispositions;
}

function validateDispositionCoverage(findings, dispositions) {
  const byRef = new Map(dispositions.map((entry) => [entry.alertRef, entry]));
  for (const finding of findings) {
    if (!DISPOSITION_SEVERITIES.includes(finding.severity)) continue;
    const disposition = byRef.get(finding.alertRef);
    if (disposition === undefined || disposition.severity !== finding.severity) {
      throw new Error(`DAST ${finding.severity} finding ${finding.alertRef} lacks a disposition`);
    }
  }
}

function validateDispositionReferences(findings, dispositions) {
  for (const disposition of dispositions) {
    const finding = findings.find((entry) => entry.alertRef === disposition.alertRef);
    if (finding === undefined) {
      throw new Error(`DAST disposition ${disposition.alertRef} has no matching finding`);
    }
    if (finding.severity !== disposition.severity) {
      throw new Error(
        `DAST disposition ${disposition.alertRef} severity does not match its finding`,
      );
    }
  }
}

function validateSummary(summary, findings) {
  assertRecord(summary, "DAST summary");
  assertExactKeys(summary, [...SEVERITIES, "total"], [], "DAST summary");
  const expected = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const finding of findings) expected[finding.severity] += finding.count;
  expected.total = SEVERITIES.reduce((total, severity) => total + expected[severity], 0);
  for (const [key, count] of Object.entries(expected)) {
    if (summary[key] !== count) throw new Error("DAST summary does not match sanitized findings");
  }
  return summary;
}

function validateModeConsistency(evidence) {
  if (
    evidence.mode === "static" &&
    (evidence.status !== "not_run" ||
      evidence.execution.outcome !== "not_run" ||
      evidence.execution.reportParsed ||
      evidence.findings.length !== 0)
  ) {
    throw new Error("static DAST evidence cannot claim a live result");
  }
  if (evidence.mode === "live" && evidence.status === "not_run") {
    throw new Error("live DAST evidence cannot be not_run");
  }
  if (
    evidence.status === "passed" &&
    (evidence.execution.outcome !== "completed" || !evidence.execution.reportParsed)
  ) {
    throw new Error("passed DAST evidence requires a completed scanner execution");
  }
}

async function writeSafeEvidence(path, evidence) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const existing = await lstat(path).catch(() => null);
  if (existing?.isSymbolicLink()) {
    throw new Error("DAST evidence output must not be a symbolic link");
  }
  const temporaryPath = resolve(dirname(path), `.${randomUUID()}.dast-evidence.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } finally {
    await handle?.close();
    await rm(temporaryPath, { force: true });
  }
}

async function readBoundedFile(path, maxBytes) {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size > maxBytes) {
    throw new Error("DAST input must be a bounded regular file");
  }
  return readFile(path, "utf8");
}

function zapSeverity(alert) {
  const riskCode = Number.parseInt(String(alert.riskcode ?? alert.riskCode ?? ""), 10);
  if (Number.isInteger(riskCode)) {
    if (riskCode >= 4) return "critical";
    if (riskCode === 3) return "high";
    if (riskCode === 2) return "medium";
    if (riskCode === 1) return "low";
    return "informational";
  }
  const label = String(alert.riskdesc ?? alert.risk ?? alert.severity ?? "").toLowerCase();
  return SEVERITIES.findLast((severity) => label.includes(severity)) ?? "informational";
}

function safeAlertRef(value, name) {
  const candidate = typeof value === "string" || typeof value === "number" ? String(value) : "";
  if (/^[A-Za-z0-9._:-]{1,64}$/u.test(candidate)) return candidate;
  return `derived-${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
}

function safeFindingName(value) {
  const normalized = replaceControlCharacters(String(value))
    .replace(/\bhttps?:\/\/\S+/giu, "[url-redacted]")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.length === 0 ? "Unnamed ZAP finding" : normalized.slice(0, 160);
}

function positiveCount(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : Number.isInteger(fallback) && fallback > 0
      ? fallback
      : 1;
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "host.docker.internal" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function assertExactObject(actual, expected, label) {
  assertRecord(actual, label);
  assertExactKeys(actual, Object.keys(expected), [], label);
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw new Error(`${label} ${key} is invalid`);
  }
}

function assertExactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !(key in value)) || keys.some((key) => !allowed.has(key))) {
    throw new Error(`${label} contains unexpected, missing, or secret-like fields`);
  }
  for (const key of keys) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new Error(`${label} contains a secret-like field`);
    }
  }
}

function assertRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value, min, max, label) {
  if (
    typeof value !== "string" ||
    value.length < min ||
    value.length > max ||
    containsControlCharacter(value)
  ) {
    throw new Error(`${label} must be bounded printable text`);
  }
  if (/\b[a-z][a-z0-9+.-]*:\/\/\S+/iu.test(value)) {
    throw new Error(`${label} must not contain a URL`);
  }
}

function containsControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 31 || code === 127);
  });
}

function replaceControlCharacters(value) {
  return [...value]
    .map((character) => (containsControlCharacter(character) ? " " : character))
    .join("");
}

function strictInteger(value, label) {
  if (!/^\d+$/u.test(value)) throw new Error(`${label} must be an integer`);
  return Number.parseInt(value, 10);
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string") throw new Error(`${label} must be a timestamp`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO-8601 timestamp`);
  }
}

function isMain() {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(resolve(process.argv[1])).href
  );
}
