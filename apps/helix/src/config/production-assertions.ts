import type { Env } from "./env.js";

const MIN_SECRET_LENGTH = 32;
const MIN_SECRET_DISTINCT_CHARACTERS = 12;

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const BUSINESS_TIERS = new Set(["business", "enterprise", "sovereign"]);
const SECURITY_TIERS = new Set(["personal", ...BUSINESS_TIERS]);
const MANAGED_MAIL_PROVIDERS = new Set([
  "ses",
  "postmark",
  "mailgun",
  "managed-smtp",
  "smtp-relay",
]);
const DISALLOWED_MAIL_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "localhost",
  "mailpit",
  "mailhog",
  "smtp4dev",
]);

const KNOWN_DEVELOPMENT_VALUES: Readonly<Record<string, readonly string[]>> = {
  BETTER_AUTH_SECRET: [
    "helix_local_better_auth_secret_change_me_32_chars",
    "helix_jitsi_dev_secret",
  ],
  RUSTFS_ACCESS_KEY: ["helixrustfs"],
  RUSTFS_SECRET_KEY: ["helix_rustfs_dev_secret"],
  AUDIT_IMMUTABLE_S3_ACCESS_KEY: ["helixrustfs"],
  AUDIT_IMMUTABLE_S3_SECRET_KEY: ["helix_rustfs_dev_secret"],
  MEILI_MASTER_KEY: ["helix_dev_meili_master_key"],
  MEILI_API_KEY: ["helix_dev_meili_master_key"],
  MEILISEARCH_API_KEY: ["helix_dev_meili_master_key"],
  MAIL_SMTP_PASS: ["password", "changeme", "helix_dev_mail_password"],
  SES_SMTP_PASS: ["password", "changeme", "helix_dev_mail_password"],
  MAIL_PROVIDER_WEBHOOK_SECRET: ["changeme", "helix_dev_mail_webhook_secret_change_me"],
  MEET_JITSI_JWT_SECRET: ["helix_dev_jitsi_jwt_secret_change_me", "helix_jitsi_dev_secret"],
  JITSI_JWT_SECRET: ["helix_dev_jitsi_jwt_secret_change_me", "helix_jitsi_dev_secret"],
  MEET_JITSI_WEBHOOK_SHARED_SECRET: ["helix_dev_jitsi_webhook_secret_change_me"],
  JITSI_WEBHOOK_SECRET: ["helix_dev_jitsi_webhook_secret_change_me"],
  HELIX_DATA_ENCRYPTION_KEY: ["changeme", "helix_dev_encryption_key_change_me"],
  HELIX_LOCAL_DEMO_PASSWORD: ["helix-local-dev-password"],
};

export interface ProductionConfigurationIssue {
  readonly variable: string;
  readonly message: string;
}

export class ProductionConfigurationError extends Error {
  readonly issues: readonly ProductionConfigurationIssue[];

  constructor(issues: readonly ProductionConfigurationIssue[]) {
    super(
      [
        "Production configuration is unsafe:",
        ...issues.map((issue) => `  - ${issue.variable}: ${issue.message}`),
      ].join("\n"),
    );
    this.name = "ProductionConfigurationError";
    this.issues = issues;
  }
}

function normalized(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result === undefined || result.length === 0 ? undefined : result;
}

function flag(value: string | undefined): boolean | undefined {
  const valueNormalized = normalized(value)?.toLowerCase();
  if (valueNormalized === undefined) return undefined;
  if (TRUE_VALUES.has(valueNormalized)) return true;
  if (FALSE_VALUES.has(valueNormalized)) return false;
  return undefined;
}

function secretIsWeak(value: string): boolean {
  return (
    value.length < MIN_SECRET_LENGTH ||
    new Set(value).size < MIN_SECRET_DISTINCT_CHARACTERS ||
    /^(.)\1+$/u.test(value)
  );
}

function isKnownDevelopmentValue(variable: string, value: string): boolean {
  const normalizedValue = value.trim().toLowerCase();
  if (
    KNOWN_DEVELOPMENT_VALUES[variable]?.some(
      (candidate) => candidate.toLowerCase() === normalizedValue,
    )
  ) {
    return true;
  }
  return (
    normalizedValue.includes("change_me") ||
    normalizedValue.includes("changeme") ||
    normalizedValue.includes("helix_dev_") ||
    normalizedValue.includes("helix_local_")
  );
}

function hostnameFromMailHost(value: string): string {
  try {
    return new URL(`smtp://${value.trim()}`).hostname.toLowerCase().replace(/\.$/u, "");
  } catch {
    return value.trim().toLowerCase().replace(/\.$/u, "");
  }
}

function databasePassword(databaseUrl: string): string | undefined {
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      return undefined;
    }
    return decodeURIComponent(parsed.password);
  } catch {
    return undefined;
  }
}

function configuredSecurityTier(environment: Env, issues: ProductionConfigurationIssue[]): string {
  const explicit = normalized(environment.HELIX_SECURITY_TIER)?.toLowerCase();
  if (explicit !== undefined) {
    if (!SECURITY_TIERS.has(explicit)) {
      issues.push({
        variable: "HELIX_SECURITY_TIER",
        message: "must be personal, business, enterprise, or sovereign",
      });
    }
    return explicit;
  }

  const rawConfig = normalized(environment.HELIX_CONFIG_JSON);
  if (rawConfig === undefined) {
    return "personal";
  }
  try {
    const parsed = JSON.parse(rawConfig) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeError("not an object");
    }
    const security = (parsed as { readonly security?: unknown }).security;
    if (security === undefined) {
      return "personal";
    }
    if (typeof security !== "object" || security === null || Array.isArray(security)) {
      throw new TypeError("invalid security config");
    }
    const tier = (security as { readonly tier?: unknown }).tier;
    if (tier === undefined) {
      return "personal";
    }
    if (typeof tier !== "string" || !SECURITY_TIERS.has(tier.toLowerCase())) {
      throw new TypeError("invalid security tier");
    }
    return tier.toLowerCase();
  } catch {
    issues.push({
      variable: "HELIX_CONFIG_JSON",
      message: "must contain valid configuration with a recognized security tier",
    });
    return "personal";
  }
}

function validatePublicUrl(
  variable: string,
  value: string | undefined,
  required: boolean,
  issues: ProductionConfigurationIssue[],
): URL | undefined {
  const configured = normalized(value);
  if (configured === undefined) {
    if (required) {
      issues.push({ variable, message: "is required and must use https:" });
    }
    return undefined;
  }

  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "https:") {
      issues.push({ variable, message: "must use https: in production" });
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      issues.push({ variable, message: "must not contain embedded credentials" });
    }
    return parsed;
  } catch {
    issues.push({ variable, message: "must be an absolute URL" });
    return undefined;
  }
}

function validateTrustedOrigins(
  raw: string | undefined,
  requiredOrigins: readonly URL[],
  issues: ProductionConfigurationIssue[],
): void {
  const configured = normalized(raw);
  if (configured === undefined) {
    issues.push({
      variable: "BETTER_AUTH_TRUSTED_ORIGINS",
      message: "is required as a comma-separated exact-origin allowlist",
    });
    return;
  }

  const origins = new Set<string>();
  for (const entry of configured.split(",").map((part) => part.trim())) {
    const lower = entry.toLowerCase();
    if (
      entry.length === 0 ||
      entry.includes("*") ||
      ["true", "reflect", "reflection", "origin:true", "origin: true"].includes(lower) ||
      entry.startsWith("/") ||
      entry.endsWith("/")
    ) {
      issues.push({
        variable: "BETTER_AUTH_TRUSTED_ORIGINS",
        message: "must contain only explicit origins; wildcard or reflected origins are forbidden",
      });
      continue;
    }

    try {
      const parsed = new URL(entry);
      if (
        parsed.protocol !== "https:" ||
        parsed.origin !== entry ||
        parsed.username.length > 0 ||
        parsed.password.length > 0
      ) {
        issues.push({
          variable: "BETTER_AUTH_TRUSTED_ORIGINS",
          message: "each entry must be an exact https origin with no path, query, or credentials",
        });
        continue;
      }
      origins.add(parsed.origin);
    } catch {
      issues.push({
        variable: "BETTER_AUTH_TRUSTED_ORIGINS",
        message: "each entry must be a valid absolute origin",
      });
    }
  }

  for (const required of requiredOrigins) {
    if (!origins.has(required.origin)) {
      issues.push({
        variable: "BETTER_AUTH_TRUSTED_ORIGINS",
        message: "must include every configured public application/auth origin",
      });
      break;
    }
  }
}

function requireStrongSecret(
  variable: keyof Env,
  value: string | undefined,
  issues: ProductionConfigurationIssue[],
): void {
  const configured = normalized(value);
  if (configured === undefined) {
    issues.push({
      variable,
      message: `is required and must contain at least ${MIN_SECRET_LENGTH.toString()} characters`,
    });
    return;
  }
  if (isKnownDevelopmentValue(variable, configured)) {
    issues.push({ variable, message: "uses a known development/default value" });
    return;
  }
  if (secretIsWeak(configured)) {
    issues.push({
      variable,
      message: `must contain at least ${MIN_SECRET_LENGTH.toString()} characters with at least ${MIN_SECRET_DISTINCT_CHARACTERS.toString()} distinct characters`,
    });
  }
}

/**
 * Fail closed before production startup performs migrations, starts workers,
 * or opens a network listener. The function is pure and never includes a
 * configured value in its diagnostics.
 */
export function assertProductionConfiguration(environment: Env): void {
  if (environment.NODE_ENV !== "production") {
    return;
  }

  const issues: ProductionConfigurationIssue[] = [];
  const environmentRecord = environment as Readonly<Record<string, unknown>>;

  for (const [variable, candidates] of Object.entries(KNOWN_DEVELOPMENT_VALUES)) {
    const value = environmentRecord[variable];
    if (
      typeof value === "string" &&
      candidates.some((candidate) => candidate.toLowerCase() === value.trim().toLowerCase())
    ) {
      issues.push({ variable, message: "uses a known development/default value" });
    }
  }

  if (
    normalized(environment.HELIX_CONFIG_JSON)
      ?.toLowerCase()
      .match(/helix_(?:dev|local)_|change_?me/u)
  ) {
    issues.push({
      variable: "HELIX_CONFIG_JSON",
      message: "contains a known development/default credential marker",
    });
  }

  const dbPassword = databasePassword(environment.DATABASE_URL);
  if (dbPassword === undefined || dbPassword.length === 0) {
    issues.push({
      variable: "DATABASE_URL",
      message: "must be a postgres URL containing an authenticated database credential",
    });
  } else if (
    isKnownDevelopmentValue("DATABASE_URL", dbPassword) ||
    dbPassword === "helix_dev_password"
  ) {
    issues.push({ variable: "DATABASE_URL", message: "uses a known development/default password" });
  } else if (secretIsWeak(dbPassword)) {
    issues.push({
      variable: "DATABASE_URL",
      message: `database password must contain at least ${String(MIN_SECRET_LENGTH)} characters with at least ${String(MIN_SECRET_DISTINCT_CHARACTERS)} distinct characters`,
    });
  }

  requireStrongSecret("BETTER_AUTH_SECRET", environment.BETTER_AUTH_SECRET, issues);
  requireStrongSecret("RUSTFS_SECRET_KEY", environment.RUSTFS_SECRET_KEY, issues);
  if (flag(environment.AUDIT_IMMUTABLE_S3_ENABLED) === true) {
    requireStrongSecret(
      "AUDIT_IMMUTABLE_S3_SECRET_KEY",
      environment.AUDIT_IMMUTABLE_S3_SECRET_KEY,
      issues,
    );
  }

  const meiliSecret =
    environment.MEILI_MASTER_KEY ?? environment.MEILI_API_KEY ?? environment.MEILISEARCH_API_KEY;
  requireStrongSecret("MEILI_MASTER_KEY", meiliSecret, issues);

  if (environment.HELIX_DATA_ENCRYPTION_KEY !== undefined) {
    requireStrongSecret("HELIX_DATA_ENCRYPTION_KEY", environment.HELIX_DATA_ENCRYPTION_KEY, issues);
  }

  const publicUrls = [
    validatePublicUrl("HELIX_PUBLIC_URL", environment.HELIX_PUBLIC_URL, true, issues),
    validatePublicUrl("PUBLIC_BASE_URL", environment.PUBLIC_BASE_URL, false, issues),
    validatePublicUrl("HELIX_API_BASE_URL", environment.HELIX_API_BASE_URL, false, issues),
    validatePublicUrl("BETTER_AUTH_URL", environment.BETTER_AUTH_URL, true, issues),
    validatePublicUrl("MEET_JITSI_PUBLIC_URL", environment.MEET_JITSI_PUBLIC_URL, false, issues),
  ].filter((url): url is URL => url !== undefined);
  validateTrustedOrigins(environment.BETTER_AUTH_TRUSTED_ORIGINS, publicUrls, issues);

  const mailOutboundEnabled = flag(environment.MAIL_OUTBOUND_ENABLED) ?? true;
  if (mailOutboundEnabled) {
    const provider = normalized(environment.MAIL_PROVIDER)?.toLowerCase();
    if (provider === undefined || !MANAGED_MAIL_PROVIDERS.has(provider)) {
      issues.push({
        variable: "MAIL_PROVIDER",
        message:
          "must select ses, postmark, mailgun, managed-smtp, or smtp-relay; direct-to-MX is unsupported",
      });
    }
    const host = normalized(environment.MAIL_SMTP_HOST ?? environment.SES_SMTP_HOST);
    if (host === undefined) {
      issues.push({
        variable: "MAIL_SMTP_HOST",
        message: "is required when production outbound mail is enabled",
      });
    } else if (
      DISALLOWED_MAIL_HOSTS.has(hostnameFromMailHost(host)) ||
      host.toLowerCase().includes("mailpit")
    ) {
      issues.push({
        variable: "MAIL_SMTP_HOST",
        message: "must identify a managed provider relay; local test MTAs are forbidden",
      });
    }
    if (environment.MAIL_FROM_DOMAIN === "localhost") {
      issues.push({
        variable: "MAIL_FROM_DOMAIN",
        message: "must be an Internet mail domain when production outbound mail is enabled",
      });
    }
    requireStrongSecret(
      environment.MAIL_SMTP_PASS === undefined ? "SES_SMTP_PASS" : "MAIL_SMTP_PASS",
      environment.MAIL_SMTP_PASS ?? environment.SES_SMTP_PASS,
      issues,
    );
    if (flag(environment.MAIL_PROVIDER_WEBHOOK_ENABLED) !== true) {
      issues.push({
        variable: "MAIL_PROVIDER_WEBHOOK_ENABLED",
        message: "must be explicitly enabled for production provider events",
      });
    }
    requireStrongSecret(
      "MAIL_PROVIDER_WEBHOOK_SECRET",
      environment.MAIL_PROVIDER_WEBHOOK_SECRET,
      issues,
    );
  }

  if (flag(environment.MEET_JITSI_ENABLED) === true) {
    requireStrongSecret(
      environment.MEET_JITSI_JWT_SECRET === undefined
        ? "JITSI_JWT_SECRET"
        : "MEET_JITSI_JWT_SECRET",
      environment.MEET_JITSI_JWT_SECRET ?? environment.JITSI_JWT_SECRET,
      issues,
    );
    requireStrongSecret(
      environment.MEET_JITSI_WEBHOOK_SHARED_SECRET === undefined
        ? "JITSI_WEBHOOK_SECRET"
        : "MEET_JITSI_WEBHOOK_SHARED_SECRET",
      environment.MEET_JITSI_WEBHOOK_SHARED_SECRET ?? environment.JITSI_WEBHOOK_SECRET,
      issues,
    );
  }

  const securityTier = configuredSecurityTier(environment, issues);
  if (BUSINESS_TIERS.has(securityTier)) {
    for (const variable of [
      "HELIX_POSTGRES_ENCRYPTION_AT_REST_ATTESTED",
      "HELIX_OBJECT_STORAGE_ENCRYPTION_AT_REST_ATTESTED",
      "HELIX_BACKUP_ENCRYPTION_AT_REST_ATTESTED",
    ] as const) {
      if (flag(environment[variable]) !== true) {
        issues.push({
          variable,
          message: "must be explicitly attested true for the Business security tier or above",
        });
      }
    }
    if (
      environment.RUSTFS_SERVER_SIDE_ENCRYPTION !== "AES256" &&
      environment.RUSTFS_SERVER_SIDE_ENCRYPTION !== "aws:kms"
    ) {
      issues.push({
        variable: "RUSTFS_SERVER_SIDE_ENCRYPTION",
        message: "must be AES256 or aws:kms for Business storage",
      });
    }
    if (flag(environment.DRIVE_CLAMAV_ENABLED) !== true) {
      issues.push({
        variable: "DRIVE_CLAMAV_ENABLED",
        message: "must enable the real clamd-backed Drive scanner",
      });
    }
    if (normalized(environment.DRIVE_CLAMAV_HOST) === undefined) {
      issues.push({
        variable: "DRIVE_CLAMAV_HOST",
        message: "must identify the clamd service used for Drive scanning",
      });
    }
    if (flag(environment.MAIL_CLAMAV_ENABLED) !== true) {
      issues.push({
        variable: "MAIL_CLAMAV_ENABLED",
        message: "must enable the real clamd-backed Mail scanner",
      });
    }
    if (normalized(environment.MAIL_CLAMAV_HOST) === undefined) {
      issues.push({
        variable: "MAIL_CLAMAV_HOST",
        message: "must identify the clamd service used for Mail scanning",
      });
    }
  }

  if (issues.length > 0) {
    const deduplicated = issues.filter(
      (issue, index) =>
        issues.findIndex(
          (candidate) =>
            candidate.variable === issue.variable && candidate.message === issue.message,
        ) === index,
    );
    throw new ProductionConfigurationError(deduplicated);
  }
}
