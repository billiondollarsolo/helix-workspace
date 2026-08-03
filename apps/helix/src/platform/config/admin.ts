import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod3";
import type {
  Actor,
  EventBus,
  HelixConfig,
  JsonObject,
  JsonValue,
  SecurityTier,
  TierSecurityDefaults,
} from "@helix/sdk";
import { isJsonObject } from "@helix/sdk";
import {
  EnvConfigSource,
  PostgresOverrideConfigSource,
  loadHelixConfig,
  mergeConfig,
  type PartialHelixConfig,
  type PostgresConfigOverrideStore,
} from "./loader.js";
import { resolveTierDefaults } from "./tier.js";

const platformConfigKeys = [
  "security",
  "plugins",
  "modules",
  "ai",
  "observability",
  "platform",
] as const;
const adminUpdateConfigKeys = ["security", "modules", "ai", "observability", "platform"] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const adminConfigScopePrefix = "admin.config";

export const platformConfigChangedSubject = "helix.config.changed";

export const platformConfigAdminScopes = {
  read: `${adminConfigScopePrefix}.read`,
  write: `${adminConfigScopePrefix}.write`,
} as const;

const securityTierSchema = z.enum(["personal", "business", "enterprise", "sovereign"]);
const auditDestinationSchema = z.enum(["postgres", "immutable-s3", "siem", "worm"]);
const dataClassificationSchema = z.enum(["public", "standard", "confidential", "restricted"]);
const jsonObjectSchema = z
  .custom<JsonObject>((value) => isJsonObject(value) && isJsonValue(value))
  .refine((value) => isJsonObject(value), "Expected JSON object.");
const tierOverridesSchema = z
  .object({
    internalTransit: z.enum(["plaintext", "caddy-mtls", "spire-mtls"]).optional(),
    secrets: z.enum(["env", "sops", "vault"]).optional(),
    auditHashChain: z.boolean().optional(),
    auditDestinations: z.array(auditDestinationSchema).optional(),
    networkEgress: z
      .enum(["open", "recommended-allowlist", "required-allowlist", "default-deny"])
      .optional(),
    toolConfirmation: z
      .enum(["destructive", "destructive_and_external", "all_write", "all"])
      .optional(),
    pluginSignatureRequired: z.boolean().optional(),
    localAiOnly: z.boolean().optional(),
  })
  .strict();

const moduleConfigUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    plugin: z.string().min(1).max(300).optional(),
    config: jsonObjectSchema.optional(),
  })
  .strict();

const aiPluginRefSchema = z
  .object({
    plugin: z.string().min(1).max(300),
    config: jsonObjectSchema.optional(),
  })
  .strict();

const aiProviderSchema = aiPluginRefSchema
  .extend({
    id: z.string().min(1).max(100),
    enabled: z.boolean().optional(),
    tags: z.array(z.string().min(1).max(100)).optional(),
  })
  .strict();

const aiProviderModelRefSchema = z
  .object({
    providerId: z.string().min(1).max(100),
    model: z.string().min(1).max(200).optional(),
  })
  .strict();

const aiRoutingClassificationsSchema = z
  .object({
    public: aiProviderModelRefSchema.optional(),
    standard: aiProviderModelRefSchema.optional(),
    confidential: aiProviderModelRefSchema.optional(),
    restricted: aiProviderModelRefSchema.optional(),
  })
  .strict();

const aiRoutingRuleSchema = z
  .object({
    feature: z.string().min(1).max(200),
    primary: aiProviderModelRefSchema,
    fallback: aiProviderModelRefSchema.optional(),
    classifications: aiRoutingClassificationsSchema.optional(),
  })
  .strict();

const aiOperatorLlmUpdateSchema = z
  .object({
    baseUrl: z.string().min(1).max(500).optional(),
    model: z.string().min(1).max(200).optional(),
    /** Write-only; never returned by GET after save. */
    apiKey: z.string().min(1).max(4000).optional(),
  })
  .strict();

const aiMailSpamUpdateSchema = z
  .object({
    betaEnabled: z.boolean().optional(),
  })
  .strict();

const aiConfigUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultPosture: z.enum(["disabled", "admin-controlled", "user-controlled"]).optional(),
    providers: z.array(aiProviderSchema).optional(),
    vectorStore: aiPluginRefSchema.optional(),
    embeddingProvider: aiPluginRefSchema.optional(),
    routing: z
      .object({
        rules: z.array(aiRoutingRuleSchema).optional(),
      })
      .strict()
      .optional(),
    costLimits: z
      .object({
        perUserPerDayUSD: z.number().nonnegative().optional(),
        perOrgPerDayUSD: z.number().nonnegative().optional(),
        perAgentPerDayUSD: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    audit: z
      .object({
        logRequests: z.enum(["off", "metadata-only", "full"]).optional(),
        retainDays: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    privacy: z
      .object({
        redactPIIBeforeSend: z.boolean().optional(),
        classificationGating: z.boolean().optional(),
        blockExternalForClassifications: z.array(dataClassificationSchema).optional(),
      })
      .strict()
      .optional(),
    operatorLlm: aiOperatorLlmUpdateSchema.optional(),
    mailSpamAi: aiMailSpamUpdateSchema.optional(),
  })
  .strict();

const observabilityConfigUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    plugin: z.string().min(1).max(300).optional(),
    config: z
      .object({
        otlpEndpoint: z.string().min(1).max(500).optional(),
        tracesEndpoint: z.string().min(1).max(500).optional(),
        metricsEndpoint: z.string().min(1).max(500).optional(),
        logsEndpoint: z.string().min(1).max(500).optional(),
        sampling: z
          .object({
            traces: z.number().min(0).max(1).optional(),
            llmCalls: z.number().min(0).max(1).optional(),
            toolCalls: z.number().min(0).max(1).optional(),
            permissionChecks: z.number().min(0).max(1).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    bundledStack: z
      .object({
        enabled: z.boolean().optional(),
        plugin: z.string().min(1).max(300).optional(),
        grafanaUrl: z.string().min(1).max(500).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const readinessStatusSchema = z.enum(["unknown", "ready", "missing", "degraded"]);
const checkedControlSchema = z
  .object({
    enabled: z.boolean().optional(),
    status: readinessStatusSchema.optional(),
    evidence: z.string().min(1).max(2000).optional(),
    lastCheckedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

const mfaReadinessSchema = checkedControlSchema.extend({
  scope: z.enum(["none", "admins", "org"]).optional(),
});

const encryptedBackupsReadinessSchema = checkedControlSchema.extend({
  lastSuccessfulBackupAt: z.string().datetime({ offset: true }).optional(),
});

const auditDestinationsReadinessSchema = checkedControlSchema.extend({
  destinations: z.array(auditDestinationSchema).optional(),
});

const serviceReadinessSchema = checkedControlSchema.extend({
  endpoint: z.string().min(1).max(500).optional(),
});

const fipsReadinessSchema = checkedControlSchema.extend({
  mode: z.enum(["disabled", "permissive", "required"]).optional(),
  cryptoAdapter: z.string().min(1).max(200).optional(),
  runtimeAttestation: z.boolean().optional(),
});

const stigImagePolicyReadinessSchema = checkedControlSchema.extend({
  requireDigest: z.boolean().optional(),
  requireSignature: z.boolean().optional(),
  approvedBaseImages: z.array(z.string().min(1).max(200)).optional(),
});

const airgapReadinessSchema = checkedControlSchema.extend({
  bundleMirrored: z.boolean().optional(),
  internalRegistry: z.string().min(1).max(500).optional(),
});

const wormReadinessSchema = checkedControlSchema.extend({
  retentionLocked: z.boolean().optional(),
  destinations: z.array(auditDestinationSchema).optional(),
});

const cacPivReadinessSchema = checkedControlSchema.extend({
  scope: z.enum(["none", "admins", "org"]).optional(),
  pkcs11Provider: z.string().min(1).max(200).optional(),
});

const hsmBackupsReadinessSchema = checkedControlSchema.extend({
  encrypted: z.boolean().optional(),
  keyProvider: z.enum(["none", "kms", "hsm"]).optional(),
  lastSuccessfulBackupAt: z.string().datetime({ offset: true }).optional(),
});

const defaultDenyEgressReadinessSchema = checkedControlSchema.extend({
  policy: z
    .enum(["open", "recommended-allowlist", "required-allowlist", "default-deny"])
    .optional(),
  enforced: z.boolean().optional(),
});

export const platformReadinessUpdateSchema = z
  .object({
    mfa: mfaReadinessSchema.optional(),
    encryptedBackups: encryptedBackupsReadinessSchema.optional(),
    auditDestinations: auditDestinationsReadinessSchema.optional(),
    vault: serviceReadinessSchema.optional(),
    spire: serviceReadinessSchema.optional(),
    siem: serviceReadinessSchema.optional(),
    cloudNativePg: serviceReadinessSchema.optional(),
    fips: fipsReadinessSchema.optional(),
    stigImagePolicy: stigImagePolicyReadinessSchema.optional(),
    airgap: airgapReadinessSchema.optional(),
    worm: wormReadinessSchema.optional(),
    cacPiv: cacPivReadinessSchema.optional(),
    hsmBackups: hsmBackupsReadinessSchema.optional(),
    defaultDenyEgress: defaultDenyEgressReadinessSchema.optional(),
  })
  .strict();

export const platformConfigUpdateSchema = z
  .object({
    security: z
      .object({
        tier: securityTierSchema.optional(),
        overrides: tierOverridesSchema.optional(),
      })
      .strict()
      .optional(),
    modules: z.record(z.string(), moduleConfigUpdateSchema).optional(),
    ai: aiConfigUpdateSchema.optional(),
    observability: observabilityConfigUpdateSchema.optional(),
    platform: z
      .object({
        readiness: platformReadinessUpdateSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type PlatformConfigUpdate = z.infer<typeof platformConfigUpdateSchema>;
export type PlatformReadinessUpdate = z.infer<typeof platformReadinessUpdateSchema>;
export type PlatformConfigAdminScope =
  (typeof platformConfigAdminScopes)[keyof typeof platformConfigAdminScopes];

export interface PlatformConfigStatus {
  readonly config: HelixConfig;
  readonly tierDefaults: TierSecurityDefaults;
  readonly readiness: PlatformReadinessReport;
}

export interface PlatformReadinessReport {
  readonly tier: SecurityTier;
  readonly ready: boolean;
  readonly requirements: readonly PlatformReadinessRequirement[];
}

export interface PlatformReadinessRequirement {
  readonly key:
    | "mfa"
    | "encryptedBackups"
    | "auditDestinations"
    | "vault"
    | "spire"
    | "siem"
    | "cloudNativePg"
    | "fips"
    | "stigImagePolicy"
    | "airgap"
    | "worm"
    | "cacPiv"
    | "hsmBackups"
    | "defaultDenyEgress";
  readonly label: string;
  readonly required: boolean;
  readonly status: "ready" | "missing" | "not_required" | "unknown" | "degraded";
  readonly expected: JsonObject;
  readonly observed: JsonObject;
  readonly missing?: readonly string[];
}

export class PlatformTierReadinessError extends Error {
  readonly targetTier: SecurityTier;
  readonly missingRequirements: readonly PlatformReadinessRequirement["key"][];
  readonly readiness: PlatformReadinessReport;

  constructor(
    targetTier: SecurityTier,
    missingRequirements: readonly PlatformReadinessRequirement["key"][],
    readiness: PlatformReadinessReport,
  ) {
    super(
      `Tier upgrade to ${targetTier} is blocked until required readiness gates pass: ${missingRequirements.join(", ")}.`,
    );
    this.name = "PlatformTierReadinessError";
    this.targetTier = targetTier;
    this.missingRequirements = missingRequirements;
    this.readiness = readiness;
  }
}

interface PlatformConfigRow {
  readonly key: string;
  readonly value: unknown;
}

export class PostgresPlatformConfigStore implements PostgresConfigOverrideStore {
  constructor(private readonly sql: postgres.Sql) {}

  async loadOverrides(): Promise<PartialHelixConfig> {
    const rows = await this.loadRows();
    let merged: PartialHelixConfig = {};
    for (const row of rows) {
      merged = mergeConfig(merged, partialConfigFromRow(row));
    }
    return merged;
  }

  async update(update: PlatformConfigUpdate, actor: Actor): Promise<void> {
    const current = await this.loadOverrides();
    const next = mergePlatformConfigUpdate(current, update);
    const updatedByActorId = uuidPattern.test(actor.id) ? actor.id : null;

    if (update.security !== undefined) {
      await this.upsert("security", jsonObjectFromDefined(next.security ?? {}), updatedByActorId);
    }
    if (update.modules !== undefined) {
      await this.upsert("modules", jsonObjectFromDefined(next.modules ?? {}), updatedByActorId);
    }
    if (update.ai !== undefined) {
      await this.upsert("ai", jsonObjectFromDefined(next.ai ?? {}), updatedByActorId);
    }
    if (update.observability !== undefined) {
      await this.upsert(
        "observability",
        jsonObjectFromDefined(next.observability ?? {}),
        updatedByActorId,
      );
    }
    if (update.platform !== undefined) {
      await this.upsert("platform", jsonObjectFromDefined(next.platform ?? {}), updatedByActorId);
    }
  }

  private async loadRows(): Promise<readonly PlatformConfigRow[]> {
    const rows = await this.sql`
      select key, value
      from platform_config
      where key = any(${this.sql.array([...platformConfigKeys], 1009)})
    `;
    return rows as unknown as readonly PlatformConfigRow[];
  }

  private async upsert(
    key: (typeof platformConfigKeys)[number],
    value: JsonObject,
    updatedByActorId: string | null,
  ): Promise<void> {
    await this.sql`
      insert into platform_config (key, value, sensitive, updated_by_actor_id, updated_at)
      values (${key}, ${this.sql.json(value)}, ${false}, ${updatedByActorId}, now())
      on conflict (key) do update
      set value = excluded.value,
          sensitive = false,
          updated_by_actor_id = excluded.updated_by_actor_id,
          updated_at = now()
    `;
  }
}

export class PlatformConfigAdminService {
  constructor(
    private readonly store: PostgresPlatformConfigStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly events?: EventBus,
  ) {}

  async getStatus(): Promise<PlatformConfigStatus> {
    const config = await this.loadConfig();
    return this.statusForConfig(config);
  }

  async update(update: PlatformConfigUpdate, actor: Actor): Promise<PlatformConfigStatus> {
    const currentConfig = await this.loadConfig();
    this.assertTierUpgradeReady(currentConfig, update);
    await this.store.update(update, actor);
    await this.publishConfigChanged(update, actor);
    return this.getStatus();
  }

  private async loadConfig(): Promise<HelixConfig> {
    return loadHelixConfig([
      new EnvConfigSource(this.env),
      new PostgresOverrideConfigSource(this.store),
    ]);
  }

  private statusForConfig(config: HelixConfig): PlatformConfigStatus {
    const readinessConfig = applyObservedPlatformReadiness(config, this.env);
    const tierDefaults = resolveTierDefaults(readinessConfig);
    return {
      config: redactAiSecretsForAdmin(readinessConfig),
      tierDefaults,
      readiness: buildPlatformReadinessReport(readinessConfig, tierDefaults),
    };
  }

  private assertTierUpgradeReady(currentConfig: HelixConfig, update: PlatformConfigUpdate): void {
    const targetTier = update.security?.tier;
    if (targetTier === undefined || tierRank(targetTier) <= tierRank(currentConfig.security.tier)) {
      return;
    }

    const candidateConfig = completeHelixConfig(mergePlatformConfigUpdate(currentConfig, update));
    const readiness = this.statusForConfig(candidateConfig).readiness;
    const missingRequirements = readiness.requirements
      .filter((requirement) => requirement.required && requirement.status !== "ready")
      .map((requirement) => requirement.key);

    if (missingRequirements.length > 0) {
      throw new PlatformTierReadinessError(targetTier, missingRequirements, readiness);
    }
  }

  private async publishConfigChanged(update: PlatformConfigUpdate, actor: Actor): Promise<void> {
    const keys = updatedConfigKeys(update);
    if (this.events === undefined || keys.length === 0) {
      return;
    }

    await this.events.publish(platformConfigChangedSubject, {
      actorId: actor.id,
      keys,
    });
  }
}

function completeHelixConfig(config: PartialHelixConfig): HelixConfig {
  return {
    security: {
      tier: config.security?.tier ?? "personal",
      ...(config.security?.overrides === undefined ? {} : { overrides: config.security.overrides }),
    },
    ...(config.modules === undefined ? {} : { modules: config.modules }),
    ...(config.ai === undefined ? {} : { ai: config.ai }),
    ...(config.observability === undefined ? {} : { observability: config.observability }),
    ...(config.plugins === undefined ? {} : { plugins: config.plugins }),
    ...(config.platform === undefined ? {} : { platform: config.platform }),
  };
}

function tierRank(tier: SecurityTier): number {
  switch (tier) {
    case "personal":
      return 1;
    case "business":
      return 2;
    case "enterprise":
      return 3;
    case "sovereign":
      return 4;
  }
}

export function applyObservedPlatformReadiness(
  config: HelixConfig,
  env: NodeJS.ProcessEnv = process.env,
): HelixConfig {
  const observed = observedPlatformReadiness(config, env);
  if (Object.keys(observed).length === 0) {
    return config;
  }

  const platform = config.platform ?? {};
  const existingReadiness = isJsonObject(platform.readiness) ? platform.readiness : {};
  const readiness = mergeReadinessObjects(observed, existingReadiness);

  return {
    ...config,
    platform: {
      ...platform,
      readiness,
    },
  };
}

function mergeReadinessObjects(observed: JsonObject, existing: JsonObject): JsonObject {
  const readiness: Record<string, JsonValue> = { ...observed };
  for (const [key, value] of Object.entries(existing)) {
    const observedValue = readiness[key];
    readiness[key] =
      isJsonObject(observedValue) && isJsonObject(value) ? { ...observedValue, ...value } : value;
  }
  return readiness;
}

function observedPlatformReadiness(config: HelixConfig, env: NodeJS.ProcessEnv): JsonObject {
  const endpoints = platformEndpoints(config.platform);
  const vaultEndpoint = firstNonEmptyString(
    env.VAULT_ADDR,
    objectString(platformServiceEndpoint(endpoints.vault), "address"),
    objectString(platformServiceEndpoint(endpoints.vault), "endpoint"),
  );
  const siemEndpoint = firstNonEmptyString(
    env.SIEM_ENDPOINT,
    objectString(platformServiceEndpoint(endpoints.siem), "endpoint"),
  );
  const databaseUrl = firstNonEmptyString(env.DATABASE_URL);
  const cloudNativePgEndpoint = platformServiceEndpoint(endpoints.cloudNativePg);
  const cloudNativePgEnabled =
    objectBoolean(cloudNativePgEndpoint, "enabled") ??
    objectBoolean(platformServiceEndpoint(endpoints.postgres), "cloudNativePg") ??
    databaseUrlLooksCloudNativePg(databaseUrl);

  return jsonObjectFromDefined({
    vault:
      vaultEndpoint === undefined
        ? undefined
        : {
            enabled: true,
            status: "ready",
            endpoint: vaultEndpoint,
            evidence: "Vault endpoint observed from runtime configuration.",
          },
    siem:
      siemEndpoint === undefined
        ? undefined
        : {
            enabled: true,
            status: "ready",
            endpoint: siemEndpoint,
            evidence:
              env.SIEM_FORMAT === undefined || env.SIEM_FORMAT.length === 0
                ? "SIEM endpoint observed from runtime configuration."
                : `SIEM endpoint observed from runtime configuration with ${env.SIEM_FORMAT.toUpperCase()} format.`,
          },
    cloudNativePg:
      cloudNativePgEnabled !== true
        ? undefined
        : {
            enabled: true,
            status: "ready",
            endpoint:
              firstNonEmptyString(
                objectString(cloudNativePgEndpoint, "endpoint"),
                databaseEndpointSummary(databaseUrl),
              ) ?? "configured",
            evidence: "CloudNativePG wiring observed from runtime configuration.",
          },
  });
}

function platformEndpoints(platform: JsonObject | undefined): JsonObject {
  if (!isJsonObject(platform?.endpoints)) {
    return {};
  }
  return platform.endpoints;
}

function platformServiceEndpoint(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function objectString(value: JsonObject | undefined, key: string): string | undefined {
  const entry = value?.[key];
  return typeof entry === "string" && entry.length > 0 ? entry : undefined;
}

function objectBoolean(value: JsonObject | undefined, key: string): boolean | undefined {
  const entry = value?.[key];
  return typeof entry === "boolean" ? entry : undefined;
}

function firstNonEmptyString(...values: readonly (string | undefined)[]): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0);
}

function databaseUrlLooksCloudNativePg(databaseUrl: string | undefined): boolean | undefined {
  if (databaseUrl === undefined) {
    return undefined;
  }
  try {
    const url = new URL(databaseUrl);
    return /\bcnpg\b|cloudnativepg|-(?:rw|ro|r|w)$/iu.test(url.hostname);
  } catch {
    return /\bcnpg\b|cloudnativepg|-(?:rw|ro|r|w)\b/iu.test(databaseUrl);
  }
}

function databaseEndpointSummary(databaseUrl: string | undefined): string | undefined {
  if (databaseUrl === undefined) {
    return undefined;
  }
  try {
    const url = new URL(databaseUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "configured";
  }
}

export interface RegisterPlatformConfigAdminRoutesOptions {
  readonly service: PlatformConfigAdminService;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
}

export async function registerPlatformConfigAdminRoutes(
  app: FastifyInstance,
  options: RegisterPlatformConfigAdminRoutesOptions,
): Promise<void> {
  app.get("/api/admin/platform-config", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadPlatformConfig(actor)) {
      return reply.code(403).send(permissionDeniedResponse(platformConfigAdminScopes.read));
    }
    return options.service.getStatus();
  });
  app.get("/api/admin/platform-config/readiness", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canReadPlatformConfig(actor)) {
      return reply.code(403).send(permissionDeniedResponse(platformConfigAdminScopes.read));
    }
    return (await options.service.getStatus()).readiness;
  });
  app.patch("/api/admin/platform-config", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canWritePlatformConfig(actor)) {
      return reply.code(403).send(permissionDeniedResponse(platformConfigAdminScopes.write));
    }
    const parsed = platformConfigUpdateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid platform config update.", issues: parsed.error.issues });
    }
    try {
      return await options.service.update(parsed.data, actor);
    } catch (error) {
      if (error instanceof PlatformTierReadinessError) {
        return reply.code(409).send({
          error: error.message,
          targetTier: error.targetTier,
          missingRequirements: error.missingRequirements,
          readiness: error.readiness,
        });
      }
      throw error;
    }
  });
}

export function canReadPlatformConfig(actor: Actor): boolean {
  return (
    actorHasScope(actor, platformConfigAdminScopes.read) ||
    actorHasScope(actor, platformConfigAdminScopes.write)
  );
}

export function canWritePlatformConfig(actor: Actor): boolean {
  return actorHasScope(actor, platformConfigAdminScopes.write);
}

export function buildPlatformReadinessReport(
  config: HelixConfig,
  defaults: TierSecurityDefaults = resolveTierDefaults(config),
): PlatformReadinessReport {
  const state = readPlatformReadiness(config.platform);
  const requirements: PlatformReadinessRequirement[] = [
    mfaRequirement(config.security.tier, state.mfa),
    encryptedBackupsRequirement(config.security.tier, state.encryptedBackups),
    auditDestinationsRequirement(defaults.auditDestinations, state.auditDestinations),
    serviceRequirement("vault", "Vault", defaults.secrets === "vault", state.vault),
    serviceRequirement("spire", "SPIRE", defaults.internalTransit === "spire-mtls", state.spire),
    serviceRequirement("siem", "SIEM", defaults.auditDestinations.includes("siem"), state.siem),
    serviceRequirement(
      "cloudNativePg",
      "CloudNativePG",
      config.security.tier === "enterprise" || config.security.tier === "sovereign",
      state.cloudNativePg,
    ),
    fipsRequirement(config.security.tier, state.fips),
    stigImagePolicyRequirement(config.security.tier, state.stigImagePolicy),
    airgapRequirement(config.security.tier, state.airgap),
    wormRequirement(config.security.tier, state.worm),
    cacPivRequirement(config.security.tier, state.cacPiv),
    hsmBackupsRequirement(config.security.tier, state.hsmBackups),
    defaultDenyEgressRequirement(
      config.security.tier,
      defaults.networkEgress,
      state.defaultDenyEgress,
    ),
  ];

  return {
    tier: config.security.tier,
    ready: requirements.every(
      (requirement) => !requirement.required || requirement.status === "ready",
    ),
    requirements,
  };
}

function partialConfigFromRow(row: PlatformConfigRow): PartialHelixConfig {
  if (row.key === "security") {
    const security = normalizeJsonObject(row.value, "platform_config.security");
    return { security: normalizeSecurityConfig(security) };
  }
  if (row.key === "plugins") {
    return { plugins: normalizeRecordOfJsonObjects(row.value, "platform_config.plugins") };
  }
  if (row.key === "modules") {
    return { modules: normalizeModulesConfig(row.value, "platform_config.modules") };
  }
  if (row.key === "ai") {
    return { ai: normalizeAiConfig(row.value, "platform_config.ai") };
  }
  if (row.key === "observability") {
    return {
      observability: normalizeObservabilityConfig(row.value, "platform_config.observability"),
    };
  }
  if (row.key === "platform") {
    return { platform: normalizeJsonObject(row.value, "platform_config.platform") };
  }
  return {};
}

function updateToPartialConfig(update: PlatformConfigUpdate): PartialHelixConfig {
  const config: PartialHelixConfig = {};
  if (update.security !== undefined) {
    const security: NonNullable<PartialHelixConfig["security"]> = {};
    if (update.security.tier !== undefined) {
      Object.assign(security, { tier: update.security.tier });
    }
    if (update.security.overrides !== undefined) {
      Object.assign(security, { overrides: jsonObjectFromDefined(update.security.overrides) });
    }
    Object.assign(config, { security });
  }
  if (update.modules !== undefined) {
    Object.assign(config, {
      modules: normalizeModulesConfig(jsonObjectFromDefined(update.modules), "modules"),
    });
  }
  if (update.ai !== undefined) {
    Object.assign(config, { ai: normalizeAiConfig(jsonObjectFromDefined(update.ai), "ai") });
  }
  if (update.observability !== undefined) {
    Object.assign(config, {
      observability: normalizeObservabilityConfig(
        jsonObjectFromDefined(update.observability),
        "observability",
      ),
    });
  }
  if (update.platform !== undefined) {
    Object.assign(config, {
      platform: normalizeJsonObject(jsonObjectFromDefined(update.platform), "platform"),
    });
  }
  return config;
}

function mergePlatformConfigUpdate(
  current: PartialHelixConfig,
  update: PlatformConfigUpdate,
): PartialHelixConfig {
  const next = mergeConfig(current, updateToPartialConfig(update));
  // Providers are replaced as arrays; re-merge so omitted apiKeys keep stored secrets.
  if (update.ai?.providers !== undefined) {
    const mergedAi = mergeAiProvidersPreservingSecrets(current.ai, next.ai);
    if (mergedAi !== undefined) {
      Object.assign(next, { ai: mergedAi });
    }
  }
  const readinessUpdate = update.platform?.readiness;
  if (readinessUpdate === undefined) {
    return next;
  }

  const platform = next.platform ?? {};
  const readiness = isJsonObject(platform.readiness) ? platform.readiness : {};
  return {
    ...next,
    platform: {
      ...platform,
      readiness: replaceUpdatedReadinessControls(readiness, readinessUpdate),
    },
  };
}

function updatedConfigKeys(update: PlatformConfigUpdate): JsonValue[] {
  return adminUpdateConfigKeys.filter((key) => update[key] !== undefined);
}

function normalizeSecurityConfig(value: JsonObject): NonNullable<PartialHelixConfig["security"]> {
  const parsed = platformConfigUpdateSchema.shape.security.unwrap().parse(value);
  return updateToPartialConfig({ security: parsed }).security ?? {};
}

function normalizeModulesConfig(
  value: unknown,
  label: string,
): NonNullable<PartialHelixConfig["modules"]> {
  const object = normalizeJsonObject(value, label);
  const parsed = z.record(z.string(), moduleConfigUpdateSchema).parse(object);
  return jsonObjectFromDefined(parsed) as unknown as NonNullable<PartialHelixConfig["modules"]>;
}

function normalizeAiConfig(value: unknown, label: string): NonNullable<PartialHelixConfig["ai"]> {
  const parsed = aiConfigUpdateSchema.parse(normalizeJsonObject(value, label));
  return jsonObjectFromDefined(parsed);
}

/** Known product AI slots for Admin routing UI (feature id → purpose). */
export const AI_FEATURE_SLOTS = [
  { feature: "assistant.chat", label: "Assistant chat (default)" },
  { feature: "mail.spam-ai", label: "Mail spam AI (beta)" },
  { feature: "mail.compose-help", label: "Mail compose assist" },
] as const;

/** Strip write-only API keys from admin GET responses; expose apiKeyConfigured. */
export function redactAiSecretsForAdmin(config: HelixConfig): HelixConfig {
  const ai = config.ai;
  if (ai === undefined) {
    return config;
  }
  const operatorLlm = ai.operatorLlm;
  const redactedOperator =
    operatorLlm === undefined
      ? undefined
      : {
          ...(operatorLlm.baseUrl === undefined ? {} : { baseUrl: operatorLlm.baseUrl }),
          ...(operatorLlm.model === undefined ? {} : { model: operatorLlm.model }),
          apiKeyConfigured:
            typeof operatorLlm.apiKey === "string" && operatorLlm.apiKey.trim().length > 0,
        };
  const redactedProviders = ai.providers?.map((provider) => {
    const cfg = provider.config ?? {};
    const hasKey =
      typeof cfg.apiKey === "string" && cfg.apiKey.trim().length > 0
        ? true
        : cfg.apiKeyConfigured === true;
    const { apiKey: _apiKey, ...restConfig } = cfg as Record<string, unknown>;
    return {
      ...provider,
      config: {
        ...restConfig,
        apiKeyConfigured: hasKey,
      },
    };
  });
  return {
    ...config,
    ai: {
      ...ai,
      ...(redactedOperator === undefined ? {} : { operatorLlm: redactedOperator }),
      ...(redactedProviders === undefined ? {} : { providers: redactedProviders }),
    },
  };
}

function providerCredentialFields(provider: {
  readonly config?: Readonly<Record<string, unknown>> | undefined;
}): {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
} {
  const cfg = provider.config ?? {};
  const apiKey =
    typeof cfg.apiKey === "string" && cfg.apiKey.trim().length > 0 ? cfg.apiKey : undefined;
  const baseUrl =
    typeof cfg.baseUrl === "string" && cfg.baseUrl.trim().length > 0 ? cfg.baseUrl : undefined;
  const model =
    (typeof cfg.defaultModel === "string" && cfg.defaultModel.trim().length > 0
      ? cfg.defaultModel
      : undefined) ??
    (typeof cfg.model === "string" && cfg.model.trim().length > 0 ? cfg.model : undefined);
  return {
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(model === undefined ? {} : { model }),
  };
}

/** Resolve provider credentials for a routing feature (primary rule). */
export function resolveFeatureProviderCredentials(
  config: HelixConfig,
  feature: string,
): {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly model?: string;
  readonly providerId?: string;
} {
  const rule = config.ai?.routing?.rules?.find((entry) => entry.feature === feature);
  if (rule === undefined) {
    return {};
  }
  const provider = config.ai?.providers?.find((entry) => entry.id === rule.primary.providerId);
  if (provider === undefined || provider.enabled === false) {
    return { providerId: rule.primary.providerId };
  }
  const creds = providerCredentialFields(provider);
  const model = rule.primary.model ?? creds.model;
  return {
    providerId: provider.id,
    ...(creds.apiKey === undefined ? {} : { apiKey: creds.apiKey }),
    ...(creds.baseUrl === undefined ? {} : { baseUrl: creds.baseUrl }),
    ...(model === undefined ? {} : { model }),
  };
}

/**
 * Preserve per-provider apiKey when Admin PATCHes a providers list without
 * re-sending secrets (empty/omitted apiKey keeps the stored value).
 */
export function mergeAiProvidersPreservingSecrets(
  current: HelixConfig["ai"] | undefined,
  next: NonNullable<HelixConfig["ai"]> | undefined,
): HelixConfig["ai"] | undefined {
  if (next === undefined) {
    return current;
  }
  if (next.providers === undefined) {
    return next;
  }
  const priorById = new Map((current?.providers ?? []).map((provider) => [provider.id, provider]));
  const providers = next.providers.map((provider) => {
    const prior = priorById.get(provider.id);
    const nextCfg = { ...(provider.config ?? {}) };
    const nextKey = typeof nextCfg.apiKey === "string" ? nextCfg.apiKey.trim() : "";
    if (nextKey.length === 0) {
      delete nextCfg.apiKey;
      const priorKey = prior?.config?.apiKey;
      if (typeof priorKey === "string" && priorKey.trim().length > 0) {
        nextCfg.apiKey = priorKey;
      }
    }
    delete nextCfg.apiKeyConfigured;
    return {
      ...provider,
      config: nextCfg,
    };
  });
  return { ...next, providers };
}

/** Merge operator LLM + feature routing + mail spam AI into env-style overlay. */
export function operatorAiEnvFromConfig(
  config: HelixConfig,
): Readonly<Record<string, string | undefined>> {
  const op = config.ai?.operatorLlm;
  const spam = config.ai?.mailSpamAi;
  const assistant = resolveFeatureProviderCredentials(config, "assistant.chat");
  const spamRoute = resolveFeatureProviderCredentials(config, "mail.spam-ai");
  const mailAssist = resolveFeatureProviderCredentials(config, "mail.compose-help");

  // Precedence for shared OPENAI_*: feature route for assistant.chat, then operatorLlm.
  const openAiKey = assistant.apiKey ?? op?.apiKey;
  const openAiBase = assistant.baseUrl ?? op?.baseUrl;
  const openAiModel = assistant.model ?? op?.model;

  const spamKey = spamRoute.apiKey ?? openAiKey;
  const spamBase = spamRoute.baseUrl ?? openAiBase;
  const spamModel = spamRoute.model ?? openAiModel;

  const mailKey = mailAssist.apiKey ?? openAiKey;
  const mailBase = mailAssist.baseUrl ?? openAiBase;
  const mailModel = mailAssist.model ?? openAiModel;

  return {
    ...(typeof openAiKey === "string" && openAiKey.trim().length > 0
      ? { OPENAI_API_KEY: openAiKey }
      : {}),
    ...(typeof openAiBase === "string" && openAiBase.trim().length > 0
      ? { OPENAI_BASE_URL: openAiBase }
      : {}),
    ...(typeof openAiModel === "string" && openAiModel.trim().length > 0
      ? { OPENAI_MODEL: openAiModel }
      : {}),
    ...(typeof spamKey === "string" && spamKey.trim().length > 0
      ? { MAIL_SPAM_AI_API_KEY: spamKey }
      : {}),
    ...(typeof spamBase === "string" && spamBase.trim().length > 0
      ? { MAIL_SPAM_AI_BASE_URL: spamBase }
      : {}),
    ...(typeof spamModel === "string" && spamModel.trim().length > 0
      ? { MAIL_SPAM_AI_MODEL: spamModel }
      : {}),
    ...(typeof mailKey === "string" && mailKey.trim().length > 0
      ? { MAIL_ASSIST_AI_API_KEY: mailKey }
      : {}),
    ...(typeof mailBase === "string" && mailBase.trim().length > 0
      ? { MAIL_ASSIST_AI_BASE_URL: mailBase }
      : {}),
    ...(typeof mailModel === "string" && mailModel.trim().length > 0
      ? { MAIL_ASSIST_AI_MODEL: mailModel }
      : {}),
    ...(spam?.betaEnabled === true
      ? { MAIL_SPAM_AI_BETA_ENABLED: "true" }
      : spam?.betaEnabled === false
        ? { MAIL_SPAM_AI_BETA_ENABLED: "false" }
        : {}),
  };
}

function normalizeObservabilityConfig(
  value: unknown,
  label: string,
): NonNullable<PartialHelixConfig["observability"]> {
  const parsed = observabilityConfigUpdateSchema.parse(normalizeJsonObject(value, label));
  return jsonObjectFromDefined(parsed);
}

function normalizeRecordOfJsonObjects(value: unknown, label: string): Record<string, JsonObject> {
  const object = normalizeJsonObject(value, label);
  const result: Record<string, JsonObject> = {};
  for (const [key, entry] of Object.entries(object)) {
    result[key] = normalizeJsonObject(entry, `${label}.${key}`);
  }
  return result;
}

function normalizeJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value) || !isJsonValue(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isJsonObject(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function jsonObjectFromDefined(value: unknown): JsonObject {
  const jsonValue = jsonValueFromDefined(value);
  if (!isJsonObject(jsonValue)) {
    throw new TypeError("Expected JSON object.");
  }
  return jsonValue;
}

function jsonValueFromDefined(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== undefined).map(jsonValueFromDefined);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, jsonValueFromDefined(entry)]),
    );
  }
  throw new TypeError("Expected JSON value.");
}

function readPlatformReadiness(platform: JsonObject | undefined): PlatformReadinessUpdate {
  const readiness = platform?.readiness;
  if (!isJsonObject(readiness)) {
    return {};
  }
  const parsed = platformReadinessUpdateSchema.safeParse(readiness);
  return parsed.success ? parsed.data : {};
}

function mfaRequirement(
  tier: SecurityTier,
  state: PlatformReadinessUpdate["mfa"],
): PlatformReadinessRequirement {
  const requiredScope = tier === "personal" ? "none" : tier === "business" ? "admins" : "org";
  const required = requiredScope !== "none";
  const observedScope = state?.scope ?? "none";
  const ready = required
    ? mfaScopeRank(observedScope) >= mfaScopeRank(requiredScope) && isReady(state)
    : isReady(state);
  return {
    key: "mfa",
    label: "MFA",
    required,
    status: requirementStatus(required, ready, state?.status),
    expected: { scope: requiredScope },
    observed: compactJsonObject({
      enabled: state?.enabled ?? false,
      scope: observedScope,
      status: state?.status ?? "unknown",
    }),
  };
}

function encryptedBackupsRequirement(
  tier: SecurityTier,
  state: PlatformReadinessUpdate["encryptedBackups"],
): PlatformReadinessRequirement {
  const required = tier !== "personal";
  const ready =
    isReady(state) && (state?.lastSuccessfulBackupAt !== undefined || state?.status === "ready");
  return {
    key: "encryptedBackups",
    label: "Encrypted backups",
    required,
    status: requirementStatus(required, ready, state?.status),
    expected: { encrypted: required, successfulBackupRequired: required },
    observed: compactJsonObject({
      enabled: state?.enabled ?? false,
      status: state?.status ?? "unknown",
      lastSuccessfulBackupAt: state?.lastSuccessfulBackupAt,
    }),
  };
}

function auditDestinationsRequirement(
  requiredDestinations: TierSecurityDefaults["auditDestinations"],
  state: PlatformReadinessUpdate["auditDestinations"],
): PlatformReadinessRequirement {
  const observedDestinations = new Set(["postgres", ...(state?.destinations ?? [])]);
  const missing = requiredDestinations.filter(
    (destination) => !observedDestinations.has(destination),
  );
  return {
    key: "auditDestinations",
    label: "Audit destinations",
    required: true,
    status: missing.length === 0 ? "ready" : state?.status === "degraded" ? "degraded" : "missing",
    expected: { destinations: [...requiredDestinations] },
    observed: compactJsonObject({
      destinations: [...observedDestinations],
      status: state?.status ?? (missing.length === 0 ? "ready" : "missing"),
    }),
    ...(missing.length === 0 ? {} : { missing }),
  };
}

function serviceRequirement(
  key: "vault" | "spire" | "siem" | "cloudNativePg",
  label: string,
  required: boolean,
  state: PlatformReadinessUpdate[typeof key],
): PlatformReadinessRequirement {
  const ready = isReady(state);
  return {
    key,
    label,
    required,
    status: requirementStatus(required, ready, state?.status),
    expected: { running: required },
    observed: compactJsonObject({
      enabled: state?.enabled ?? false,
      endpoint: state?.endpoint,
      evidence: state?.evidence,
      status: state?.status ?? "unknown",
    }),
  };
}

function fipsRequirement(
  tier: SecurityTier,
  state: PlatformReadinessUpdate["fips"],
): PlatformReadinessRequirement {
  const required = tier === "sovereign";
  const ready = isReady(state) && state?.mode === "required" && state.runtimeAttestation === true;
  const missing = missingFields([
    ["mode", state?.mode === "required"],
    ["runtimeAttestation", state?.runtimeAttestation === true],
    ["status", isReady(state)],
  ]);
  return {
    key: "fips",
    label: "FIPS crypto",
    required,
    status: requirementStatus(required, ready, state?.status),
    expected: { mode: "required", runtimeAttestation: true },
    observed: compactJsonObject({
      enabled: state?.enabled ?? false,
      mode: state?.mode,
      cryptoAdapter: state?.cryptoAdapter,
      runtimeAttestation: state?.runtimeAttestation,
      status: state?.status ?? "unknown",
    }),
    ...(required && missing.length > 0 ? { missing } : {}),
  };
}

function stigImagePolicyRequirement(
  tier: SecurityTier,
  state: PlatformReadinessUpdate["stigImagePolicy"],
): PlatformReadinessRequirement {
  const required = tier === "sovereign";
  const ready = isReady(state) && state?.requireDigest === true && state.requireSignature === true;
  const missing = missingFields([
    ["requireDigest", state?.requireDigest === true],
    ["requireSignature", state?.requireSignature === true],
    ["status", isReady(state)],
  ]);
  return {
    key: "stigImagePolicy",
    label: "STIG image policy",
    required,
    status: requirementStatus(required, ready, state?.status),
    expected: { requireDigest: true, requireSignature: true },
    observed: compactJsonObject({
      enabled: state?.enabled ?? false,
      requireDigest: state?.requireDigest,
      requireSignature: state?.requireSignature,
      approvedBaseImages: state?.approvedBaseImages,
      status: state?.status ?? "unknown",
    }),
    ...(required && missing.length > 0 ? { missing } : {}),
  };
}

function airgapRequirement(
  tier: SecurityTier,
  state: PlatformReadinessUpdate["airgap"],
): PlatformReadinessRequirement {
  const required = tier === "sovereign";
  const ready = isReady(state) && state?.bundleMirrored === true;
  const missing = missingFields([
    ["bundleMirrored", state?.bundleMirrored === true],
    ["status", isReady(state)],
  ]);
  return {
    key: "airgap",
    label: "Airgap bundle",
    required,
    status: requirementStatus(required, ready, state?.status),
    expected: { bundleMirrored: true },
    observed: compactJsonObject({
      enabled: state?.enabled ?? false,
      bundleMirrored: state?.bundleMirrored,
      internalRegistry: state?.internalRegistry,
      status: state?.status ?? "unknown",
    }),
    ...(required && missing.length > 0 ? { missing } : {}),
  };
}

function wormRequirement(
  tier: SecurityTier,
  state: PlatformReadinessUpdate["worm"],
): PlatformReadinessRequirement {
  const required = tier === "sovereign";
  const destinations = state?.destinations ?? [];
  const ready = isReady(state) && state?.retentionLocked === true && destinations.includes("worm");
  const missing = missingFields([
    ["retentionLocked", state?.retentionLocked === true],
    ["destinations", destinations.includes("worm")],
    ["status", isReady(state)],
  ]);
  return {
    key: "worm",
    label: "WORM retention",
    required,
    status: requirementStatus(required, ready, state?.status),
    expected: { retentionLocked: true, destinations: ["worm"] },
    observed: compactJsonObject({
      enabled: state?.enabled ?? false,
      retentionLocked: state?.retentionLocked,
      destinations,
      status: state?.status ?? "unknown",
    }),
    ...(required && missing.length > 0 ? { missing } : {}),
  };
}

function cacPivRequirement(
  tier: SecurityTier,
  state: PlatformReadinessUpdate["cacPiv"],
): PlatformReadinessRequirement {
  const required = tier === "sovereign";
  const observedScope = state?.scope ?? "none";
  const ready = isReady(state) && mfaScopeRank(observedScope) >= mfaScopeRank("org");
  const missing = missingFields([
    ["scope", mfaScopeRank(observedScope) >= mfaScopeRank("org")],
    ["status", isReady(state)],
  ]);
  return {
    key: "cacPiv",
    label: "CAC/PIV smartcard",
    required,
    status: requirementStatus(required, ready, state?.status),
    expected: { scope: "org" },
    observed: compactJsonObject({
      enabled: state?.enabled ?? false,
      scope: observedScope,
      pkcs11Provider: state?.pkcs11Provider,
      status: state?.status ?? "unknown",
    }),
    ...(required && missing.length > 0 ? { missing } : {}),
  };
}

function hsmBackupsRequirement(
  tier: SecurityTier,
  state: PlatformReadinessUpdate["hsmBackups"],
): PlatformReadinessRequirement {
  const required = tier === "sovereign";
  const hasSuccessfulBackup =
    state?.lastSuccessfulBackupAt !== undefined || state?.status === "ready";
  const ready =
    isReady(state) &&
    state?.encrypted === true &&
    state.keyProvider === "hsm" &&
    hasSuccessfulBackup;
  const missing = missingFields([
    ["encrypted", state?.encrypted === true],
    ["keyProvider", state?.keyProvider === "hsm"],
    ["lastSuccessfulBackupAt", hasSuccessfulBackup],
    ["status", isReady(state)],
  ]);
  return {
    key: "hsmBackups",
    label: "HSM-backed backups",
    required,
    status: requirementStatus(required, ready, state?.status),
    expected: { encrypted: true, keyProvider: "hsm", successfulBackupRequired: true },
    observed: compactJsonObject({
      enabled: state?.enabled ?? false,
      encrypted: state?.encrypted,
      keyProvider: state?.keyProvider,
      lastSuccessfulBackupAt: state?.lastSuccessfulBackupAt,
      status: state?.status ?? "unknown",
    }),
    ...(required && missing.length > 0 ? { missing } : {}),
  };
}

function defaultDenyEgressRequirement(
  tier: SecurityTier,
  configuredPolicy: TierSecurityDefaults["networkEgress"],
  state: PlatformReadinessUpdate["defaultDenyEgress"],
): PlatformReadinessRequirement {
  const required = tier === "sovereign";
  const observedPolicy = state?.policy ?? configuredPolicy;
  const ready = observedPolicy === "default-deny" && state?.enforced === true && isReady(state);
  const missing = missingFields([
    ["policy", observedPolicy === "default-deny"],
    ["enforced", state?.enforced === true],
    ["status", isReady(state)],
  ]);
  return {
    key: "defaultDenyEgress",
    label: "Default-deny egress",
    required,
    status: requirementStatus(required, ready, state?.status),
    expected: { policy: "default-deny", enforced: true },
    observed: compactJsonObject({
      enabled: state?.enabled,
      policy: observedPolicy,
      enforced: state?.enforced,
      status: state?.status ?? (observedPolicy === "default-deny" ? "ready" : "unknown"),
    }),
    ...(required && missing.length > 0 ? { missing } : {}),
  };
}

function requirementStatus(
  required: boolean,
  ready: boolean,
  status: string | undefined,
): PlatformReadinessRequirement["status"] {
  if (!required) {
    return ready ? "ready" : "not_required";
  }
  if (ready) {
    return "ready";
  }
  return status === "degraded" ? "degraded" : status === "unknown" ? "unknown" : "missing";
}

function isReady(
  state:
    { readonly enabled?: boolean | undefined; readonly status?: string | undefined } | undefined,
): boolean {
  return state?.status === "ready" || state?.enabled === true;
}

function mfaScopeRank(scope: "none" | "admins" | "org"): number {
  if (scope === "org") {
    return 2;
  }
  return scope === "admins" ? 1 : 0;
}

function compactJsonObject(value: Record<string, JsonValue | undefined>): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as JsonObject;
}

function missingFields(fields: readonly (readonly [string, boolean])[]): readonly string[] {
  return fields.filter(([, present]) => !present).map(([field]) => field);
}

function replaceUpdatedReadinessControls(
  current: JsonObject,
  update: PlatformReadinessUpdate,
): JsonObject {
  const next: Record<string, JsonValue> = { ...current };
  for (const [key, value] of Object.entries(update)) {
    if (value !== undefined) {
      next[key] = jsonObjectFromDefined(value);
    }
  }
  return next;
}

function actorHasScope(actor: Actor, scope: PlatformConfigAdminScope): boolean {
  const scopes = actor.scopes ?? [];
  return (
    scopes.includes(scope) ||
    scopes.includes(`${adminConfigScopePrefix}.*`) ||
    scopes.includes("admin.*")
  );
}

function permissionDeniedResponse(requiredScope: PlatformConfigAdminScope): {
  readonly error: string;
  readonly requiredScope: PlatformConfigAdminScope;
} {
  return {
    error: "Admin platform config permission denied.",
    requiredScope,
  };
}
