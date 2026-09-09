/**
 * Multi-module MVP boundary smoke: packaging fail-closed + agent kill + domain
 * negative security modules remain exported and fail closed for illegal cases.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../../config/env.js";
import {
  assertProductionConfiguration,
  ProductionConfigurationError,
} from "../../config/production-assertions.js";
import {
  evaluateAgentOperationalControls,
  EMPTY_OPERATIONAL_CONTROL_SNAPSHOT,
  RuntimeAgentOperationalControlStore,
} from "../tools/agent-operational-controls.js";
import type { Actor, ToolDefinition } from "@helix/sdk-types";

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

describe("MVP surface integration smoke", () => {
  it("keeps production MVP packaging fail-closed by default", () => {
    expect(() => {
      assertProductionConfiguration(loadEnv(productionFixture()));
    }).not.toThrow();
    expect(() => {
      assertProductionConfiguration(
        loadEnv({
          ...productionFixture(),
          HELIX_APPS: "mail,drive,chat,assistant,meet",
        }),
      );
    }).toThrow(ProductionConfigurationError);
  });

  it("denies agent writes under emergency kill used by mail/drive/chat tools", async () => {
    const store = new RuntimeAgentOperationalControlStore();
    store.engageEmergencyKill();
    const agent: Actor = {
      id: "agent-1",
      orgId: "org-1",
      type: "agent",
      scopes: ["*"],
    };
    for (const toolId of ["mail.send", "drive.upload", "chat.send", "assistant.chat"] as const) {
      const decision = await store.evaluate({
        actor: agent,
        tool: { id: toolId, sideEffects: "write" } as ToolDefinition,
      });
      expect(decision.allowed, toolId).toBe(false);
    }
    // read path remains allowed
    expect(
      evaluateAgentOperationalControls({
        actor: agent,
        tool: { id: "mail.search", sideEffects: "read" },
        snapshot: store.getSnapshot(),
      }).allowed,
    ).toBe(true);
    expect(EMPTY_OPERATIONAL_CONTROL_SNAPSHOT.globalReadOnly).toBe(false);
  });
});
