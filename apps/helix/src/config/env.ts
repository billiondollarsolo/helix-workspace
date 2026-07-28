import { readFileSync, statSync } from "node:fs";
import { z } from "zod3";
import { assertProductionConfiguration } from "./production-assertions.js";

/**
 * Optional URL that accepts empty string as undefined (common for unset docker env).
 */
const optionalUrl = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v))
  .pipe(z.string().url().optional());

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v));

const coercePositiveInt = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const coerceNonNegInt = (fallback: number) =>
  z.coerce.number().int().nonnegative().default(fallback);

/**
 * Operational environment schema. All production app code must read config via
 * {@link loadEnv} / {@link env} rather than raw `process.env`.
 *
 * Required keys: DATABASE_URL (with a local-dev default applied only when
 * NODE_ENV is not production). REDIS_URL is optional — many unit tests boot
 * without Redis.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://helix:helix_dev_password@localhost:28432/helix"),
  HELIX_MIGRATION_DATABASE_URL: optionalString,
  MIGRATION_DATABASE_URL: optionalString,
  REDIS_URL: optionalUrl,
  PORT: coercePositiveInt(3000),
  HOST: z.string().default("0.0.0.0"),
  SHUTDOWN_TIMEOUT_MS: coerceNonNegInt(50_000),
  HELIX_MODE: z.enum(["single-tenant", "multi-tenant-saas"]).default("single-tenant"),
  HELIX_BODY_LIMIT_BYTES: coercePositiveInt(134_217_728),
  HELIX_ROLE: optionalString,
  HELIX_APPS: optionalString,
  LOG_LEVEL: z.string().default("info"),
  POSTGRES_POOL_MAX: coercePositiveInt(10),
  HELIX_POSTGRES_APP_ROLE: z.string().default("helix_app_role"),
  HELIX_DEFAULT_ORG_ID: z.string().default("00000000-0000-0000-0000-000000000000"),
  HELIX_PUBLIC_URL: optionalUrl,
  PUBLIC_BASE_URL: optionalUrl,
  HELIX_API_BASE_URL: optionalUrl,
  HELIX_APP_VERSION: optionalString,
  HELIX_SECURITY_TIER: optionalString,
  HELIX_CONFIG_JSON: optionalString,
  HELIX_PLUGINS_DIR: optionalString,
  HELIX_POSTGRES_ENCRYPTION_AT_REST_ATTESTED: optionalString,
  HELIX_OBJECT_STORAGE_ENCRYPTION_AT_REST_ATTESTED: optionalString,
  HELIX_BACKUP_ENCRYPTION_AT_REST_ATTESTED: optionalString,
  HELIX_DATA_ENCRYPTION_KEY: optionalString,

  // Storage (RustFS / S3-compatible)
  RUSTFS_ENDPOINT: optionalUrl,
  RUSTFS_API_PORT: optionalString,
  RUSTFS_ACCESS_KEY: z.string().default("helixrustfs"),
  RUSTFS_SECRET_KEY: z.string().default("helix_rustfs_dev_secret"),
  RUSTFS_BUCKET: z.string().default("helix-objects"),
  RUSTFS_REGION: z.string().default("us-east-1"),
  RUSTFS_SERVER_SIDE_ENCRYPTION: optionalString,
  AUDIT_IMMUTABLE_S3_ENABLED: optionalString,
  AUDIT_IMMUTABLE_S3_ACCESS_KEY: optionalString,
  AUDIT_IMMUTABLE_S3_SECRET_KEY: optionalString,

  // Drive preview / enrichment
  HELIX_DRIVE_OFFICE_PREVIEW_URL: optionalUrl,
  HELIX_DRIVE_OFFICE_PREVIEW_TIMEOUT_MS: coercePositiveInt(10_000),
  HELIX_DRIVE_LOCAL_OFFICE_PREVIEW: optionalString,
  /** When true, finalize stores content-addressed blobs with refcounts. Default off. */
  HELIX_DRIVE_CONTENT_DEDUP: optionalString,
  HELIX_DRIVE_MULTIPART_THRESHOLD_BYTES: coercePositiveInt(8 * 1024 * 1024),
  HELIX_DRIVE_MULTIPART_PART_SIZE_BYTES: coercePositiveInt(8 * 1024 * 1024),
  HELIX_DRIVE_OFFICE_PREVIEW_ALLOWED_HOSTS: optionalString,
  DRIVE_AUTO_TAG_ENRICHMENT: optionalString,
  DRIVE_CLAMAV_ENABLED: optionalString,
  DRIVE_CLAMAV_HOST: optionalString,
  DRIVE_CLAMAV_PORT: optionalString,
  DRIVE_CLAMAV_TIMEOUT_MS: optionalString,
  DRIVE_CLAMAV_MAX_BYTES: optionalString,
  DRIVE_CLAMAV_CHUNK_SIZE_BYTES: optionalString,
  DRIVE_CLAMAV_SCANNER_VERSION: optionalString,
  HELIX_CHROMIUM_PATH: optionalString,
  HELIX_DOCS_PDF_RENDERER: optionalString,
  HELIX_DOCS_PDF_RENDER_TIMEOUT_MS: coercePositiveInt(15_000),

  // Event bus / workers
  NATS_URL: optionalUrl,
  OUTBOX_BATCH_SIZE: coercePositiveInt(100),
  OUTBOX_POLL_INTERVAL_MS: coercePositiveInt(1000),
  SEARCH_EVENT_SUBJECT: z.string().default(">"),
  ENRICHMENT_EVENT_SUBJECT: z.string().default(">"),
  WEBHOOK_EVENT_SUBJECT: z.string().default(">"),
  WEBHOOK_RETRY_BATCH_SIZE: coercePositiveInt(100),
  WEBHOOK_RETRY_INTERVAL_MS: coercePositiveInt(1000),
  AUDIT_VERIFIER_INTERVAL_MS: coercePositiveInt(86_400_000),
  AUDIT_WORM_POSTGRES_ENABLED: optionalString,
  PENDING_ACTION_EXPIRY_INTERVAL_MS: coercePositiveInt(60_000),
  PENDING_ACTION_EXPIRY_BATCH_SIZE: coercePositiveInt(500),
  TENANT_PROVISIONING_BATCH_SIZE: coercePositiveInt(10),
  TENANT_PROVISIONING_INTERVAL_MS: coercePositiveInt(5000),
  TENANT_HARD_DELETE_RETENTION_DAYS: coercePositiveInt(30),
  TENANT_HARD_DELETE_BATCH_SIZE: coercePositiveInt(10),
  TENANT_HARD_DELETE_INTERVAL_MS: coercePositiveInt(86_400_000),
  HELIX_TENANT_STORAGE_MIGRATION_INTERVAL_MS: coercePositiveInt(15_000),
  HELIX_TENANT_STORAGE_MIGRATION_BATCH_SIZE: coercePositiveInt(2),
  HELIX_BYO_STORAGE_HEALTH_REFRESH_INTERVAL_MS: coercePositiveInt(3_600_000),
  HELIX_BYO_STORAGE_HEALTH_REFRESH_BATCH_SIZE: coercePositiveInt(100),
  HELIX_METERING_ROLLUP_INTERVAL_MS: optionalString,
  METERING_ROLLUP_INTERVAL_MS: optionalString,
  HELIX_METERING_ROLLUP_PERIOD_BATCH_SIZE: optionalString,
  METERING_ROLLUP_PERIOD_BATCH_SIZE: optionalString,
  // Default matches historical server.ts fallback (15s), not the 1s lower bound.
  LEADER_ELECTION_RETRY_INTERVAL_MS: coercePositiveInt(15_000),
  SEARCH_REINDEX_BATCH_SIZE: coercePositiveInt(100),

  // Auth / signup
  BETTER_AUTH_SECRET: optionalString,
  BETTER_AUTH_ENABLED: optionalString,
  BETTER_AUTH_URL: optionalUrl,
  BETTER_AUTH_DATABASE_URL: optionalUrl,
  BETTER_AUTH_TRUSTED_ORIGINS: optionalString,
  HELIX_SIGNUP_RATE_LIMIT_PER_HOUR: coercePositiveInt(5),
  HELIX_SIGNUP_BLOCKED_EMAIL_DOMAINS: optionalString,
  HELIX_SIGNUP_MANUAL_REVIEW_COUNTRIES: optionalString,
  HELIX_SIGNUP_RECAPTCHA_SECRET: optionalString,
  HELIX_SIGNUP_RECAPTCHA_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.5),
  HELIX_SIGNUP_RECAPTCHA_ACTION: z.string().default("signup"),
  HELIX_SIGNUP_HIBP_USER_AGENT: z.string().default("helix-signup-password-screening"),
  HELIX_SIGNUP_EMAIL_FROM: optionalString,
  HELIX_SIGNUP_EMAIL_FROM_NAME: z.string().default("Helix"),
  MAIL_FROM_DOMAIN: z.string().default("localhost"),
  CERBOS_HTTP_URL: optionalUrl,

  // Mail
  MAIL_PROVIDER: optionalString,
  MAIL_OUTBOUND_ENABLED: optionalString,
  MAIL_PROVIDER_WEBHOOK_ENABLED: optionalString,
  MAIL_PROVIDER_WEBHOOK_SECRET: optionalString,
  MAIL_SMTP_HOST: optionalString,
  MAIL_SMTP_PORT: optionalString,
  MAIL_SMTP_USER: optionalString,
  MAIL_SMTP_PASS: optionalString,
  MAIL_SMTP_SECURE: optionalString,
  SES_SMTP_HOST: optionalString,
  SES_SMTP_PORT: optionalString,
  SES_SMTP_USER: optionalString,
  SES_SMTP_PASS: optionalString,
  SES_SMTP_SECURE: optionalString,
  MAIL_RECEIVER_ENABLED: optionalString,
  MAIL_SMTP_RECEIVER_ENABLED: optionalString,
  MAIL_SMTP_RECEIVER_HOST: optionalString,
  MAIL_SMTP_RECEIVER_PORT: optionalString,
  MAIL_SPAMD_ENABLED: optionalString,
  MAIL_SPAMD_HOST: optionalString,
  MAIL_SPAMD_PORT: optionalString,
  MAIL_SPAMD_THRESHOLD: optionalString,
  MAIL_SPAMD_TIMEOUT_MS: optionalString,
  MAIL_CLAMAV_ENABLED: optionalString,
  MAIL_CLAMAV_HOST: optionalString,
  MAIL_CLAMAV_PORT: optionalString,
  MAIL_CLAMAV_TIMEOUT_MS: optionalString,

  // Chat
  CHAT_PRESENCE_TTL_SECONDS: coercePositiveInt(60),
  CHAT_WS_RATE_LIMIT_CAPACITY: coercePositiveInt(30),
  CHAT_WS_RATE_LIMIT_REFILL_PER_SECOND: coercePositiveInt(3),
  /** @deprecated prefer CAPACITY — kept for older deploys */
  CHAT_WS_RATE_LIMIT_PER_MINUTE: coercePositiveInt(120),
  /** @deprecated prefer CAPACITY — kept for older deploys */
  CHAT_WS_RATE_LIMIT_BURST: coercePositiveInt(30),

  // AI / search
  OPENAI_API_KEY: optionalString,
  OPENAI_BASE_URL: optionalUrl,
  OPENAI_MODEL: optionalString,
  OLLAMA_BASE_URL: optionalUrl,
  OLLAMA_MODEL: optionalString,
  AI_DEFAULT_PROVIDER_ID: optionalString,
  ASSISTANT_AI_PROVIDER_ID: optionalString,
  MEILI_HOST: optionalUrl,
  MEILI_URL: optionalUrl,
  MEILISEARCH_URL: optionalUrl,
  MEILI_MASTER_KEY: optionalString,
  MEILI_API_KEY: optionalString,
  MEILI_INDEX_UID: optionalString,
  MEILISEARCH_API_KEY: optionalString,
  MEILISEARCH_INDEX_UID: optionalString,

  // Meet / Jitsi
  MEET_JITSI_DOMAIN: optionalString,
  MEET_JITSI_ENABLED: optionalString,
  MEET_JITSI_PUBLIC_URL: optionalUrl,
  MEET_JITSI_JWT_SECRET: optionalString,
  MEET_JITSI_JWT_APP_ID: optionalString,
  MEET_JITSI_JWT_ISSUER: optionalString,
  MEET_JITSI_JWT_AUDIENCE: optionalString,
  MEET_JITSI_WEBHOOK_SHARED_SECRET: optionalString,
  JITSI_JWT_APP_ID: optionalString,
  JITSI_JWT_ISSUER: optionalString,
  JITSI_JWT_SECRET: optionalString,
  JITSI_WEBHOOK_SECRET: optionalString,

  // Telemetry
  OTEL_SDK_DISABLED: optionalString,

  // Editors
  HELIX_EDITORS_CORE_APP_ENTRY: optionalString,
  HELIX_EDITORS_CORE_APP_MODULE: optionalString,
  HELIX_EDITORS_MIGRATIONS_ENABLED: optionalString,

  // Admin / backup / demo / smoke
  HELIX_ADMIN_BACKUP_EXECUTE: optionalString,
  HELIX_BACKUP_DIR: optionalString,
  HELIX_BACKUP_SCRIPT: optionalString,
  HELIX_RESTORE_SCRIPT: optionalString,
  HELIX_SCIM_DOCS_URL: optionalUrl,
  HELIX_SEED_CLIENT_SECRET: optionalString,
  HELIX_LOCAL_DEMO_PASSWORD: optionalString,
  HELIX_LOCAL_DEMO_ANCHOR_DATE: optionalString,
  HELIX_LOCAL_DEMO_VOLUME_SEARCH: optionalString,
  HELIX_SMOKE_AGENT_ACTOR_ID: optionalString,
  HELIX_SMOKE_AGENT_ACTOR_TYPE: optionalString,
  HELIX_SMOKE_AGENT_CLIENT_ID: optionalString,
  HELIX_SMOKE_AGENT_CLIENT_SECRET: optionalString,
  HELIX_SMOKE_AGENT_DISPLAY_NAME: optionalString,
  HELIX_SMOKE_AGENT_EMAIL: optionalString,
  HELIX_SMOKE_AGENT_ORG_ID: optionalString,
  HELIX_SMOKE_AGENT_SCOPES: optionalString,
});

export type Env = z.infer<typeof envSchema>;

const FILE_BACKED_ENV = {
  DATABASE_URL_FILE: "DATABASE_URL",
  BETTER_AUTH_SECRET_FILE: "BETTER_AUTH_SECRET",
  RUSTFS_ACCESS_KEY_FILE: "RUSTFS_ACCESS_KEY",
  RUSTFS_SECRET_KEY_FILE: "RUSTFS_SECRET_KEY",
  MEILI_MASTER_KEY_FILE: "MEILI_MASTER_KEY",
  MEILI_API_KEY_FILE: "MEILI_API_KEY",
  MEILISEARCH_API_KEY_FILE: "MEILISEARCH_API_KEY",
  MAIL_SMTP_PASS_FILE: "MAIL_SMTP_PASS",
  SES_SMTP_PASS_FILE: "SES_SMTP_PASS",
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
): Record<string, string | undefined> {
  const resolved = { ...source };

  for (const [fileKey, valueKey] of Object.entries(FILE_BACKED_ENV)) {
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
  return Object.freeze(result.data);
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
