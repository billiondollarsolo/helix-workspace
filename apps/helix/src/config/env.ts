import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { aiEnv } from "./env-schema/ai.js";
import { authEnv } from "./env-schema/auth.js";
import { communicationEnv } from "./env-schema/communication.js";
import { mailEnv } from "./env-schema/mail.js";
import { observabilityEnv } from "./env-schema/observability.js";
import { runtimeEnv } from "./env-schema/runtime.js";
import { storageEnv } from "./env-schema/storage.js";
import {
  assertProductionConfiguration,
  assertProductionDeploymentConfiguration,
} from "./production-assertions.js";
/**
 * Operational environment schema. All production app code must read config via
 * {@link loadEnv} / {@link env} rather than raw `process.env`.
 *
 * Required keys: DATABASE_URL (with a local-dev default applied only when
 * NODE_ENV is not production). REDIS_URL is optional — many unit tests boot
 * without Redis.
 */
export const envSchema = z.object({
  ...runtimeEnv,
  ...authEnv,
  ...aiEnv,
  ...storageEnv,
  ...observabilityEnv,
  ...mailEnv,
  ...communicationEnv,
});
export type Env = z.infer<typeof envSchema>;
const productionPlaceholderMarkers = [
  "change-me",
  "change_me",
  "changeme",
  "placeholder",
  "_dev_secret",
  "helix_dev_",
  "helix_local_",
  "helix-local-dev",
] as const;
const credentialEnvironmentKey =
  /(?:DATABASE_URL|PASSWORD|PASS|SECRET|SECRET_KEY|TOKEN|API_KEY|MASTER_KEY|CLIENT_SECRET)$/u;
function productionPlaceholderIssues(
  source: Record<string, string | undefined>,
  parsed: Env,
): string[] {
  const candidates = Object.entries(source).filter(
    (entry): entry is [string, string] =>
      entry[1] !== undefined && credentialEnvironmentKey.test(entry[0]),
  );
  // Storage credentials have development defaults for the local Compose stack.
  // A production storage endpoint must never inherit that default silently.
  if (parsed.RUSTFS_ENDPOINT !== undefined && source.RUSTFS_SECRET_KEY === undefined) {
    candidates.push(["RUSTFS_SECRET_KEY", parsed.RUSTFS_SECRET_KEY]);
  }
  return candidates.flatMap(([key, value]) => {
    const normalized = value.toLowerCase();
    return productionPlaceholderMarkers.some((marker) => normalized.includes(marker))
      ? [`  - ${key}: development or placeholder credential is forbidden in production`]
      : [];
  });
}
const FILE_BACKED_ENV = {
  DATABASE_URL_FILE: "DATABASE_URL",
  REDIS_URL_FILE: "REDIS_URL",
  NATS_PASSWORD_FILE: "NATS_PASSWORD",
  NATS_TOKEN_FILE: "NATS_TOKEN",
  BETTER_AUTH_SECRET_FILE: "BETTER_AUTH_SECRET",
  HELIX_MFA_ASSERTION_SECRET_FILE: "HELIX_MFA_ASSERTION_SECRET",
  RUSTFS_ACCESS_KEY_FILE: "RUSTFS_ACCESS_KEY",
  RUSTFS_SECRET_KEY_FILE: "RUSTFS_SECRET_KEY",
  MEILI_MASTER_KEY_FILE: "MEILI_MASTER_KEY",
  MEILI_API_KEY_FILE: "MEILI_API_KEY",
  MEILISEARCH_API_KEY_FILE: "MEILISEARCH_API_KEY",
  MAIL_SMTP_PASS_FILE: "MAIL_SMTP_PASS",
  MAILGUN_API_KEY_FILE: "MAILGUN_API_KEY",
  POSTMARK_SERVER_TOKEN_FILE: "POSTMARK_SERVER_TOKEN",
  SES_SMTP_PASS_FILE: "SES_SMTP_PASS",
  MAIL_SMTP_RECEIVER_TLS_KEY_FILE: "MAIL_SMTP_RECEIVER_TLS_KEY",
  MAIL_SMTP_RECEIVER_TLS_CERT_FILE: "MAIL_SMTP_RECEIVER_TLS_CERT",
  MAIL_SMTP_RECEIVER_TLS_CA_FILE: "MAIL_SMTP_RECEIVER_TLS_CA",
  MAIL_PROVIDER_WEBHOOK_SECRET_FILE: "MAIL_PROVIDER_WEBHOOK_SECRET",
  HELIX_DATA_ENCRYPTION_KEY_FILE: "HELIX_DATA_ENCRYPTION_KEY",
  MEET_JITSI_JWT_SECRET_FILE: "MEET_JITSI_JWT_SECRET",
  MEET_JITSI_WEBHOOK_SHARED_SECRET_FILE: "MEET_JITSI_WEBHOOK_SHARED_SECRET",
  JITSI_JWT_SECRET_FILE: "JITSI_JWT_SECRET",
  JITSI_WEBHOOK_SECRET_FILE: "JITSI_WEBHOOK_SECRET",
} as const;
const MAX_SECRET_FILE_BYTES = 64 * 1024;
/**
 * Resolve the small, explicit allowlist of `*_FILE` inputs used by Docker
 * secrets and secret-manager CSI mounts.
 *
 * Arbitrary environment keys are intentionally not file-resolved. A direct
 * value and its file-backed equivalent are mutually exclusive so a stale
 * inline secret cannot silently win. Errors name only the environment
 * variable; file paths and secret contents are never included.
 */
function resolveFileBackedEnvironment(
  source: Record<string, string | undefined>,
  fileBackedEnv: Readonly<Record<string, string>> = FILE_BACKED_ENV,
): Record<string, string | undefined> {
  const resolved = { ...source };
  for (const [fileKey, valueKey] of Object.entries(fileBackedEnv)) {
    const filePath = source[fileKey]?.trim();
    const directValue = source[valueKey];
    if (filePath === undefined || filePath.length === 0) {
      continue;
    }
    if (directValue !== undefined && directValue.trim().length > 0) {
      throw new Error(
        `Invalid environment configuration:\n  - ${valueKey}: set either ${valueKey} or ${fileKey}, not both`,
      );
    }
    if (!filePath.startsWith("/") || filePath.includes("\0")) {
      throw new Error(
        `Invalid environment configuration:\n  - ${fileKey}: must reference an absolute file path`,
      );
    }
    try {
      const stat = statSync(filePath);
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SECRET_FILE_BYTES) {
        throw new Error("invalid secret file");
      }
      const value = readFileSync(filePath, "utf8").replace(/(?:\r?\n)+$/u, "");
      if (value.length === 0) {
        throw new Error("empty secret file");
      }
      resolved[valueKey] = value;
    } catch {
      throw new Error(
        `Invalid environment configuration:\n  - ${fileKey}: cannot read a non-empty regular secret file of at most ${String(MAX_SECRET_FILE_BYTES)} bytes`,
      );
    }
  }
  return resolved;
}
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const resolvedSource = resolveFileBackedEnvironment(source);
  // In production, require DATABASE_URL explicitly (no silent localhost default).
  const nodeEnv = resolvedSource.NODE_ENV ?? "development";
  if (
    nodeEnv === "production" &&
    (resolvedSource.DATABASE_URL === undefined || resolvedSource.DATABASE_URL.trim() === "")
  ) {
    throw new Error("Invalid environment configuration:\n  - DATABASE_URL: Required in production");
  }
  const result = envSchema.safeParse(resolvedSource);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  if (nodeEnv === "production") {
    const issues = productionPlaceholderIssues(resolvedSource, result.data);
    if (issues.length > 0) {
      throw new Error(`Invalid environment configuration:\n${issues.join("\n")}`);
    }
  }
  return Object.freeze(result.data);
}
const migrationEnvSchema = envSchema.pick({
  HELIX_REGION: true,
  NODE_ENV: true,
  DATABASE_URL: true,
  HELIX_MIGRATION_DATABASE_URL: true,
  MIGRATION_DATABASE_URL: true,
  POSTGRES_TLS_CA_FILE: true,
  POSTGRES_TLS_CERT_FILE: true,
  POSTGRES_TLS_KEY_FILE: true,
  POSTGRES_POOL_MAX: true,
  HELIX_WORKSPACE_PROFILE: true,
  HELIX_IMAGE: true,
  HELIX_WEB_IMAGE: true,
  HELIX_POSTGRES_IMAGE: true,
  HELIX_NATS_IMAGE: true,
  HELIX_MEILISEARCH_IMAGE: true,
  HELIX_CERBOS_IMAGE: true,
  HELIX_SPAMD_IMAGE: true,
});
export type MigrationEnv = z.infer<typeof migrationEnvSchema>;
const MIGRATION_FILE_BACKED_ENV = {
  DATABASE_URL_FILE: "DATABASE_URL",
} as const;
/**
 * Parse only the settings consumed by the one-shot migration process.
 *
 * A production migrator deliberately does not receive application-provider
 * credentials. Keeping this schema separate prevents application-only
 * assertions and malformed unrelated settings from blocking migrations while
 * retaining the same validated field types and defaults as {@link loadEnv}.
 */
export function loadMigrationEnv(
  source: Record<string, string | undefined> = process.env,
): MigrationEnv {
  const resolvedSource = resolveFileBackedEnvironment(source, MIGRATION_FILE_BACKED_ENV);
  const nodeEnv = resolvedSource.NODE_ENV ?? "development";
  const configuredDatabaseUrl =
    optionalEnvironmentValue(resolvedSource.HELIX_MIGRATION_DATABASE_URL) ??
    optionalEnvironmentValue(resolvedSource.MIGRATION_DATABASE_URL) ??
    optionalEnvironmentValue(resolvedSource.DATABASE_URL);
  if (nodeEnv === "production" && configuredDatabaseUrl === undefined) {
    throw new Error(
      "Invalid migration environment configuration:\n  - DATABASE_URL: Required in production",
    );
  }
  const result = migrationEnvSchema.safeParse(resolvedSource);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid migration environment configuration:\n${details}`);
  }
  assertProductionDeploymentConfiguration(result.data);
  return Object.freeze(result.data);
}
function optionalEnvironmentValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
let cached: Env | undefined;
/** Memoized validated env for app code. Prefer injecting `loadEnv` in tests. */
export function env(): Env {
  if (cached !== undefined) {
    return cached;
  }
  const loaded = loadEnv();
  assertProductionConfiguration(loaded);
  cached = loaded;
  return cached;
}
/** Test helper — clears the memoized env so subsequent `env()` re-parses. */
export function resetEnvCacheForTests(): void {
  cached = undefined;
}
const operationalControlEnvSchema = envSchema.pick({
  HELIX_AGENT_WRITES_ENABLED: true,
  HELIX_AGENT_WRITES_DISABLED_ORGS: true,
  HELIX_DISABLED_TOOLS: true,
  HELIX_GLOBAL_READ_ONLY: true,
});
export type OperationalControlEnv = z.infer<typeof operationalControlEnvSchema>;
/**
 * Read emergency controls without the normal environment cache.
 *
 * Operators may change these kill switches while a process is running, so the
 * invocation boundary must observe the current values rather than the startup
 * snapshot returned by {@link env}.
 */
export function operationalControlEnv(
  source: Record<string, string | undefined> = process.env,
): OperationalControlEnv {
  return operationalControlEnvSchema.parse(source);
}

const seedEnvSchema = envSchema
  .pick({
    HELIX_LOCAL_DEMO_PASSWORD: true,
    BETTER_AUTH_DATABASE_URL: true,
    DATABASE_URL: true,
    BETTER_AUTH_URL: true,
    HELIX_PUBLIC_URL: true,
    PUBLIC_BASE_URL: true,
    BETTER_AUTH_SECRET: true,
    BETTER_AUTH_TRUSTED_ORIGINS: true,
    RUSTFS_ENDPOINT: true,
    RUSTFS_REGION: true,
    RUSTFS_BUCKET: true,
    RUSTFS_ACCESS_KEY: true,
    RUSTFS_SECRET_KEY: true,
    HELIX_SMOKE_AGENT_ORG_ID: true,
    HELIX_SMOKE_AGENT_ACTOR_ID: true,
    HELIX_SMOKE_AGENT_EMAIL: true,
    HELIX_SMOKE_AGENT_DISPLAY_NAME: true,
    HELIX_SMOKE_AGENT_CLIENT_ID: true,
    HELIX_SMOKE_AGENT_CLIENT_SECRET: true,
    HELIX_API_BASE_URL: true,
    HELIX_SMOKE_AGENT_ACTOR_TYPE: true,
    HELIX_SMOKE_AGENT_SCOPES: true,
    HELIX_DEFAULT_ORG_ID: true,
    HELIX_SEED_CLIENT_SECRET: true,
    HELIX_LOCAL_DEMO_ANCHOR_DATE: true,
    HELIX_LOCAL_DEMO_VOLUME_SEARCH: true,
  })
  .partial()
  .extend({});

/** Validated seed inputs without application defaults or production startup side effects. */
export function loadSeedEnv(source: Record<string, string | undefined> = process.env) {
  return seedEnvSchema.parse(source);
}
