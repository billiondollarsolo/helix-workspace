import fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import type {
  Actor,
  EventBus,
  EventEnvelope,
  HelixConfig,
  JsonValue,
  Unsubscribe,
} from "@helix/sdk";
import {
  applyObservedPlatformReadiness,
  PlatformConfigAdminService,
  PlatformTierReadinessError,
  PostgresPlatformConfigStore,
  buildPlatformReadinessReport,
  canReadPlatformConfig,
  canWritePlatformConfig,
  mergeAiProvidersPreservingSecrets,
  operatorAiEnvFromConfig,
  platformConfigChangedSubject,
  platformConfigAdminScopes,
  platformConfigUpdateSchema,
  redactAiSecretsForAdmin,
  registerPlatformConfigAdminRoutes,
  resolveFeatureProviderCredentials,
  type PlatformConfigStatus,
} from "./admin.js";
import {
  EnvConfigSource,
  PostgresOverrideConfigSource,
  loadHelixConfig,
  subscribeToConfigHotReload,
} from "./loader.js";
import { resolveTierDefaults } from "./tier.js";

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

describe("platform config admin readiness", () => {
  it("reports missing enterprise requirements from typed readiness state", () => {
    const config: HelixConfig = {
      security: { tier: "enterprise" },
      platform: {
        readiness: {
          mfa: { enabled: true, scope: "admins" },
          encryptedBackups: { enabled: true, lastSuccessfulBackupAt: "2026-05-20T12:00:00Z" },
          auditDestinations: { destinations: ["immutable-s3"] },
          vault: { enabled: true },
          spire: { status: "ready" },
          siem: { enabled: false },
          cloudNativePg: { enabled: true },
        },
      },
    };

    const report = buildPlatformReadinessReport(config, resolveTierDefaults(config));

    expect(report.ready).toBe(false);
    expect(report.requirements.find((requirement) => requirement.key === "mfa")).toMatchObject({
      required: true,
      status: "missing",
      expected: { scope: "org" },
    });
    expect(
      report.requirements.find((requirement) => requirement.key === "auditDestinations"),
    ).toMatchObject({
      status: "missing",
      missing: ["siem"],
    });
    expect(report.requirements.find((requirement) => requirement.key === "siem")).toMatchObject({
      required: true,
      status: "missing",
    });
  });

  it("accepts typed tier and readiness updates", () => {
    const parsed = platformConfigUpdateSchema.parse({
      security: {
        tier: "business",
        overrides: {
          secrets: "vault",
          auditDestinations: ["postgres", "immutable-s3"],
        },
      },
      platform: {
        readiness: {
          mfa: { enabled: true, scope: "admins" },
          encryptedBackups: { enabled: true, lastSuccessfulBackupAt: "2026-05-20T12:00:00Z" },
          vault: { enabled: true, status: "ready", endpoint: "https://vault.internal" },
          fips: {
            enabled: true,
            status: "ready",
            mode: "required",
            cryptoAdapter: "node-openssl-fips",
            runtimeAttestation: true,
          },
          stigImagePolicy: {
            enabled: true,
            status: "ready",
            requireDigest: true,
            requireSignature: true,
            approvedBaseImages: ["ubi-minimal-fips"],
          },
          airgap: {
            enabled: true,
            status: "ready",
            bundleMirrored: true,
            internalRegistry: "registry.example.internal",
          },
          worm: {
            enabled: true,
            status: "ready",
            retentionLocked: true,
            destinations: ["worm"],
          },
          cacPiv: {
            enabled: true,
            status: "ready",
            scope: "org",
            pkcs11Provider: "opensc-pkcs11",
          },
          hsmBackups: {
            enabled: true,
            status: "ready",
            encrypted: true,
            keyProvider: "hsm",
            lastSuccessfulBackupAt: "2026-05-20T12:00:00Z",
          },
          defaultDenyEgress: {
            enabled: true,
            status: "ready",
            policy: "default-deny",
            enforced: true,
          },
        },
      },
    });

    expect(parsed.security?.tier).toBe("business");
    expect(parsed.platform?.readiness?.vault?.status).toBe("ready");
    expect(parsed.platform?.readiness?.fips?.mode).toBe("required");
    expect(parsed.platform?.readiness?.hsmBackups?.keyProvider).toBe("hsm");
  });

  it("requires sovereign Tier 4 controls before reporting ready", () => {
    const config: HelixConfig = {
      security: { tier: "sovereign" },
      platform: {
        readiness: {
          mfa: { enabled: true, scope: "org" },
          encryptedBackups: { enabled: true, lastSuccessfulBackupAt: "2026-05-20T12:00:00Z" },
          auditDestinations: { destinations: ["worm", "siem"] },
          vault: { enabled: true },
          spire: { enabled: true },
          siem: { enabled: true },
          cloudNativePg: { enabled: true },
          fips: { status: "ready", mode: "permissive", runtimeAttestation: true },
          stigImagePolicy: { status: "ready", requireDigest: true, requireSignature: false },
          airgap: { enabled: true, bundleMirrored: false },
          worm: { enabled: true, retentionLocked: true, destinations: ["postgres"] },
          cacPiv: { enabled: true, scope: "admins" },
          hsmBackups: { enabled: true, encrypted: true, keyProvider: "kms" },
          defaultDenyEgress: { status: "ready", policy: "default-deny", enforced: false },
        },
      },
    };

    const report = buildPlatformReadinessReport(config, resolveTierDefaults(config));

    expect(report.ready).toBe(false);
    expect(report.requirements.find((requirement) => requirement.key === "fips")).toMatchObject({
      required: true,
      status: "missing",
      missing: ["mode"],
    });
    expect(
      report.requirements.find((requirement) => requirement.key === "stigImagePolicy"),
    ).toMatchObject({
      required: true,
      status: "missing",
      missing: ["requireSignature"],
    });
    expect(report.requirements.find((requirement) => requirement.key === "airgap")).toMatchObject({
      required: true,
      status: "missing",
      missing: ["bundleMirrored"],
    });
    expect(report.requirements.find((requirement) => requirement.key === "worm")).toMatchObject({
      required: true,
      status: "missing",
      missing: ["destinations"],
    });
    expect(report.requirements.find((requirement) => requirement.key === "cacPiv")).toMatchObject({
      required: true,
      status: "missing",
      missing: ["scope"],
    });
    expect(
      report.requirements.find((requirement) => requirement.key === "hsmBackups"),
    ).toMatchObject({
      required: true,
      status: "missing",
      missing: ["keyProvider", "lastSuccessfulBackupAt"],
    });
    expect(
      report.requirements.find((requirement) => requirement.key === "defaultDenyEgress"),
    ).toMatchObject({
      required: true,
      status: "missing",
      missing: ["enforced"],
    });
  });

  it("reports sovereign Tier 4 controls ready with required evidence", () => {
    const config: HelixConfig = {
      security: { tier: "sovereign" },
      platform: {
        readiness: {
          mfa: { enabled: true, scope: "org" },
          encryptedBackups: { enabled: true, lastSuccessfulBackupAt: "2026-05-20T12:00:00Z" },
          auditDestinations: { destinations: ["worm", "siem"] },
          vault: { enabled: true },
          spire: { enabled: true },
          siem: { enabled: true },
          cloudNativePg: { enabled: true },
          fips: { status: "ready", mode: "required", runtimeAttestation: true },
          stigImagePolicy: { status: "ready", requireDigest: true, requireSignature: true },
          airgap: { enabled: true, bundleMirrored: true },
          worm: { enabled: true, retentionLocked: true, destinations: ["worm"] },
          cacPiv: { enabled: true, scope: "org" },
          hsmBackups: {
            enabled: true,
            encrypted: true,
            keyProvider: "hsm",
            lastSuccessfulBackupAt: "2026-05-20T12:00:00Z",
          },
          defaultDenyEgress: { status: "ready", policy: "default-deny", enforced: true },
        },
      },
    };

    const report = buildPlatformReadinessReport(config, resolveTierDefaults(config));

    expect(report.ready).toBe(true);
    expect(report.requirements.filter((requirement) => requirement.required)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "fips", status: "ready" }),
        expect.objectContaining({ key: "stigImagePolicy", status: "ready" }),
        expect.objectContaining({ key: "airgap", status: "ready" }),
        expect.objectContaining({ key: "worm", status: "ready" }),
        expect.objectContaining({ key: "cacPiv", status: "ready" }),
        expect.objectContaining({ key: "hsmBackups", status: "ready" }),
        expect.objectContaining({ key: "defaultDenyEgress", status: "ready" }),
      ]),
    );
  });

  it("projects Vault, SIEM, and CloudNativePG readiness from backend-observed env", async () => {
    const store = new PostgresPlatformConfigStore(new InMemoryPlatformConfigSql().sql);
    const service = new PlatformConfigAdminService(store, {
      HELIX_SECURITY_TIER: "enterprise",
      VAULT_ADDR: "https://vault.internal:8200",
      SIEM_ENDPOINT: "https://siem.internal/ingest",
      SIEM_FORMAT: "cef",
      DATABASE_URL: "postgres://helix:secret@helix-postgres-rw:5432/helix",
      HELIX_CONFIG_JSON: JSON.stringify({
        platform: {
          readiness: {
            mfa: { enabled: true, status: "ready", scope: "org" },
            encryptedBackups: {
              enabled: true,
              status: "ready",
              lastSuccessfulBackupAt: "2026-05-20T12:00:00Z",
            },
            auditDestinations: {
              enabled: true,
              status: "ready",
              destinations: ["immutable-s3", "siem"],
            },
            spire: { enabled: true, status: "ready" },
          },
        },
      }),
    });

    const status = await service.getStatus();
    const readinessRequirement = (
      key: PlatformConfigStatus["readiness"]["requirements"][number]["key"],
    ) => status.readiness.requirements.find((requirement) => requirement.key === key);

    expect(readinessRequirement("vault")).toMatchObject({ status: "ready" });
    expect(readinessRequirement("vault")?.observed).toMatchObject({
      enabled: true,
      endpoint: "https://vault.internal:8200",
      evidence: "Vault endpoint observed from runtime configuration.",
    });
    expect(readinessRequirement("siem")).toMatchObject({ status: "ready" });
    expect(readinessRequirement("siem")?.observed).toMatchObject({
      enabled: true,
      endpoint: "https://siem.internal/ingest",
      evidence: "SIEM endpoint observed from runtime configuration with CEF format.",
    });
    expect(readinessRequirement("cloudNativePg")).toMatchObject({ status: "ready" });
    expect(readinessRequirement("cloudNativePg")?.observed).toMatchObject({
      enabled: true,
      endpoint: "postgres://helix-postgres-rw:5432/helix",
      evidence: "CloudNativePG wiring observed from runtime configuration.",
    });
  });

  it("keeps explicit readiness state ahead of runtime endpoint projection", () => {
    const config = applyObservedPlatformReadiness(
      {
        security: { tier: "enterprise" },
        platform: {
          readiness: {
            vault: {
              enabled: true,
              status: "degraded",
              endpoint: "https://vault.healthcheck.internal",
              evidence: "Vault health probe is failing.",
            },
          },
        },
      },
      { VAULT_ADDR: "https://vault.env.internal:8200" },
    );

    expect(config.platform?.readiness).toMatchObject({
      vault: {
        enabled: true,
        status: "degraded",
        endpoint: "https://vault.healthcheck.internal",
        evidence: "Vault health probe is failing.",
      },
    });
  });
});

describe("platform config admin schema", () => {
  it("accepts typed module, AI routing, privacy, cost, and observability updates", () => {
    const parsed = platformConfigUpdateSchema.parse({
      modules: {
        mail: {
          enabled: false,
          plugin: "com.helix.core.mail@^1.0.0",
          config: { undoSendSeconds: 30 },
        },
        chat: { enabled: true },
      },
      ai: {
        enabled: true,
        defaultPosture: "admin-controlled",
        providers: [
          {
            id: "anthropic-prod",
            plugin: "com.helix.ai-provider-anthropic-compat@^1.0.0",
            config: {
              baseUrl: "https://api.anthropic.com",
              apiKey: "${ANTHROPIC_API_KEY}",
              models: ["claude-3-5-sonnet", "claude-3-5-haiku"],
            },
            tags: ["external"],
          },
        ],
        routing: {
          rules: [
            {
              feature: "assistant.chat",
              primary: { providerId: "anthropic-prod", model: "claude-3-5-sonnet" },
              fallback: { providerId: "ollama-local", model: "llama3.1:70b" },
              classifications: {
                restricted: { providerId: "ollama-local" },
              },
            },
          ],
        },
        costLimits: {
          perUserPerDayUSD: 5,
          perOrgPerDayUSD: 500,
          perAgentPerDayUSD: 10,
        },
        privacy: {
          redactPIIBeforeSend: true,
          classificationGating: true,
          blockExternalForClassifications: ["confidential", "restricted"],
        },
      },
      observability: {
        enabled: true,
        plugin: "com.helix.observability-otel@^1.0.0",
        config: {
          otlpEndpoint: "http://tempo:4317",
          metricsEndpoint: "http://prometheus:9090",
          logsEndpoint: "http://loki:3100",
          sampling: { traces: 0.1, llmCalls: 1, toolCalls: 1, permissionChecks: 0.05 },
        },
        bundledStack: {
          enabled: true,
          plugin: "com.helix.observability-grafana-stack@^1.0.0",
          grafanaUrl: "https://grafana.helix.example.com",
        },
      },
    });

    expect(parsed.modules?.mail?.enabled).toBe(false);
    expect(parsed.ai?.routing?.rules?.[0]?.classifications?.restricted?.providerId).toBe(
      "ollama-local",
    );
    expect(parsed.ai?.privacy?.blockExternalForClassifications).toEqual([
      "confidential",
      "restricted",
    ]);
    expect(parsed.observability?.config?.otlpEndpoint).toBe("http://tempo:4317");
  });
});

describe("platform config tier upgrade guards", () => {
  it("refuses upgrades until required target readiness gates pass", async () => {
    const recording = createRecordingSql([[]]);
    const service = new PlatformConfigAdminService(
      new PostgresPlatformConfigStore(recording.sql),
      {},
    );
    const actor = actorWithScopes([platformConfigAdminScopes.write]);

    let readinessError: unknown;
    try {
      await service.update({ security: { tier: "business" } }, actor);
    } catch (error) {
      readinessError = error;
    }
    expect(readinessError).toBeInstanceOf(PlatformTierReadinessError);
    const typedError = readinessError as PlatformTierReadinessError;
    expect(typedError.targetTier).toBe("business");
    expect(typedError.missingRequirements).toContain("mfa");
    expect(typedError.missingRequirements).toContain("encryptedBackups");
    expect(typedError.missingRequirements).toContain("auditDestinations");
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("select key, value");
  });

  it("allows an atomic readiness update and tier upgrade once gates are ready", async () => {
    const service = new PlatformConfigAdminService(
      new PostgresPlatformConfigStore(new InMemoryPlatformConfigSql().sql),
      {},
    );
    const actor = actorWithScopes([platformConfigAdminScopes.write]);

    const status = await service.update(
      {
        security: { tier: "business" },
        platform: {
          readiness: {
            mfa: { enabled: true, status: "ready", scope: "admins" },
            encryptedBackups: {
              enabled: true,
              status: "ready",
              lastSuccessfulBackupAt: "2026-05-20T12:00:00Z",
            },
            auditDestinations: {
              enabled: true,
              status: "ready",
              destinations: ["immutable-s3"],
            },
          },
        },
      },
      actor,
    );

    expect(status.config.security.tier).toBe("business");
    expect(status.readiness.ready).toBe(true);
  });

  it("returns a conflict response with missing gates for blocked REST tier upgrades", async () => {
    const app = fastify();
    const service = new PlatformConfigAdminService(
      new PostgresPlatformConfigStore(new InMemoryPlatformConfigSql().sql),
      {},
    );
    await registerPlatformConfigAdminRoutes(app, {
      service,
      actorFromRequest: () => actorWithScopes([platformConfigAdminScopes.write]),
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/platform-config",
      headers: { "content-type": "application/json" },
      payload: { security: { tier: "business" } },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json<{
      readonly targetTier: string;
      readonly missingRequirements: readonly string[];
    }>();
    expect(body.targetTier).toBe("business");
    expect(body.missingRequirements).toContain("encryptedBackups");

    await app.close();
  });

  it("keeps downgrades available even when target readiness is incomplete", async () => {
    const platformConfig = new InMemoryPlatformConfigSql({
      security: { tier: "business" },
    });
    const service = new PlatformConfigAdminService(
      new PostgresPlatformConfigStore(platformConfig.sql),
      {},
    );
    const actor = actorWithScopes([platformConfigAdminScopes.write]);

    const status = await service.update({ security: { tier: "personal" } }, actor);

    expect(status.config.security.tier).toBe("personal");
  });
});

describe("platform config admin permissions", () => {
  it("maps read and write scopes explicitly", () => {
    expect(canReadPlatformConfig(actorWithScopes([platformConfigAdminScopes.read]))).toBe(true);
    expect(canReadPlatformConfig(actorWithScopes([platformConfigAdminScopes.write]))).toBe(true);
    expect(canWritePlatformConfig(actorWithScopes([platformConfigAdminScopes.write]))).toBe(true);
    expect(canWritePlatformConfig(actorWithScopes([platformConfigAdminScopes.read]))).toBe(false);
    expect(canReadPlatformConfig(actorWithScopes([]))).toBe(false);
  });

  it("enforces read and write scopes on REST admin config routes", async () => {
    const app = fastify();
    const update = vi.fn(async () => platformConfigStatusFixture);
    const service = {
      getStatus: vi.fn(async () => platformConfigStatusFixture),
      update,
    } as unknown as PlatformConfigAdminService;
    await registerPlatformConfigAdminRoutes(app, {
      service,
      actorFromRequest: actorFromTestRequest,
    });

    const deniedRead = await app.inject({ method: "GET", url: "/api/admin/platform-config" });
    expect(deniedRead.statusCode).toBe(403);
    expect(deniedRead.json()).toMatchObject({ requiredScope: platformConfigAdminScopes.read });

    const allowedRead = await app.inject({
      method: "GET",
      url: "/api/admin/platform-config",
      headers: { "x-helix-scopes": platformConfigAdminScopes.read },
    });
    expect(allowedRead.statusCode).toBe(200);

    const deniedWrite = await app.inject({
      method: "PATCH",
      url: "/api/admin/platform-config",
      headers: {
        "content-type": "application/json",
        "x-helix-scopes": platformConfigAdminScopes.read,
      },
      payload: { security: { tier: "business" } },
    });
    expect(deniedWrite.statusCode).toBe(403);
    expect(deniedWrite.json()).toMatchObject({ requiredScope: platformConfigAdminScopes.write });

    const allowedWrite = await app.inject({
      method: "PATCH",
      url: "/api/admin/platform-config",
      headers: {
        "content-type": "application/json",
        "x-helix-scopes": platformConfigAdminScopes.write,
      },
      payload: { security: { tier: "business" } },
    });
    expect(allowedWrite.statusCode).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);

    await app.close();
  });
});

describe("PostgresPlatformConfigStore", () => {
  it("merges existing config rows before upserting updated keys", async () => {
    const actor: Actor = {
      id: "11111111-1111-4111-8111-111111111111",
      orgId: "00000000-0000-0000-0000-000000000000",
      type: "user",
    };
    const recording = createRecordingSql([
      [
        { key: "security", value: { tier: "business" } },
        { key: "platform", value: { readiness: { mfa: { enabled: true, scope: "admins" } } } },
      ],
      [],
      [],
    ]);
    const store = new PostgresPlatformConfigStore(recording.sql);

    await store.update(
      {
        security: { overrides: { secrets: "vault" } },
        platform: { readiness: { vault: { enabled: true, status: "ready" } } },
      },
      actor,
    );

    expect(recording.calls).toHaveLength(3);
    expect(recording.calls[1]?.text).toContain("insert into platform_config");
    expect(recording.calls[1]?.values).toContain("security");
    expect(recording.calls[1]?.values).toContain(actor.id);
    expect(recording.calls[1]?.values).toContainEqual({
      tier: "business",
      overrides: { secrets: "vault" },
    });
    expect(recording.calls[2]?.values).toContain("platform");
    expect(recording.calls[2]?.values).toContainEqual({
      readiness: {
        mfa: { enabled: true, scope: "admins" },
        vault: { enabled: true, status: "ready" },
      },
    });
  });

  it("replaces updated readiness controls so stale status fields do not survive", async () => {
    const actor = actorWithScopes([platformConfigAdminScopes.write]);
    const recording = createRecordingSql([
      [
        {
          key: "platform",
          value: {
            readiness: {
              vault: {
                enabled: true,
                status: "ready",
                evidence: "Healthy before maintenance.",
              },
              spire: { enabled: true, status: "ready" },
            },
          },
        },
      ],
      [],
    ]);
    const store = new PostgresPlatformConfigStore(recording.sql);

    await store.update({ platform: { readiness: { vault: { status: "missing" } } } }, actor);

    expect(recording.calls).toHaveLength(2);
    expect(recording.calls[1]?.values).toContainEqual({
      readiness: {
        vault: { status: "missing" },
        spire: { enabled: true, status: "ready" },
      },
    });
  });

  it("merges typed module, AI, and observability config rows before upserting updated keys", async () => {
    const actor = actorWithScopes([platformConfigAdminScopes.write]);
    const recording = createRecordingSql([
      [
        {
          key: "modules",
          value: {
            mail: {
              enabled: true,
              plugin: "com.helix.core.mail@^1.0.0",
              config: { undoSendSeconds: 30 },
            },
          },
        },
        {
          key: "ai",
          value: {
            enabled: true,
            providers: [
              {
                id: "ollama-local",
                plugin: "com.helix.ai-provider-openai-compat@^1.0.0",
                config: { baseUrl: "http://ollama:11434/v1", models: ["llama3.1:70b"] },
              },
            ],
            routing: {
              rules: [
                {
                  feature: "assistant.chat",
                  primary: { providerId: "ollama-local", model: "llama3.1:70b" },
                },
              ],
            },
          },
        },
        {
          key: "observability",
          value: {
            enabled: true,
            config: { otlpEndpoint: "http://tempo:4317" },
          },
        },
      ],
      [],
      [],
      [],
    ]);
    const store = new PostgresPlatformConfigStore(recording.sql);

    await store.update(
      {
        modules: { mail: { enabled: false }, docs: { enabled: true } },
        ai: {
          costLimits: { perUserPerDayUSD: 5, perOrgPerDayUSD: 500 },
          privacy: {
            redactPIIBeforeSend: true,
            classificationGating: true,
            blockExternalForClassifications: ["confidential", "restricted"],
          },
        },
        observability: {
          config: {
            metricsEndpoint: "http://prometheus:9090",
            sampling: { llmCalls: 1 },
          },
        },
      },
      actor,
    );

    expect(recording.calls).toHaveLength(4);
    expect(recording.calls[1]?.values).toContain("modules");
    expect(recording.calls[1]?.values).toContainEqual({
      mail: {
        enabled: false,
        plugin: "com.helix.core.mail@^1.0.0",
        config: { undoSendSeconds: 30 },
      },
      docs: { enabled: true },
    });
    expect(recording.calls[2]?.values).toContain("ai");
    expect(recording.calls[2]?.values).toContainEqual({
      enabled: true,
      providers: [
        {
          id: "ollama-local",
          plugin: "com.helix.ai-provider-openai-compat@^1.0.0",
          config: { baseUrl: "http://ollama:11434/v1", models: ["llama3.1:70b"] },
        },
      ],
      routing: {
        rules: [
          {
            feature: "assistant.chat",
            primary: { providerId: "ollama-local", model: "llama3.1:70b" },
          },
        ],
      },
      costLimits: { perUserPerDayUSD: 5, perOrgPerDayUSD: 500 },
      privacy: {
        redactPIIBeforeSend: true,
        classificationGating: true,
        blockExternalForClassifications: ["confidential", "restricted"],
      },
    });
    expect(recording.calls[3]?.values).toContain("observability");
    expect(recording.calls[3]?.values).toContainEqual({
      enabled: true,
      config: {
        otlpEndpoint: "http://tempo:4317",
        metricsEndpoint: "http://prometheus:9090",
        sampling: { llmCalls: 1 },
      },
    });
  });
});

describe("PlatformConfigAdminService hot apply", () => {
  it("publishes admin updates to the config changed subject and triggers hot reload subscribers", async () => {
    const events = new InMemoryEventBus();
    const reload = vi.fn(async (): Promise<HelixConfig> => ({ security: { tier: "business" } }));
    const onReload = vi.fn();
    const unsubscribe = await subscribeToConfigHotReload({ events, reload, onReload });
    const recording = createRecordingSql([
      [],
      [],
      [{ key: "security", value: { tier: "business" } }],
    ]);
    const service = new PlatformConfigAdminService(
      new PostgresPlatformConfigStore(recording.sql),
      { HELIX_SECURITY_TIER: "business" },
      events,
    );
    const actor = actorWithScopes([platformConfigAdminScopes.write]);

    await service.update({ security: { tier: "business" } }, actor);

    expect(events.published).toEqual([
      {
        subject: platformConfigChangedSubject,
        payload: {
          actorId: actor.id,
          keys: ["security"],
        },
      },
    ]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenCalledWith({ security: { tier: "business" } });

    await unsubscribe();
  });

  it("hot-applies REST admin PATCH updates to a second config reader without restart", async () => {
    const events = new InMemoryEventBus();
    const platformConfig = new InMemoryPlatformConfigSql();
    const writerStore = new PostgresPlatformConfigStore(platformConfig.sql);
    const replicaStore = new PostgresPlatformConfigStore(platformConfig.sql);
    const service = new PlatformConfigAdminService(writerStore, {}, events);
    const app = fastify();
    const replicaReloads: HelixConfig[] = [];
    const unsubscribe = await subscribeToConfigHotReload({
      events,
      reload: () =>
        loadHelixConfig([new EnvConfigSource({}), new PostgresOverrideConfigSource(replicaStore)]),
      onReload: (config) => {
        replicaReloads.push(config);
      },
    });
    const actor = actorWithScopes([platformConfigAdminScopes.write]);

    await registerPlatformConfigAdminRoutes(app, {
      service,
      actorFromRequest: () => actor,
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/admin/platform-config",
      headers: { "content-type": "application/json" },
      payload: {
        platform: {
          readiness: {
            vault: { enabled: true, status: "ready", endpoint: "https://vault.internal" },
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(platformConfig.upserts).toEqual([
      {
        key: "platform",
        value: {
          readiness: {
            vault: { enabled: true, status: "ready", endpoint: "https://vault.internal" },
          },
        },
      },
    ]);
    expect(events.published).toEqual([
      {
        subject: platformConfigChangedSubject,
        payload: {
          actorId: actor.id,
          keys: ["platform"],
        },
      },
    ]);
    expect(replicaReloads).toHaveLength(1);
    expect(replicaReloads[0]?.platform).toEqual({
      readiness: {
        vault: { enabled: true, status: "ready", endpoint: "https://vault.internal" },
      },
    });

    await unsubscribe();
    await app.close();
  });
});

function createRecordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  const queue = [...responses];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("$"), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  const sql = Object.assign(tag, {
    array: <T extends readonly unknown[]>(value: T) => value,
    json: (value: unknown) => value,
  }) as unknown as postgres.Sql;
  return { sql, calls };
}

class InMemoryEventBus implements EventBus {
  readonly published: { subject: string; payload: JsonValue }[] = [];
  private readonly handlers = new Map<string, Set<(event: EventEnvelope) => Promise<void>>>();

  async publish(subject: string, payload: JsonValue): Promise<void> {
    this.published.push({ subject, payload });
    const handlers = this.handlers.get(subject) ?? new Set();
    await Promise.all(
      [...handlers].map((handler) =>
        handler({
          subject,
          payload,
          occurredAt: new Date().toISOString(),
        }),
      ),
    );
  }

  async subscribe<Payload extends JsonValue>(
    subject: string,
    handler: (event: EventEnvelope<Payload>) => Promise<void>,
  ): Promise<Unsubscribe> {
    const handlers = this.handlers.get(subject) ?? new Set();
    const wrapped = handler as (event: EventEnvelope) => Promise<void>;
    handlers.add(wrapped);
    this.handlers.set(subject, handlers);
    return () => {
      handlers.delete(wrapped);
    };
  }
}

class InMemoryPlatformConfigSql {
  readonly upserts: { key: string; value: unknown }[] = [];
  private readonly rows = new Map<string, unknown>();

  constructor(initialRows: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initialRows)) {
      this.rows.set(key, value);
    }
  }

  readonly sql = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("$");
      if (text.includes("select key, value")) {
        return Promise.resolve(
          [...this.rows.entries()].map(([key, value]) => ({
            key,
            value,
          })),
        );
      }
      if (text.includes("insert into platform_config")) {
        const [key, value] = values;
        if (typeof key !== "string") {
          throw new TypeError("Expected platform config key.");
        }
        this.rows.set(key, value);
        this.upserts.push({ key, value });
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    },
    {
      array: <T extends readonly unknown[]>(value: T) => value,
      json: (value: unknown) => value,
    },
  ) as unknown as postgres.Sql;
}

const platformConfigStatusFixture: PlatformConfigStatus = {
  config: {
    security: { tier: "business" },
  },
  tierDefaults: resolveTierDefaults({ security: { tier: "business" } }),
  readiness: {
    tier: "business",
    ready: true,
    requirements: [],
  },
};

describe("operator AI platform config", () => {
  it("accepts operator LLM + mail spam AI updates", () => {
    const parsed = platformConfigUpdateSchema.parse({
      ai: {
        operatorLlm: {
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          apiKey: "sk-test-secret",
        },
        mailSpamAi: { betaEnabled: true },
      },
    });
    expect(parsed.ai?.operatorLlm?.apiKey).toBe("sk-test-secret");
    expect(parsed.ai?.mailSpamAi?.betaEnabled).toBe(true);
  });

  it("redacts write-only API keys and exposes apiKeyConfigured", () => {
    const redacted = redactAiSecretsForAdmin({
      security: { tier: "business" },
      ai: {
        operatorLlm: {
          baseUrl: "https://llm.example/v1",
          model: "gpt-4o-mini",
          apiKey: "sk-live-secret",
        },
        mailSpamAi: { betaEnabled: true },
      },
    });
    expect(redacted.ai?.operatorLlm).toEqual({
      baseUrl: "https://llm.example/v1",
      model: "gpt-4o-mini",
      apiKeyConfigured: true,
    });
    expect(JSON.stringify(redacted)).not.toContain("sk-live-secret");
    expect(redacted.ai?.mailSpamAi?.betaEnabled).toBe(true);
  });

  it("maps operator LLM + spam toggle into env overlay keys", () => {
    expect(
      operatorAiEnvFromConfig({
        security: { tier: "personal" },
        ai: {
          operatorLlm: {
            apiKey: "sk-op",
            baseUrl: "https://llm.example/v1",
            model: "gpt-4o-mini",
          },
          mailSpamAi: { betaEnabled: true },
        },
      }),
    ).toEqual({
      OPENAI_API_KEY: "sk-op",
      OPENAI_BASE_URL: "https://llm.example/v1",
      OPENAI_MODEL: "gpt-4o-mini",
      MAIL_SPAM_AI_API_KEY: "sk-op",
      MAIL_SPAM_AI_BASE_URL: "https://llm.example/v1",
      MAIL_SPAM_AI_MODEL: "gpt-4o-mini",
      MAIL_ASSIST_AI_API_KEY: "sk-op",
      MAIL_ASSIST_AI_BASE_URL: "https://llm.example/v1",
      MAIL_ASSIST_AI_MODEL: "gpt-4o-mini",
      MAIL_SPAM_AI_BETA_ENABLED: "true",
    });
    expect(
      operatorAiEnvFromConfig({
        security: { tier: "personal" },
        ai: { mailSpamAi: { betaEnabled: false } },
      }),
    ).toEqual({ MAIL_SPAM_AI_BETA_ENABLED: "false" });
  });

  it("routes different providers to spam vs assistant via feature rules", () => {
    const config: HelixConfig = {
      security: { tier: "personal" },
      ai: {
        providers: [
          {
            id: "chat-llm",
            plugin: "com.helix.ai-provider-openai-compat@^1.0.0",
            config: {
              baseUrl: "https://chat.example/v1",
              defaultModel: "gpt-4o",
              apiKey: "sk-chat",
            },
          },
          {
            id: "spam-llm",
            plugin: "com.helix.ai-provider-openai-compat@^1.0.0",
            config: {
              baseUrl: "https://spam.example/v1",
              defaultModel: "gpt-4o-mini",
              apiKey: "sk-spam",
            },
          },
        ],
        routing: {
          rules: [
            { feature: "assistant.chat", primary: { providerId: "chat-llm", model: "gpt-4o" } },
            {
              feature: "mail.spam-ai",
              primary: { providerId: "spam-llm", model: "gpt-4o-mini" },
            },
          ],
        },
        mailSpamAi: { betaEnabled: true },
      },
    };
    expect(resolveFeatureProviderCredentials(config, "mail.spam-ai")).toMatchObject({
      providerId: "spam-llm",
      apiKey: "sk-spam",
      model: "gpt-4o-mini",
    });
    const overlay = operatorAiEnvFromConfig(config);
    expect(overlay.OPENAI_API_KEY).toBe("sk-chat");
    expect(overlay.OPENAI_MODEL).toBe("gpt-4o");
    expect(overlay.MAIL_SPAM_AI_API_KEY).toBe("sk-spam");
    expect(overlay.MAIL_SPAM_AI_MODEL).toBe("gpt-4o-mini");
    expect(overlay.MAIL_SPAM_AI_BETA_ENABLED).toBe("true");
  });

  it("preserves provider apiKey when Admin omits it on PATCH merge", () => {
    const merged = mergeAiProvidersPreservingSecrets(
      {
        providers: [
          {
            id: "p1",
            plugin: "com.helix.ai-provider-openai-compat@^1.0.0",
            config: { apiKey: "sk-keep", baseUrl: "https://a.example/v1", defaultModel: "m1" },
          },
        ],
      },
      {
        providers: [
          {
            id: "p1",
            plugin: "com.helix.ai-provider-openai-compat@^1.0.0",
            config: { baseUrl: "https://b.example/v1", defaultModel: "m2" },
          },
        ],
      },
    );
    expect(merged?.providers?.[0]?.config).toMatchObject({
      apiKey: "sk-keep",
      baseUrl: "https://b.example/v1",
      defaultModel: "m2",
    });
  });

  it("redacts provider apiKeys and exposes apiKeyConfigured", () => {
    const redacted = redactAiSecretsForAdmin({
      security: { tier: "personal" },
      ai: {
        providers: [
          {
            id: "p1",
            plugin: "com.helix.ai-provider-openai-compat@^1.0.0",
            config: { apiKey: "sk-secret", baseUrl: "https://x", defaultModel: "m" },
          },
        ],
      },
    });
    expect(JSON.stringify(redacted)).not.toContain("sk-secret");
    expect(redacted.ai?.providers?.[0]?.config).toMatchObject({
      apiKeyConfigured: true,
      baseUrl: "https://x",
      defaultModel: "m",
    });
  });

  it("persists AI operator settings via platform-config store and redacts on GET", async () => {
    const platformConfig = new InMemoryPlatformConfigSql({
      security: { tier: "personal" },
    });
    const service = new PlatformConfigAdminService(
      new PostgresPlatformConfigStore(platformConfig.sql),
      {},
    );
    const actor = actorWithScopes([platformConfigAdminScopes.write]);

    const status = await service.update(
      {
        ai: {
          operatorLlm: {
            baseUrl: "https://api.example/v1",
            model: "gpt-4o-mini",
            apiKey: "sk-persisted",
          },
          mailSpamAi: { betaEnabled: true },
        },
      },
      actor,
    );

    expect(status.config.ai?.operatorLlm).toEqual({
      baseUrl: "https://api.example/v1",
      model: "gpt-4o-mini",
      apiKeyConfigured: true,
    });
    expect(JSON.stringify(status)).not.toContain("sk-persisted");
    expect(status.config.ai?.mailSpamAi?.betaEnabled).toBe(true);

    // Partial update without apiKey keeps the stored key.
    const again = await service.update(
      {
        ai: {
          operatorLlm: { model: "gpt-4.1-mini" },
          mailSpamAi: { betaEnabled: false },
        },
      },
      actor,
    );
    expect(again.config.ai?.operatorLlm).toEqual({
      baseUrl: "https://api.example/v1",
      model: "gpt-4.1-mini",
      apiKeyConfigured: true,
    });
    expect(again.config.ai?.mailSpamAi?.betaEnabled).toBe(false);
  });
});

function actorWithScopes(scopes: readonly string[]): Actor {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "00000000-0000-0000-0000-000000000000",
    type: "user",
    scopes,
  };
}

function actorFromTestRequest(request: FastifyRequest): Actor {
  const value = request.headers["x-helix-scopes"];
  const scopes =
    typeof value === "string" ? value.split(/[,\s]+/u).filter((scope) => scope.length > 0) : [];
  return actorWithScopes(scopes);
}
