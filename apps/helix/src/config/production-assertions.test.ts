import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";
import {
  assertProductionConfiguration,
  ProductionConfigurationError,
} from "./production-assertions.js";

function secret(): string {
  return randomBytes(48).toString("base64url");
}

function productionFixture(): Record<string, string> {
  const databaseSecret = encodeURIComponent(secret());
  return {
    NODE_ENV: "production",
    DATABASE_URL: `postgres://helix:${databaseSecret}@postgres:5432/helix`,
    POSTGRES_TLS_CA_FILE: "/run/secrets/postgres_ca",
    REDIS_URL: `rediss://:${encodeURIComponent(secret())}@redis:6379`,
    REDIS_TLS_CA_FILE: "/run/secrets/redis_ca",
    NATS_URL: "tls://nats:4222",
    NATS_USER: "helix_app",
    NATS_PASSWORD: secret(),
    NATS_TLS_CA_FILE: "/run/secrets/nats_ca",
    NATS_TLS_CERT_FILE: "/run/secrets/nats_client_cert",
    NATS_TLS_KEY_FILE: "/run/secrets/nats_client_key",
    BETTER_AUTH_ENABLED: "true",
    BETTER_AUTH_SECRET: secret(),
    BETTER_AUTH_URL: "https://workspace.example.test",
    BETTER_AUTH_TRUSTED_ORIGINS: "https://workspace.example.test",
    HELIX_MFA_ASSERTION_SECRET: secret(),
    HELIX_MFA_ASSERTION_ISSUER: "https://auth.example.test",
    HELIX_MFA_ASSERTION_AUDIENCE: "helix-workspace",
    HELIX_PUBLIC_URL: "https://workspace.example.test",
    HELIX_SECURITY_TIER: "business",
    HELIX_POSTGRES_ENCRYPTION_AT_REST_ATTESTED: "true",
    HELIX_OBJECT_STORAGE_ENCRYPTION_AT_REST_ATTESTED: "true",
    HELIX_BACKUP_ENCRYPTION_AT_REST_ATTESTED: "true",
    RUSTFS_ACCESS_KEY: secret(),
    RUSTFS_SECRET_KEY: secret(),
    RUSTFS_SERVER_SIDE_ENCRYPTION: "AES256",
    MEILI_MASTER_KEY: secret(),
    MAIL_OUTBOUND_ENABLED: "true",
    MAIL_PROVIDER: "postmark",
    MAIL_FROM_DOMAIN: "example.test",
    MAIL_SMTP_HOST: "smtp.postmarkapp.com",
    MAIL_SMTP_PASS: secret(),
    MAIL_PROVIDER_WEBHOOK_ENABLED: "true",
    MAIL_PROVIDER_WEBHOOK_SECRET: secret(),
    MAIL_SPAMD_ENABLED: "true",
    MAIL_SPAMD_HOST: "spamd",
    MAIL_CLAMAV_ENABLED: "true",
    MAIL_CLAMAV_HOST: "clamav",
    DRIVE_CLAMAV_ENABLED: "true",
    DRIVE_CLAMAV_HOST: "clamav",
    DRIVE_CLAMAV_MAX_BYTES: "1073741824",
    HELIX_STARTUP_MIGRATION_CHECK: "true",
    HELIX_EDITORS_MIGRATIONS_ENABLED: "false",
    HELIX_IMAGE:
      "ghcr.io/billiondollarsolo/helix-workspace@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    HELIX_WEB_IMAGE:
      "ghcr.io/billiondollarsolo/helix-workspace-web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    HELIX_POSTGRES_IMAGE:
      "ghcr.io/billiondollarsolo/helix-workspace-postgres@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    HELIX_NATS_IMAGE:
      "ghcr.io/billiondollarsolo/helix-workspace-nats@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    HELIX_MEILISEARCH_IMAGE:
      "ghcr.io/billiondollarsolo/helix-workspace-meilisearch@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    HELIX_CERBOS_IMAGE:
      "ghcr.io/billiondollarsolo/helix-workspace-cerbos@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    HELIX_SPAMD_IMAGE:
      "ghcr.io/billiondollarsolo/helix-workspace-spamassassin@sha256:1111111111111111111111111111111111111111111111111111111111111111",
    HELIX_APPS: "mail,drive,chat,assistant",
    HELIX_CONFIG_JSON: JSON.stringify({
      modules: {
        docs: { enabled: false },
        calendar: { enabled: false },
        meet: { enabled: false },
        editors: { enabled: false },
      },
    }),
  };
}

function assertRejected(
  override: Record<string, string | undefined>,
  expectedVariable: string,
): void {
  const source = { ...productionFixture(), ...override };
  let caught: unknown;
  try {
    assertProductionConfiguration(loadEnv(source));
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProductionConfigurationError);
  expect((caught as ProductionConfigurationError).issues).toEqual(
    expect.arrayContaining([expect.objectContaining({ variable: expectedVariable })]),
  );
  for (const value of Object.values(override)) {
    if (value !== undefined && value.length >= 8) {
      expect((caught as Error).message).not.toContain(value);
    }
  }
}

describe("assertProductionConfiguration", () => {
  it("accepts a complete Business production configuration", () => {
    expect(() => {
      assertProductionConfiguration(loadEnv(productionFixture()));
    }).not.toThrow();
  });

  it("does not impose production controls in development or test", () => {
    expect(() => {
      assertProductionConfiguration(
        loadEnv({
          NODE_ENV: "development",
          DATABASE_URL: "postgres://helix:helix_dev_password@localhost:5432/helix",
        }),
      );
    }).not.toThrow();
  });

  it.each([
    undefined,
    "mail,drive,chat",
    "mail,drive,chat,assistant,editors",
    "assistant,chat,drive,mail",
    "mail, drive, chat, assistant",
  ])("requires the exact production MVP HELIX_APPS boundary (%s)", (apps) => {
    assertRejected({ HELIX_APPS: apps }, "HELIX_APPS");
  });

  it("requires editor migrations to remain disabled in every production process", () => {
    assertRejected(
      { HELIX_EDITORS_MIGRATIONS_ENABLED: undefined },
      "HELIX_EDITORS_MIGRATIONS_ENABLED",
    );
    assertRejected(
      { HELIX_EDITORS_MIGRATIONS_ENABLED: "true" },
      "HELIX_EDITORS_MIGRATIONS_ENABLED",
    );
  });

  it.each([
    ["HELIX_IMAGE", "ghcr.io/billiondollarsolo/helix-workspace:latest"],
    ["HELIX_WEB_IMAGE", "ghcr.io/billiondollarsolo/helix-workspace-web:latest"],
    [
      "HELIX_POSTGRES_IMAGE",
      "ghcr.io/billiondollarsolo/helix-workspace-postgres@sha256:not-a-digest",
    ],
    [
      "HELIX_NATS_IMAGE",
      "ghcr.io/attacker/helix-workspace-nats@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    ],
    ["HELIX_MEILISEARCH_IMAGE", undefined],
    ["HELIX_CERBOS_IMAGE", ""],
    [
      "HELIX_SPAMD_IMAGE",
      "ghcr.io/billiondollarsolo/helix-workspace-spamassassin@sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ],
  ])("requires an exact promoted digest via %s", (variable, value) => {
    assertRejected({ [variable]: value }, variable);
  });

  it.each(["docs", "calendar", "meet", "editors"] as const)(
    "requires modules.%s.enabled to be explicitly false",
    (moduleId) => {
      const fixture = productionFixture();
      const config = JSON.parse(fixture.HELIX_CONFIG_JSON ?? "{}") as {
        modules: Record<string, { enabled: boolean }>;
      };
      Reflect.deleteProperty(config.modules, moduleId);
      assertRejected({ HELIX_CONFIG_JSON: JSON.stringify(config) }, "HELIX_CONFIG_JSON");

      config.modules[moduleId] = { enabled: true };
      assertRejected({ HELIX_CONFIG_JSON: JSON.stringify(config) }, "HELIX_CONFIG_JSON");
    },
  );

  it.each([
    ["DATABASE_URL", "postgres://helix:helix_dev_password@postgres:5432/helix"],
    ["BETTER_AUTH_SECRET", "helix_local_better_auth_secret_change_me_32_chars"],
    ["HELIX_MFA_ASSERTION_SECRET", "helix_local_mfa_assertion_secret_change_me"],
    ["RUSTFS_ACCESS_KEY", "helixrustfs"],
    ["RUSTFS_SECRET_KEY", "helix_rustfs_dev_secret"],
    ["AUDIT_IMMUTABLE_S3_ACCESS_KEY", "helixrustfs"],
    ["AUDIT_IMMUTABLE_S3_SECRET_KEY", "helix_rustfs_dev_secret"],
    ["MEILI_MASTER_KEY", "helix_dev_meili_master_key"],
    ["MAIL_SMTP_PASS", "helix_dev_mail_password"],
    ["MAIL_PROVIDER_WEBHOOK_SECRET", "helix_dev_mail_webhook_secret_change_me"],
    ["MEET_JITSI_JWT_SECRET", "helix_dev_jitsi_jwt_secret_change_me"],
    ["JITSI_JWT_SECRET", "helix_jitsi_dev_secret"],
    ["MEET_JITSI_WEBHOOK_SHARED_SECRET", "helix_dev_jitsi_webhook_secret_change_me"],
    ["JITSI_WEBHOOK_SECRET", "helix_dev_jitsi_webhook_secret_change_me"],
    ["HELIX_DATA_ENCRYPTION_KEY", "helix_dev_encryption_key_change_me"],
    ["HELIX_LOCAL_DEMO_PASSWORD", "helix-local-dev-password"],
  ])("rejects the known development value for %s", (variable, value) => {
    assertRejected({ [variable]: value }, variable);
  });

  it("rejects development credentials embedded in HELIX_CONFIG_JSON", () => {
    assertRejected(
      {
        HELIX_CONFIG_JSON: '{"plugins":{"meet":{"secret":"helix_dev_jitsi_jwt_secret_change_me"}}}',
      },
      "HELIX_CONFIG_JSON",
    );
  });

  it("enforces Business controls when the effective tier comes from HELIX_CONFIG_JSON", () => {
    assertRejected(
      {
        HELIX_SECURITY_TIER: undefined,
        HELIX_CONFIG_JSON: '{"security":{"tier":"business"}}',
        DRIVE_CLAMAV_ENABLED: "false",
      },
      "DRIVE_CLAMAV_ENABLED",
    );
  });

  it("rejects invalid explicit and JSON security tiers", () => {
    assertRejected({ HELIX_SECURITY_TIER: "unknown" }, "HELIX_SECURITY_TIER");
    assertRejected(
      {
        HELIX_SECURITY_TIER: undefined,
        HELIX_CONFIG_JSON: '{"security":{"tier":"unknown"}}',
      },
      "HELIX_CONFIG_JSON",
    );
  });

  it.each([
    ["DATABASE_URL", "postgres://helix:short@postgres:5432/helix"],
    ["BETTER_AUTH_SECRET", "too-short"],
    ["HELIX_MFA_ASSERTION_SECRET", "too-short"],
    ["RUSTFS_SECRET_KEY", "too-short"],
    ["MEILI_MASTER_KEY", "too-short"],
    ["MAIL_SMTP_PASS", "too-short"],
    ["MAIL_PROVIDER_WEBHOOK_SECRET", "too-short"],
    ["HELIX_DATA_ENCRYPTION_KEY", "too-short"],
  ])("rejects a weak required secret for %s", (variable, value) => {
    assertRejected({ [variable]: value }, variable);
  });

  it.each([
    ["HELIX_MFA_ASSERTION_SECRET", undefined],
    ["HELIX_MFA_ASSERTION_ISSUER", undefined],
    ["HELIX_MFA_ASSERTION_AUDIENCE", undefined],
  ])("requires the signed Business MFA assertion setting %s", (variable, value) => {
    assertRejected({ [variable]: value }, variable);
  });

  it("rejects weak Jitsi secrets when Meet is enabled", () => {
    assertRejected(
      {
        MEET_JITSI_ENABLED: "true",
        MEET_JITSI_JWT_SECRET: "too-short",
        MEET_JITSI_WEBHOOK_SHARED_SECRET: secret(),
      },
      "MEET_JITSI_JWT_SECRET",
    );
  });

  it.each([
    ["HELIX_PUBLIC_URL", "http://workspace.example.test"],
    ["BETTER_AUTH_URL", "http://workspace.example.test"],
    ["PUBLIC_BASE_URL", "http://workspace.example.test"],
    ["HELIX_API_BASE_URL", "http://api.example.test"],
    ["MEET_JITSI_PUBLIC_URL", "http://meet.example.test"],
  ])("rejects a public HTTP URL in %s", (variable, value) => {
    assertRejected({ [variable]: value }, variable);
  });

  it.each(["*", "true", "reflection", "https://*.example.test", "/example/u"])(
    "rejects wildcard/reflected trusted origin %s",
    (value) => {
      assertRejected({ BETTER_AUTH_TRUSTED_ORIGINS: value }, "BETTER_AUTH_TRUSTED_ORIGINS");
    },
  );

  it("requires configured public origins in the exact allowlist", () => {
    assertRejected(
      {
        PUBLIC_BASE_URL: "https://files.example.test",
        BETTER_AUTH_TRUSTED_ORIGINS: "https://workspace.example.test",
      },
      "BETTER_AUTH_TRUSTED_ORIGINS",
    );
  });

  it.each(["direct-mx", "smtp", "mailpit"])(
    "rejects unsupported outbound provider %s",
    (provider) => {
      assertRejected({ MAIL_PROVIDER: provider }, "MAIL_PROVIDER");
    },
  );

  it.each(["mailpit", "mailpit:1025", "localhost", "localhost:2525", "127.0.0.1"])(
    "rejects local test outbound host %s",
    (host) => {
      assertRejected({ MAIL_SMTP_HOST: host }, "MAIL_SMTP_HOST");
    },
  );

  it("rejects localhost as the production sending domain", () => {
    assertRejected({ MAIL_FROM_DOMAIN: "localhost" }, "MAIL_FROM_DOMAIN");
  });

  it("rejects disabling the startup migration compatibility check", () => {
    assertRejected({ HELIX_STARTUP_MIGRATION_CHECK: "false" }, "HELIX_STARTUP_MIGRATION_CHECK");
  });

  it.each([
    ["POSTGRES_TLS_CA_FILE", undefined],
    ["REDIS_URL", "redis://redis:6379"],
    ["REDIS_URL", "rediss://redis:6379"],
    ["REDIS_TLS_CA_FILE", undefined],
    ["NATS_URL", "nats://nats:4222"],
    ["NATS_PASSWORD", undefined],
    ["NATS_TLS_CA_FILE", undefined],
    ["NATS_TLS_CERT_FILE", undefined],
    ["NATS_TLS_KEY_FILE", undefined],
  ])("rejects an insecure production data-plane setting in %s", (variable, value) => {
    assertRejected({ [variable]: value }, variable);
  });

  it("allows outbound Mail to be explicitly disabled", () => {
    const fixture = productionFixture();
    fixture.MAIL_OUTBOUND_ENABLED = "false";
    delete fixture.MAIL_PROVIDER;
    delete fixture.MAIL_SMTP_HOST;
    delete fixture.MAIL_SMTP_PASS;
    delete fixture.MAIL_PROVIDER_WEBHOOK_ENABLED;
    delete fixture.MAIL_PROVIDER_WEBHOOK_SECRET;
    expect(() => {
      assertProductionConfiguration(loadEnv(fixture));
    }).not.toThrow();
  });

  it.each([
    "HELIX_POSTGRES_ENCRYPTION_AT_REST_ATTESTED",
    "HELIX_OBJECT_STORAGE_ENCRYPTION_AT_REST_ATTESTED",
    "HELIX_BACKUP_ENCRYPTION_AT_REST_ATTESTED",
  ])("requires the Business attestation %s", (variable) => {
    assertRejected({ [variable]: "false" }, variable);
  });

  it("requires supported object storage SSE in Business", () => {
    assertRejected({ RUSTFS_SERVER_SIDE_ENCRYPTION: undefined }, "RUSTFS_SERVER_SIDE_ENCRYPTION");
  });

  it("requires a concrete default KMS key when Business storage selects aws:kms", () => {
    assertRejected(
      { RUSTFS_SERVER_SIDE_ENCRYPTION: "aws:kms", RUSTFS_SSE_KMS_KEY_ID: undefined },
      "RUSTFS_SSE_KMS_KEY_ID",
    );
  });

  it.each([
    ["DRIVE_CLAMAV_ENABLED", "false"],
    ["DRIVE_CLAMAV_HOST", undefined],
    ["MAIL_CLAMAV_ENABLED", "false"],
    ["MAIL_CLAMAV_HOST", undefined],
    ["MAIL_SPAMD_ENABLED", "false"],
    ["MAIL_SPAMD_HOST", undefined],
  ])("requires real Business malware scanning via %s", (variable, value) => {
    assertRejected({ [variable]: value }, variable);
  });

  it("reports variable names without echoing secret values", () => {
    const sensitive = "A".repeat(48);
    let caught: unknown;
    try {
      assertProductionConfiguration(
        loadEnv({
          ...productionFixture(),
          BETTER_AUTH_SECRET: sensitive,
          MAIL_SMTP_PASS: sensitive,
        }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProductionConfigurationError);
    expect((caught as Error).message).toContain("BETTER_AUTH_SECRET");
    expect((caught as Error).message).not.toContain(sensitive);
  });
});
