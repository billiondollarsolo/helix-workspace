#!/usr/bin/env node
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";

const usage = `Usage: infra/scripts/byo-storage-credential-rotation-smoke.mjs [options]

Opt-in live BYO-storage credential rotation proof. The script talks to an
already-running Helix stack, optionally configures the current tenant's
BYO-storage target, rotates credentials twice, and verifies each rotation by the
backend's tenant storage write/read/delete health probe.

Options:
  --configure-tenant-storage   PATCH tenant config from HELIX_BYO_STORAGE_SMOKE_* env
  --restore-tenant-storage     Restore initial byo/features config after the smoke
  --static                     Validate script wiring only
  -h, --help

Environment:
  HELIX_BASE_URL                                Default: http://127.0.0.1:28431
  AUTH_TOKEN                                    Optional bearer token. If absent, OAuth is used.
  HELIX_SMOKE_CLIENT_ID                         OAuth client id when AUTH_TOKEN is absent
  HELIX_SMOKE_CLIENT_SECRET                     OAuth client secret when AUTH_TOKEN is absent
  HELIX_SMOKE_SCOPE                             Default: admin.console.read admin.console.write platform.read
  HELIX_BYO_STORAGE_SMOKE_PROVIDER              aws-s3 | r2 | s3-compatible. Required with --configure-tenant-storage
  HELIX_BYO_STORAGE_SMOKE_ENDPOINT              Required for r2 and s3-compatible with --configure-tenant-storage
  HELIX_BYO_STORAGE_SMOKE_REGION                Default: us-east-1
  HELIX_BYO_STORAGE_SMOKE_BUCKET                Required with --configure-tenant-storage
  HELIX_BYO_STORAGE_SMOKE_PREFIX                Optional tenant object prefix
  HELIX_BYO_STORAGE_SMOKE_CREDENTIALS_VAULT_PATH Required with --configure-tenant-storage
  HELIX_BYO_STORAGE_SMOKE_FORCE_PATH_STYLE      Default: true for r2/s3-compatible, false for aws-s3
  HELIX_BYO_STORAGE_SMOKE_SSE_KMS_KEY_ARN       Optional AWS SSE-KMS key ARN
  HELIX_BYO_STORAGE_SMOKE_ACCESS_KEY_ID         Required live credential
  HELIX_BYO_STORAGE_SMOKE_SECRET_ACCESS_KEY     Required live credential
  HELIX_BYO_STORAGE_SMOKE_SESSION_TOKEN         Optional live credential
  HELIX_BYO_STORAGE_SMOKE_ROTATED_ACCESS_KEY_ID Required rotated credential
  HELIX_BYO_STORAGE_SMOKE_ROTATED_SECRET_ACCESS_KEY Required rotated credential
  HELIX_BYO_STORAGE_SMOKE_ROTATED_SESSION_TOKEN Optional rotated credential
  HELIX_BYO_STORAGE_SMOKE_TIMEOUT_MS            Default: 30000
  HELIX_BYO_STORAGE_SMOKE_OUTPUT                Optional JSON evidence output path
`;

const routeTenantConfig = "/api/admin/tenant-config";
const routeCredentials = "/api/admin/tenant-config/byo-storage/credentials";
const routeStorageTest = "/api/admin/tenant-config/byo-storage/test";

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
    process.stdout.write("BYO storage credential rotation smoke static validation complete\n");
    return;
  }

  const baseUrl = env("HELIX_BASE_URL", "http://127.0.0.1:28431");
  const timeoutMs = positiveIntEnv("HELIX_BYO_STORAGE_SMOKE_TIMEOUT_MS", 30_000);
  const token = await getAccessToken(baseUrl, timeoutMs);
  const startedAt = Date.now();
  const initialConfig = await getTenantConfig(baseUrl, token, timeoutMs);
  const configuredStorage = args.configureTenantStorage
    ? await configureTenantStorage(baseUrl, token, timeoutMs)
    : storageConfigFromTenantConfig(initialConfig);

  const rotations = [];
  try {
    rotations.push(
      await rotateCredentials(baseUrl, token, timeoutMs, {
        label: "initial",
        credentials: {
          accessKeyId: requiredEnv("HELIX_BYO_STORAGE_SMOKE_ACCESS_KEY_ID"),
          secretAccessKey: requiredEnv("HELIX_BYO_STORAGE_SMOKE_SECRET_ACCESS_KEY"),
          sessionToken: optionalEnv("HELIX_BYO_STORAGE_SMOKE_SESSION_TOKEN"),
        },
        reason: "live smoke: seed BYO storage credentials",
      }),
    );
    rotations.push(
      await rotateCredentials(baseUrl, token, timeoutMs, {
        label: "rotated",
        credentials: {
          accessKeyId: requiredEnv("HELIX_BYO_STORAGE_SMOKE_ROTATED_ACCESS_KEY_ID"),
          secretAccessKey: requiredEnv("HELIX_BYO_STORAGE_SMOKE_ROTATED_SECRET_ACCESS_KEY"),
          sessionToken: optionalEnv("HELIX_BYO_STORAGE_SMOKE_ROTATED_SESSION_TOKEN"),
        },
        reason: "live smoke: rotate BYO storage credentials",
      }),
    );

    const finalHealth = await testStorage(baseUrl, token, timeoutMs);
    assertHealthy(finalHealth, "final BYO storage probe");
    const completedAt = Date.now();
    const evidence = {
      status: "passed",
      baseUrl,
      configuredTenantStorage: redactedStorageSummary(configuredStorage),
      rotations,
      finalHealth: healthSummary(finalHealth),
      configuredTenantStorageDuringSmoke: args.configureTenantStorage,
      restoredTenantStorage: false,
      latencyMs: completedAt - startedAt,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString(),
    };

    if (args.restoreTenantStorage) {
      await restoreTenantConfig(baseUrl, token, timeoutMs, initialConfig);
      evidence.restoredTenantStorage = true;
    }
    await writeEvidence(evidence);
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    if (args.restoreTenantStorage) {
      await restoreTenantConfig(baseUrl, token, timeoutMs, initialConfig);
    }
    throw error;
  }
}

export function parseArgs(args) {
  const parsed = {
    configureTenantStorage: false,
    restoreTenantStorage: false,
    static: false,
    help: false,
  };
  for (const arg of args) {
    switch (arg) {
      case "--configure-tenant-storage":
        parsed.configureTenantStorage = true;
        break;
      case "--restore-tenant-storage":
        parsed.restoreTenantStorage = true;
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
  return parsed;
}

function validateStaticContract() {
  for (const expected of [
    "HELIX_BYO_STORAGE_SMOKE_PROVIDER",
    "HELIX_BYO_STORAGE_SMOKE_BUCKET",
    "HELIX_BYO_STORAGE_SMOKE_ACCESS_KEY_ID",
    "HELIX_BYO_STORAGE_SMOKE_ROTATED_ACCESS_KEY_ID",
    routeTenantConfig,
    routeCredentials,
    routeStorageTest,
  ]) {
    if (
      !usage.includes(expected) &&
      ![routeTenantConfig, routeCredentials, routeStorageTest].includes(expected)
    ) {
      throw new Error(`static contract is missing ${expected}`);
    }
  }
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

async function getTenantConfig(apiBaseUrl, token, timeoutMs) {
  const response = await apiRequest(apiBaseUrl, token, timeoutMs, "GET", routeTenantConfig);
  const parsed = await readJsonResponse(response, "load tenant config");
  if (parsed.tenantConfig === undefined || typeof parsed.tenantConfig !== "object") {
    throw new Error("tenant config response did not include tenantConfig");
  }
  return parsed.tenantConfig;
}

async function configureTenantStorage(apiBaseUrl, token, timeoutMs) {
  const storage = configuredStorageFromEnv();
  const response = await apiRequest(apiBaseUrl, token, timeoutMs, "PATCH", routeTenantConfig, {
    features: { byo_storage: true },
    byo: { storage },
    reason: "live smoke: configure BYO storage target",
  });
  const parsed = await readJsonResponse(response, "configure tenant BYO storage");
  const nextStorage = storageConfigFromTenantConfig(parsed.tenantConfig);
  if (nextStorage?.kind !== "byo") {
    throw new Error("tenant config response did not confirm BYO storage configuration");
  }
  return nextStorage;
}

function configuredStorageFromEnv() {
  const provider = requiredEnv("HELIX_BYO_STORAGE_SMOKE_PROVIDER");
  if (!["aws-s3", "r2", "s3-compatible"].includes(provider)) {
    throw new Error("HELIX_BYO_STORAGE_SMOKE_PROVIDER must be aws-s3, r2, or s3-compatible");
  }
  const endpoint = optionalEnv("HELIX_BYO_STORAGE_SMOKE_ENDPOINT");
  if (provider !== "aws-s3" && endpoint === undefined) {
    throw new Error("HELIX_BYO_STORAGE_SMOKE_ENDPOINT is required for r2 and s3-compatible");
  }
  const kmsKeyArn = optionalEnv("HELIX_BYO_STORAGE_SMOKE_SSE_KMS_KEY_ARN");
  return omitUndefined({
    kind: "byo",
    provider,
    endpoint,
    region: env("HELIX_BYO_STORAGE_SMOKE_REGION", "us-east-1"),
    bucket: requiredEnv("HELIX_BYO_STORAGE_SMOKE_BUCKET"),
    prefix: optionalEnv("HELIX_BYO_STORAGE_SMOKE_PREFIX"),
    credentials_vault_path: requiredEnv("HELIX_BYO_STORAGE_SMOKE_CREDENTIALS_VAULT_PATH"),
    force_path_style: booleanEnv("HELIX_BYO_STORAGE_SMOKE_FORCE_PATH_STYLE", provider !== "aws-s3"),
    encryption: kmsKeyArn === undefined ? undefined : { sse_kms_key_arn: kmsKeyArn },
  });
}

async function rotateCredentials(apiBaseUrl, token, timeoutMs, input) {
  const response = await apiRequest(apiBaseUrl, token, timeoutMs, "POST", routeCredentials, {
    credentials: omitUndefined(input.credentials),
    reason: input.reason,
  });
  const parsed = await readJsonResponse(response, `${input.label} BYO storage credential rotation`);
  if (parsed.credentials?.rotated !== true) {
    throw new Error(`${input.label} credential rotation did not return rotated=true`);
  }
  assertHealthy(parsed.health, `${input.label} BYO storage credential rotation`);
  return {
    label: input.label,
    credentialsVaultPath: parsed.credentials.credentials_vault_path,
    health: healthSummary(parsed.health),
  };
}

async function testStorage(apiBaseUrl, token, timeoutMs) {
  const response = await apiRequest(apiBaseUrl, token, timeoutMs, "POST", routeStorageTest);
  const parsed = await readJsonResponse(response, "BYO storage test");
  return parsed.health;
}

async function restoreTenantConfig(apiBaseUrl, token, timeoutMs, initialConfig) {
  await apiRequest(apiBaseUrl, token, timeoutMs, "PATCH", routeTenantConfig, {
    features: initialConfig.features ?? {},
    byo: initialConfig.byo ?? {},
    reason: "live smoke: restore tenant storage config",
  });
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

function assertHealthy(health, label) {
  if (health?.status !== "healthy" || health.managedBy !== "byo") {
    throw new Error(`${label} did not return healthy BYO storage: ${safeStringify(health)}`);
  }
}

function healthSummary(health) {
  return {
    status: health.status,
    managedBy: health.managedBy ?? null,
    prefix: health.prefix ?? null,
    message: health.message ?? null,
    checkedAt: health.checked_at ?? null,
  };
}

function storageConfigFromTenantConfig(tenantConfig) {
  const storage = tenantConfig?.byo?.storage;
  return storage === undefined || storage === null || typeof storage !== "object" ? null : storage;
}

function redactedStorageSummary(storage) {
  if (storage === null || storage === undefined) {
    return null;
  }
  return {
    kind: storage.kind ?? null,
    provider: storage.provider ?? null,
    endpoint: storage.endpoint ?? null,
    region: storage.region ?? null,
    bucket: storage.bucket ?? null,
    prefix: storage.prefix ?? null,
    credentialsVaultPath: storage.credentials_vault_path ?? null,
  };
}

async function writeEvidence(evidence) {
  const outputPath = optionalEnv("HELIX_BYO_STORAGE_SMOKE_OUTPUT");
  if (outputPath !== undefined) {
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
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

function booleanEnv(name, fallback) {
  const raw = optionalEnv(name);
  if (raw === undefined) {
    return fallback;
  }
  if (/^(1|true|yes)$/iu.test(raw)) {
    return true;
  }
  if (/^(0|false|no)$/iu.test(raw)) {
    return false;
  }
  throw new Error(`${name} must be true or false`);
}

function omitUndefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function safeStringify(value) {
  return JSON.stringify(value, (key, nestedValue) =>
    key.toLowerCase().includes("secret") || key.toLowerCase().includes("token")
      ? "[redacted]"
      : nestedValue,
  );
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isMain() {
  return process.argv[1] === new URL(import.meta.url).pathname;
}

export function createMockByoStorageSmokeServer() {
  const requests = [];
  const storage = {
    kind: "byo",
    provider: "s3-compatible",
    endpoint: "https://storage.example.com",
    region: "us-east-1",
    bucket: "helix-smoke",
    prefix: "helix/",
    credentials_vault_path: "tenants/acme/byo-storage/s3",
  };
  const server = createServer(async (requestMessage, response) => {
    const chunks = [];
    for await (const chunk of requestMessage) {
      chunks.push(chunk);
    }
    const bodyText = Buffer.concat(chunks).toString("utf8");
    const body = bodyText.length === 0 ? null : JSON.parse(bodyText);
    requests.push({ method: requestMessage.method, url: requestMessage.url, body });
    response.setHeader("content-type", "application/json");
    if (requestMessage.url === routeTenantConfig && requestMessage.method === "GET") {
      response.end(JSON.stringify({ tenantConfig: tenantConfigPayload(storage) }));
      return;
    }
    if (requestMessage.url === routeTenantConfig && requestMessage.method === "PATCH") {
      Object.assign(storage, body?.byo?.storage ?? storage);
      response.end(JSON.stringify({ tenantConfig: tenantConfigPayload(storage) }));
      return;
    }
    if (requestMessage.url === routeCredentials && requestMessage.method === "POST") {
      response.end(
        JSON.stringify({
          credentials: {
            credentials_vault_path: storage.credentials_vault_path,
            rotated: true,
          },
          health: healthyStorage(storage),
        }),
      );
      return;
    }
    if (requestMessage.url === routeStorageTest && requestMessage.method === "POST") {
      response.end(JSON.stringify({ health: healthyStorage(storage) }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  return { server, requests };
}

function tenantConfigPayload(storage) {
  return {
    orgId: "org-smoke",
    byo: { storage },
    features: { byo_storage: true },
    quotas: {},
    branding: {},
    plan: null,
    effective: {
      byo: { storage },
      features: { byo_storage: true },
      quotas: {},
      branding: {},
    },
  };
}

function healthyStorage(storage) {
  return {
    status: "healthy",
    checked_at: "2026-05-26T06:00:00.000Z",
    message: "Tenant object storage write/read/delete probe succeeded.",
    managedBy: "byo",
    prefix: storage.prefix,
  };
}
