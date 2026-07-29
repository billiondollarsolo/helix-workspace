#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import {
  assertFailureRecoveryEvidenceContainsNoSecrets,
  createLiveFailureRecoveryEvidence,
  createStaticFailureRecoveryEvidence,
  FAILURE_RECOVERY_SCENARIOS,
  finalizeFailureRecoveryEvidence,
  validateFailureRecoveryEvidence,
  validateFailureRecoveryScenario,
} from "./failure-recovery-contract.mjs";
import {
  attachReleaseEvidenceBinding,
  releaseEvidenceBindingFromEnvironment,
} from "./release-evidence-binding.mjs";

const FAULT_ACKNOWLEDGEMENT = "I_ACKNOWLEDGE_DISPOSABLE_FAULT_INJECTION";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_HARNESS_OUTPUT_BYTES = 1024 * 1024;
const usage = `Usage:
  node infra/scripts/failure-recovery-runner.mjs --static [--output <report.json>]
  node infra/scripts/failure-recovery-runner.mjs --live --allow-fault-injection [--output <report.json>]
  node infra/scripts/failure-recovery-runner.mjs --validate <report.json> [--require-pass]

Live mode is destructive and is accepted only for a disposable environment.

Required live environment:
  HELIX_FAILURE_RECOVERY_ACK=${FAULT_ACKNOWLEDGEMENT}
  HELIX_FAILURE_RECOVERY_ENVIRONMENT_CLASS=disposable
  HELIX_FAILURE_RECOVERY_ENVIRONMENT_ID=disposable-<unique-id>
  HELIX_FAILURE_RECOVERY_HARNESS=/absolute/path/to/executable-or-mjs

The harness is invoked once per scenario with:
  --scenario <id> --run-id <id> --environment-id <id>

It must print exactly one helix.failure-recovery-observation.v1 JSON document to stdout.
`;

export async function runFailureRecoveryEvidence(options, dependencies = {}) {
  if (options.mode === "static") {
    return createStaticFailureRecoveryEvidence(dependencies.now?.() ?? new Date());
  }
  const config = await validateLiveConfiguration(options, dependencies);
  const now = dependencies.now ?? (() => new Date());
  const report = createLiveFailureRecoveryEvidence({
    environmentId: config.environmentId,
    startedAt: now(),
  });
  const runHarness = dependencies.runHarness ?? executeHarness;

  for (const contract of FAILURE_RECOVERY_SCENARIOS) {
    try {
      const observation = await runHarness({
        contract,
        runId: report.runId,
        environmentId: config.environmentId,
        harness: config.harness,
        timeoutMs: config.timeoutMs,
        environment: config.environment,
      });
      const validated = validateFailureRecoveryScenario(observation, contract);
      assertFailureRecoveryEvidenceContainsNoSecrets(validated);
      report.scenarios[contract.id] = validated;
    } catch {
      report.scenarios[contract.id] = {
        status: "failed",
        reasonCode: "harness_contract_or_execution_failed",
      };
    }
  }
  return finalizeFailureRecoveryEvidence(report, now());
}

export async function executeHarness(input) {
  const harnessArguments = [
    "--scenario",
    input.contract.id,
    "--run-id",
    input.runId,
    "--environment-id",
    input.environmentId,
  ];
  const isModule = /\.(?:mjs|cjs|js)$/u.test(input.harness);
  const command = isModule ? process.execPath : input.harness;
  const args = isModule ? [input.harness, ...harnessArguments] : harnessArguments;
  const result = await captureProcess(command, args, {
    timeoutMs: input.timeoutMs,
    environment: {
      ...input.environment,
      HELIX_FAILURE_RECOVERY_SCENARIO: input.contract.id,
      HELIX_FAILURE_RECOVERY_RUN_ID: input.runId,
      HELIX_FAILURE_RECOVERY_ENVIRONMENT_ID: input.environmentId,
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(`failure/recovery harness exited ${String(result.exitCode)}`);
  }
  let observation;
  try {
    observation = JSON.parse(result.stdout);
  } catch {
    throw new Error("failure/recovery harness did not emit one JSON observation");
  }
  return observation;
}

async function validateLiveConfiguration(options, dependencies) {
  const environment = options.environment ?? process.env;
  if (options.allowFaultInjection !== true) {
    throw new Error("live failure/recovery requires --allow-fault-injection");
  }
  if (environment.HELIX_FAILURE_RECOVERY_ACK !== FAULT_ACKNOWLEDGEMENT) {
    throw new Error("live failure/recovery acknowledgement is missing");
  }
  if (environment.HELIX_FAILURE_RECOVERY_ENVIRONMENT_CLASS !== "disposable") {
    throw new Error("failure/recovery faults are permitted only in a disposable environment");
  }
  const environmentId = environment.HELIX_FAILURE_RECOVERY_ENVIRONMENT_ID ?? "";
  if (
    !/^disposable-[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/u.test(environmentId) ||
    /(?:^|[-_.])(prod|production|customer|live)(?:$|[-_.])/iu.test(environmentId)
  ) {
    throw new Error("failure/recovery environment id must name a disposable non-production target");
  }
  const harness = environment.HELIX_FAILURE_RECOVERY_HARNESS ?? "";
  if (!isAbsolute(harness)) {
    throw new Error("HELIX_FAILURE_RECOVERY_HARNESS must be an absolute path");
  }
  const fileStat = await (dependencies.stat ?? stat)(harness);
  if (!fileStat.isFile()) {
    throw new Error("HELIX_FAILURE_RECOVERY_HARNESS must reference a file");
  }
  const timeoutMs = parseTimeout(environment.HELIX_FAILURE_RECOVERY_TIMEOUT_MS);
  return { environment, environmentId, harness, timeoutMs };
}

function captureProcess(command, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: options.environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let outputBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectOnce(new Error("failure/recovery harness timed out"));
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > MAX_HARNESS_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        rejectOnce(new Error("failure/recovery harness output exceeded the safe limit"));
        return;
      }
      stdout += chunk;
    });
    child.on("error", rejectOnce);
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, stdout });
    });

    function rejectOnce(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    }
  });
}

function parseTimeout(raw) {
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 30 * 60 * 1000) {
    throw new Error("HELIX_FAILURE_RECOVERY_TIMEOUT_MS must be 1000..1800000");
  }
  return value;
}

async function writeReport(report, output) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output !== undefined) {
    const target = resolve(output);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, serialized, { encoding: "utf8", mode: 0o600 });
  }
  process.stdout.write(serialized);
}

function parseArguments(argv) {
  let mode;
  let output;
  let validatePath;
  let requirePass = false;
  let allowFaultInjection = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--static" || argument === "--live") {
      if (mode !== undefined) throw new Error("choose exactly one execution mode");
      mode = argument.slice(2);
    } else if (argument === "--validate") {
      validatePath = requiredValue(argv, ++index, argument);
    } else if (argument === "--output") {
      output = requiredValue(argv, ++index, argument);
    } else if (argument === "--require-pass") {
      requirePass = true;
    } else if (argument === "--allow-fault-injection") {
      allowFaultInjection = true;
    } else if (argument === "--help" || argument === "-h") {
      return { help: true };
    } else {
      throw new Error(`unknown argument: ${String(argument)}`);
    }
  }
  if ((validatePath === undefined) === (mode === undefined)) {
    throw new Error("choose one of --static, --live, or --validate");
  }
  return { mode, output, validatePath, requirePass, allowFaultInjection };
}

function requiredValue(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  if (options.validatePath !== undefined) {
    const report = JSON.parse(await readFile(options.validatePath, "utf8"));
    validateFailureRecoveryEvidence(report, { requirePass: options.requirePass });
    await writeReport(report, options.output);
    return;
  }
  const report = await runFailureRecoveryEvidence(options);
  attachReleaseEvidenceBinding(report, releaseEvidenceBindingFromEnvironment(process.env));
  validateFailureRecoveryEvidence(report, { requirePass: options.requirePass });
  await writeReport(report, options.output);
  if (options.mode === "live" && report.status !== "passed") {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `failure/recovery evidence failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
