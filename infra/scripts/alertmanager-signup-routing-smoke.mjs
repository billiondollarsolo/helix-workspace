#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const usage = `Usage: infra/scripts/alertmanager-signup-routing-smoke.mjs [--static]

Runs a local Alertmanager routing proof for signup activation SLO alerts:
start a webhook receiver -> start Alertmanager with the bundled route -> post a
synthetic signup alert -> verify the receiver gets the routed alert.

Static validation also checks the production Alertmanager overlay that fans the
same signup activation alerts out to an external paging receiver via url_file.

Environment:
  HELIX_ALERTMANAGER_SMOKE_ALERTMANAGER_PORT  Default: 28461
  HELIX_ALERTMANAGER_SMOKE_RECEIVER_PORT      Default: 28462
  HELIX_ALERTMANAGER_SMOKE_TIMEOUT_MS         Default: 45000
  HELIX_ALERTMANAGER_SMOKE_ADD_HOST_GATEWAY   Default: false
`;

const defaultReceiverUrl = "http://host.docker.internal:28462/alertmanager/signup";
const alertmanagerConfigPath = resolve("infra/observability/alertmanager/alertmanager.yml");
const alertmanagerProductionConfigPath = resolve(
  "infra/observability/alertmanager/alertmanager.production.yml",
);
const prometheusConfigPath = resolve("infra/observability/prometheus/prometheus.yml");
const signupRulesPath = resolve("infra/observability/prometheus/rules/helix-signup-slo.yml");

if (isMain()) {
  await main();
}

async function main() {
  if (process.argv.includes("-h") || process.argv.includes("--help")) {
    process.stdout.write(usage);
    process.exit(0);
  }

  await validateStaticConfig();
  if (process.argv.includes("--static")) {
    process.stdout.write("alertmanager signup routing static validation complete\n");
    process.exit(0);
  }

  const evidence = await runAlertmanagerRoutingSmoke();
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

async function validateStaticConfig() {
  const alertmanagerConfig = await readFile(alertmanagerConfigPath, "utf8");
  const alertmanagerProductionConfig = await readFile(alertmanagerProductionConfigPath, "utf8");
  const prometheusConfig = await readFile(prometheusConfigPath, "utf8");
  const signupRules = await readFile(signupRulesPath, "utf8");
  const alertmanagerConfigs = `${alertmanagerConfig}\n${alertmanagerProductionConfig}`;

  for (const expected of [
    "helix-signup-slo-webhook",
    "helix-signup-slo-paging",
    'service="signup"',
    'slo="signup_activation"',
    "runbook",
  ]) {
    if (
      !alertmanagerConfigs.includes(expected) &&
      !prometheusConfig.includes(expected) &&
      !signupRules.includes(expected)
    ) {
      throw new Error(`expected observability config to include ${expected}`);
    }
  }
  if (!prometheusConfig.includes('targets: ["alertmanager:9093"]')) {
    throw new Error("Prometheus config must point alerting at alertmanager:9093");
  }
  for (const expected of [
    "url_file: /etc/alertmanager/secrets/signup-slo-paging-webhook-url",
    "continue: true",
  ]) {
    if (!alertmanagerProductionConfig.includes(expected)) {
      throw new Error(`production Alertmanager config must include ${expected}`);
    }
  }
  if (alertmanagerConfig.includes("helix-signup-slo-paging")) {
    throw new Error("local Alertmanager config must not require production paging secrets");
  }
  for (const forbidden of ["org_id", "actor_id", "email", "token", "user_agent", "ip_address"]) {
    if (alertmanagerConfigs.includes(forbidden)) {
      throw new Error(`Alertmanager routing config must not include private label ${forbidden}`);
    }
  }
}

async function runAlertmanagerRoutingSmoke() {
  const alertmanagerPort = positiveIntEnv("HELIX_ALERTMANAGER_SMOKE_ALERTMANAGER_PORT", 28_461);
  const receiverPort = positiveIntEnv("HELIX_ALERTMANAGER_SMOKE_RECEIVER_PORT", 28_462);
  const timeoutMs = positiveIntEnv("HELIX_ALERTMANAGER_SMOKE_TIMEOUT_MS", 45_000);
  const containerName = `helix-alertmanager-routing-smoke-${Date.now()}`;
  const tempDir = await mkdtemp(join(tmpdir(), "helix-alertmanager-smoke-"));
  const configPath = await writeSmokeConfig({ receiverPort, tempDir });
  const received = [];
  const receiver = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    received.push({ method: request.method, url: request.url, body });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}\n');
  });

  try {
    await listen(receiver, receiverPort);
    await dockerRm(containerName, true);
    const dockerArgs = [
      "run",
      "--rm",
      "-d",
      "--name",
      containerName,
      "-p",
      `127.0.0.1:${alertmanagerPort}:9093`,
      "-v",
      `${configPath}:/etc/alertmanager/alertmanager.yml:ro`,
      "prom/alertmanager:v0.33.1@sha256:9e082985f56f4c8c9f724e18f2288c6708f472e56a5286b8863d080434ea065d",
      "--config.file=/etc/alertmanager/alertmanager.yml",
      "--storage.path=/alertmanager",
      "--web.listen-address=0.0.0.0:9093",
    ];
    if (truthyEnv("HELIX_ALERTMANAGER_SMOKE_ADD_HOST_GATEWAY")) {
      dockerArgs.splice(5, 0, "--add-host=host.docker.internal:host-gateway");
    }
    await run("docker", dockerArgs);

    const alertmanagerUrl = `http://127.0.0.1:${alertmanagerPort}`;
    await waitForReady(alertmanagerUrl, timeoutMs);
    await postSyntheticSignupAlert(alertmanagerUrl);
    await waitForReceivedAlert(received, timeoutMs);

    return {
      status: "passed",
      alertmanagerUrl,
      receiverUrl: `http://127.0.0.1:${receiverPort}/alertmanager/signup`,
      receiverRequests: received.length,
    };
  } finally {
    await dockerRm(containerName, true);
    await closeServer(receiver);
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function writeSmokeConfig({ receiverPort, tempDir }) {
  const source = await readFile(alertmanagerConfigPath, "utf8");
  const receiverUrl = `http://host.docker.internal:${receiverPort}/alertmanager/signup`;
  const config = source
    .replace(defaultReceiverUrl, receiverUrl)
    .replace("group_wait: 10s", "group_wait: 1s");
  const configPath = join(tempDir, "alertmanager.yml");
  await writeFile(configPath, config, "utf8");
  return configPath;
}

async function waitForReady(alertmanagerUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${alertmanagerUrl}/-/ready`);
      if (response.ok) {
        return;
      }
    } catch {
      // Keep polling until the container is ready or the timeout expires.
    }
    await sleep(500);
  }
  throw new Error(`Alertmanager did not become ready within ${timeoutMs}ms`);
}

async function postSyntheticSignupAlert(alertmanagerUrl) {
  const response = await fetch(`${alertmanagerUrl}/api/v2/alerts`, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify([
      {
        labels: {
          alertname: "HelixSignupActivationP95High",
          severity: "warning",
          priority: "p2",
          service: "signup",
          slo: "signup_activation",
          tier: "business",
          plan_id: "pro",
          region: "default",
        },
        annotations: {
          runbook_url: "docs/specs/05-operations/runbooks/signup-activation-slo-breach.md",
          summary: "Signup activation p95 is above 60 seconds",
        },
        generatorURL: "http://prometheus.local/graph?g0.expr=signup_activation",
        startsAt: new Date().toISOString(),
      },
    ]),
  });
  if (!response.ok) {
    throw new Error(`Alertmanager rejected synthetic alert: HTTP ${response.status}`);
  }
}

async function waitForReceivedAlert(received, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (received.some((request) => requestMatchesSignupAlert(request))) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Signup alert was not routed to receiver within ${timeoutMs}ms`);
}

function requestMatchesSignupAlert(request) {
  if (request.method !== "POST" || request.url !== "/alertmanager/signup") {
    return false;
  }
  const parsed = parseJson(request.body);
  const alerts = Array.isArray(parsed?.alerts) ? parsed.alerts : [];
  return alerts.some((alert) => {
    const labels = isRecord(alert?.labels) ? alert.labels : {};
    const annotations = isRecord(alert?.annotations) ? alert.annotations : {};
    return (
      labels.service === "signup" &&
      labels.slo === "signup_activation" &&
      annotations.runbook_url ===
        "docs/specs/05-operations/runbooks/signup-activation-slo-breach.md"
    );
  });
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function listen(server, port) {
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
}

async function closeServer(server) {
  await new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
  });
}

async function dockerRm(containerName, ignoreErrors) {
  try {
    await run("docker", ["rm", "-f", containerName]);
  } catch (error) {
    if (!ignoreErrors) {
      throw error;
    }
  }
}

async function run(command, args) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with ${code}: ${stderr || stdout}`));
    });
  });
}

function positiveIntEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function truthyEnv(name) {
  const raw = process.env[name];
  return raw === "1" || raw === "true" || raw === "yes";
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isMain() {
  return import.meta.url === `file://${process.argv[1]}`;
}
