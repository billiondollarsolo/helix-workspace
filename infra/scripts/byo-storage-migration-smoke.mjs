#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";

const routeMigrations = "/api/admin/tenant-config/byo-storage/migrations";
const routeTenantConfig = "/api/admin/tenant-config";

const usage = `Usage: infra/scripts/byo-storage-migration-smoke.mjs [options]

Opt-in live tenant storage migration proof. The safe default queues a dry-run
migration against an already-running Helix stack and polls until the worker marks
it dry_run. Live copy and cutover require explicit confirmation flags.

Options:
  --target <byo|helix-default>     Migration target. Default: HELIX_BYO_STORAGE_MIGRATION_SMOKE_TARGET or byo
  --source-storage <json-object>   Source storage snapshot JSON. Default: HELIX_BYO_STORAGE_MIGRATION_SMOKE_SOURCE_STORAGE_JSON
  --target-storage <json-object>   Target storage snapshot JSON. Default: HELIX_BYO_STORAGE_MIGRATION_SMOKE_TARGET_STORAGE_JSON
  --live --confirm LIVE            Queue and poll a live migration after dry-run succeeds
  --cutover --confirm-cutover CUTOVER
                                  Cut over tenant storage after a succeeded live migration
  --static                         Validate script wiring only
  -h, --help

Environment:
  HELIX_BASE_URL                                   Default: http://127.0.0.1:28431
  AUTH_TOKEN                                       Optional bearer token. If absent, OAuth is used.
  HELIX_SMOKE_CLIENT_ID                            OAuth client id when AUTH_TOKEN is absent
  HELIX_SMOKE_CLIENT_SECRET                        OAuth client secret when AUTH_TOKEN is absent
  HELIX_SMOKE_SCOPE                                Default: admin.console.read admin.console.write platform.read
  HELIX_BYO_STORAGE_MIGRATION_SMOKE_TARGET         byo | helix-default. Default: byo
  HELIX_BYO_STORAGE_MIGRATION_SMOKE_SOURCE_STORAGE_JSON Optional source snapshot JSON
  HELIX_BYO_STORAGE_MIGRATION_SMOKE_TARGET_STORAGE_JSON Optional target snapshot JSON
  HELIX_BYO_STORAGE_MIGRATION_SMOKE_TIMEOUT_MS     Default: 60000
  HELIX_BYO_STORAGE_MIGRATION_SMOKE_POLL_MS        Default: 1000
  HELIX_BYO_STORAGE_MIGRATION_SMOKE_OUTPUT         Optional JSON evidence output path

Typical live BYO target storage JSON:
  {"kind":"byo","provider":"aws-s3","bucket":"acme-helix-data","credentials_vault_path":"tenants/acme/byo-storage/aws"}
`;

const terminalStatuses = new Set(["dry_run", "succeeded", "succeeded_with_errors", "failed"]);

if (isMain()) {
  await main();
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage);
    return;
  }
  if (args.static) {
    validateStaticContract();
    process.stdout.write("BYO storage migration smoke static validation complete\n");
    return;
  }

  const baseUrl = env("HELIX_BASE_URL", "http://127.0.0.1:28431");
  const timeoutMs = positiveIntEnv("HELIX_BYO_STORAGE_MIGRATION_SMOKE_TIMEOUT_MS", 60_000);
  const pollMs = positiveIntEnv("HELIX_BYO_STORAGE_MIGRATION_SMOKE_POLL_MS", 1000);
  const token = await getAccessToken(baseUrl, timeoutMs);
  const startedAt = Date.now();
  const request = migrationRequestFromArgs(args);

  const dryRun = await requestMigration(baseUrl, token, timeoutMs, {
    ...request,
    dryRun: true,
  });
  const completedDryRun = await pollMigration(baseUrl, token, dryRun.id, {
    timeoutMs,
    pollMs,
  });
  if (completedDryRun.status !== "dry_run") {
    throw new Error(`dry-run migration ended with ${completedDryRun.status}`);
  }

  let live = null;
  let cutover = null;
  if (args.live) {
    const liveMigration = await requestMigration(baseUrl, token, timeoutMs, {
      ...request,
      dryRun: false,
    });
    live = await pollMigration(baseUrl, token, liveMigration.id, { timeoutMs, pollMs });
    if (live.status !== "succeeded") {
      throw new Error(`live migration ended with ${live.status}`);
    }
    if (args.cutover) {
      cutover = await cutoverMigration(baseUrl, token, timeoutMs, live.id);
    }
  }

  const completedAt = Date.now();
  const evidence = {
    status: "passed",
    baseUrl,
    target: request.target,
    sourceStorage: redactedStorageSummary(request.sourceStorage),
    targetStorage: redactedStorageSummary(request.targetStorage),
    dryRun: migrationSummary(completedDryRun),
    live: live === null ? null : migrationSummary(live),
    cutover:
      cutover === null
        ? null
        : {
            migration: migrationSummary(cutover.migration),
            tenantStorage: redactedStorageSummary(cutover.tenantConfig?.byo?.storage),
          },
    latencyMs: completedAt - startedAt,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
  };

  await writeEvidence(evidence);
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

export function parseArgs(args) {
  const parsed = {
    target: undefined,
    sourceStorage: undefined,
    targetStorage: undefined,
    live: false,
    confirmLive: false,
    cutover: false,
    confirmCutover: false,
    static: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--target":
        parsed.target = requireArg(args, (index += 1), "--target");
        break;
      case "--source-storage":
        parsed.sourceStorage = parseJsonObject(requireArg(args, (index += 1), "--source-storage"));
        break;
      case "--target-storage":
        parsed.targetStorage = parseJsonObject(requireArg(args, (index += 1), "--target-storage"));
        break;
      case "--live":
        parsed.live = true;
        break;
      case "--confirm":
        parsed.confirmLive = requireArg(args, (index += 1), "--confirm") === "LIVE";
        break;
      case "--cutover":
        parsed.cutover = true;
        break;
      case "--confirm-cutover":
        parsed.confirmCutover = requireArg(args, (index += 1), "--confirm-cutover") === "CUTOVER";
        break;
      case "--static":
        parsed.static = true;
        break;
      case "--":
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  if (parsed.live && !parsed.confirmLive) {
    throw new Error("live migration smoke requires --confirm LIVE");
  }
  if (parsed.cutover && (!parsed.live || !parsed.confirmCutover)) {
    throw new Error("cutover smoke requires --live --confirm LIVE --confirm-cutover CUTOVER");
  }
  return parsed;
}

function validateStaticContract() {
  for (const expected of [
    "HELIX_BYO_STORAGE_MIGRATION_SMOKE_TARGET_STORAGE_JSON",
    "HELIX_BYO_STORAGE_MIGRATION_SMOKE_SOURCE_STORAGE_JSON",
    routeMigrations,
    routeTenantConfig,
    "--live --confirm LIVE",
    "--cutover --confirm-cutover CUTOVER",
  ]) {
    if (!usage.includes(expected) && ![routeMigrations, routeTenantConfig].includes(expected)) {
      throw new Error(`static contract is missing ${expected}`);
    }
  }
}

function migrationRequestFromArgs(args) {
  const target = args.target ?? env("HELIX_BYO_STORAGE_MIGRATION_SMOKE_TARGET", "byo");
  if (target !== "byo" && target !== "helix-default") {
    throw new Error("migration target must be byo or helix-default");
  }
  return {
    target,
    sourceStorage:
      args.sourceStorage ??
      optionalJsonObjectEnv("HELIX_BYO_STORAGE_MIGRATION_SMOKE_SOURCE_STORAGE_JSON"),
    targetStorage:
      args.targetStorage ??
      optionalJsonObjectEnv("HELIX_BYO_STORAGE_MIGRATION_SMOKE_TARGET_STORAGE_JSON"),
  };
}

async function getAccessToken(apiBaseUrl, timeoutMs) {
  const provided = optionalEnv("AUTH_TOKEN");
  if (provided !== undefined) {
    return provided;
  }
  const clientId = requiredEnv("HELIX_SMOKE_CLIENT_ID");
  const clientSecret = requiredEnv("HELIX_SMOKE_CLIENT_SECRET");
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: env("HELIX_SMOKE_SCOPE", "admin.console.read admin.console.write platform.read"),
  });
  const response = await request(new URL("/oauth/token", apiBaseUrl), {
    method: "POST",
    timeoutMs,
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const parsed = await readJsonResponse(response, "OAuth token mint");
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new Error("OAuth token response did not include access_token");
  }
  return parsed.access_token;
}

async function requestMigration(apiBaseUrl, token, timeoutMs, input) {
  const response = await apiRequest(apiBaseUrl, token, timeoutMs, "POST", routeMigrations, {
    target: input.target,
    dryRun: input.dryRun,
    ...(input.sourceStorage === undefined ? {} : { sourceStorage: input.sourceStorage }),
    ...(input.targetStorage === undefined ? {} : { targetStorage: input.targetStorage }),
  });
  const parsed = await readJsonResponse(
    response,
    input.dryRun
      ? "request dry-run tenant storage migration"
      : "request live tenant storage migration",
  );
  return requireMigration(parsed);
}

async function pollMigration(apiBaseUrl, token, migrationId, options) {
  const deadline = Date.now() + options.timeoutMs;
  let lastMigration;
  while (Date.now() <= deadline) {
    const response = await apiRequest(
      apiBaseUrl,
      token,
      options.timeoutMs,
      "GET",
      `${routeMigrations}/${encodeURIComponent(migrationId)}`,
    );
    const parsed = await readJsonResponse(response, `poll tenant storage migration ${migrationId}`);
    lastMigration = requireMigration(parsed);
    if (terminalStatuses.has(lastMigration.status)) {
      return lastMigration;
    }
    await sleep(options.pollMs);
  }
  throw new Error(
    `tenant storage migration ${migrationId} did not finish before timeout; last status: ${
      lastMigration?.status ?? "unknown"
    }`,
  );
}

async function cutoverMigration(apiBaseUrl, token, timeoutMs, migrationId) {
  const response = await apiRequest(
    apiBaseUrl,
    token,
    timeoutMs,
    "POST",
    `${routeMigrations}/${encodeURIComponent(migrationId)}/cutover`,
    { confirm: "CUTOVER" },
  );
  const parsed = await readJsonResponse(
    response,
    `cut over tenant storage migration ${migrationId}`,
  );
  if (parsed.migration === undefined || parsed.tenantConfig === undefined) {
    throw new Error("tenant storage cutover response did not include migration and tenantConfig");
  }
  return {
    migration: requireMigration(parsed),
    tenantConfig: parsed.tenantConfig,
  };
}

function requireMigration(parsed) {
  const migration = parsed.migration;
  if (
    migration === undefined ||
    typeof migration !== "object" ||
    typeof migration.id !== "string"
  ) {
    throw new Error("tenant storage migration response did not include migration.id");
  }
  return migration;
}

async function apiRequest(apiBaseUrl, token, timeoutMs, method, path, body) {
  return request(new URL(path, apiBaseUrl), {
    method,
    timeoutMs,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function request(url, { timeoutMs, ...init }) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function readJsonResponse(response, label) {
  let parsed;
  try {
    parsed = await response.json();
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${errorMessage(error)}`);
  }
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}: ${safeStringify(parsed)}`);
  }
  return parsed;
}

function migrationSummary(migration) {
  return {
    id: migration.id,
    target: migration.target,
    status: migration.status,
    dryRun: migration.dryRun,
    plannedCount: migration.plannedCount,
    copiedCount: migration.copiedCount,
    verifiedCount: migration.verifiedCount,
    failureCount: Array.isArray(migration.failures) ? migration.failures.length : null,
    lastError: migration.lastError ?? null,
  };
}

function redactedStorageSummary(storage) {
  if (storage === null || storage === undefined) {
    return null;
  }
  return safeRedact(storage);
}

function safeRedact(value) {
  if (Array.isArray(value)) {
    return value.map((item) => safeRedact(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        isSecretKey(key) ? "[redacted]" : safeRedact(nestedValue),
      ]),
    );
  }
  return value;
}

function isSecretKey(key) {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("secret") ||
    normalized.includes("token") ||
    normalized.includes("accesskey")
  );
}

async function writeEvidence(evidence) {
  const outputPath = optionalEnv("HELIX_BYO_STORAGE_MIGRATION_SMOKE_OUTPUT");
  if (outputPath !== undefined) {
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
}

function optionalJsonObjectEnv(name) {
  const value = optionalEnv(name);
  return value === undefined ? undefined : parseJsonObject(value);
}

function parseJsonObject(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`expected JSON object: ${errorMessage(error)}`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("expected JSON object");
  }
  return parsed;
}

function requireArg(args, index, flag) {
  const value = args[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function env(name, fallback) {
  return optionalEnv(name) ?? fallback;
}

function requiredEnv(name) {
  const value = optionalEnv(name);
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalEnv(name) {
  const value = process.env[name];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function positiveIntEnv(name, fallback) {
  const raw = optionalEnv(name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function safeStringify(value) {
  return JSON.stringify(safeRedact(value));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isMain() {
  return process.argv[1] === new URL(import.meta.url).pathname;
}

export function createMockByoStorageMigrationSmokeServer() {
  const requests = [];
  const targetStorage = {
    kind: "byo",
    provider: "aws-s3",
    bucket: "helix-smoke",
    credentials_vault_path: "tenants/acme/byo-storage/aws",
  };
  const migrations = new Map();
  let counter = 0;
  const server = createServer(async (requestMessage, response) => {
    const chunks = [];
    for await (const chunk of requestMessage) {
      chunks.push(chunk);
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText.length === 0 ? null : JSON.parse(bodyText);
    requests.push({ method: requestMessage.method, url: requestMessage.url, body });
    response.setHeader("content-type", "application/json");
    if (requestMessage.url === routeMigrations && requestMessage.method === "POST") {
      counter += 1;
      const migration = {
        id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
        orgId: "org-smoke",
        target: body.target ?? "byo",
        status: body.dryRun ? "queued" : "running",
        dryRun: body.dryRun,
        sourceStorage: { managedBy: "helix-default", storage: null },
        targetStorage: { managedBy: "byo", storage: body.targetStorage ?? targetStorage },
        plannedCount: body.dryRun ? 2 : 2,
        copiedCount: 0,
        verifiedCount: 0,
        failures: [],
        lastError: null,
        attemptCount: 1,
        requestedByActorId: "actor-smoke",
        startedAt: null,
        completedAt: null,
        createdAt: "2026-05-26T06:00:00.000Z",
        updatedAt: "2026-05-26T06:00:00.000Z",
      };
      migrations.set(migration.id, migration);
      response.statusCode = 202;
      response.end(JSON.stringify({ migration }));
      return;
    }
    const migrationGet = /^\/api\/admin\/tenant-config\/byo-storage\/migrations\/([^/]+)$/u.exec(
      requestMessage.url ?? "",
    );
    if (migrationGet !== null && requestMessage.method === "GET") {
      const migration = migrations.get(decodeURIComponent(migrationGet[1]));
      if (migration === undefined) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      if (migration.dryRun) {
        migration.status = "dry_run";
      } else {
        migration.status = "succeeded";
        migration.copiedCount = migration.plannedCount;
        migration.verifiedCount = migration.plannedCount;
      }
      migration.completedAt = "2026-05-26T06:00:01.000Z";
      migration.updatedAt = "2026-05-26T06:00:01.000Z";
      response.end(JSON.stringify({ migration }));
      return;
    }
    const cutover =
      /^\/api\/admin\/tenant-config\/byo-storage\/migrations\/([^/]+)\/cutover$/u.exec(
        requestMessage.url ?? "",
      );
    if (cutover !== null && requestMessage.method === "POST") {
      const migration = migrations.get(decodeURIComponent(cutover[1]));
      if (migration === undefined) {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not found" }));
        return;
      }
      response.end(
        JSON.stringify({
          migration,
          tenantConfig: {
            orgId: "org-smoke",
            byo: { storage: migration.targetStorage.storage },
            features: { byo_storage: true },
            quotas: {},
            branding: {},
            plan: null,
            effective: {
              byo: { storage: migration.targetStorage.storage },
              features: { byo_storage: true },
              quotas: {},
              branding: {},
            },
          },
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  return { server, requests };
}

export async function runSmokeChild(scriptPath, options) {
  const child = spawn(process.execPath, [scriptPath, ...options.args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((resolveStatus, rejectStatus) => {
    child.once("error", rejectStatus);
    child.once("exit", (code, signal) => {
      resolveStatus({ code, signal });
    });
  });
  return {
    status: status.code,
    signal: status.signal,
    stdout,
    stderr,
  };
}
