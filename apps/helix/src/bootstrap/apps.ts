import { type FastifyRequest } from "fastify";
import {
  toolInvocationPrincipalFromRequest,
  unauthenticatedActor,
  type SessionActorResolver,
} from "../api/actor.js";
import { envFlag, tenantRootHostFromPublicUrl } from "../bootstrap/env.js";
import {
  InMemoryAICostLimiter,
  ioredisAICostClient,
  PostgresAICostLimitStore,
  PostgresAIProvenanceStore,
  PostgresMemoryStore,
  PostgresResourceClassificationStore,
  RedisAICostLimiter,
  ResourceClassificationService,
  type AICostLimiter,
  type AICostLimitStore,
} from "../platform/ai/index.js";
import {
  createAssistantAIRouter,
  createAssistantEmbeddingProvider,
} from "../platform/ai/providers/factory.js";
import { CoreAppRegistrationPlan } from "../platform/apps/core-apps.js";
import { createBetterAuthSessionActorResolver } from "../platform/auth/better-auth.js";
import {
  PostgresRecoveryCodeBroker,
  PostgresSessionMfaAssurance,
  unverifiedMfaResolver,
  type MfaVerificationResolver,
} from "../platform/auth/mfa.js";
import {
  ChatRetentionWorker,
  PostgresChatRetentionOrganizationSource,
} from "../platform/chat/index.js";
import {
  PlatformConfigAdminService,
  PostgresPlatformConfigStore,
} from "../platform/config/admin.js";
import {
  EnvConfigSource,
  loadHelixConfig,
  PostgresOverrideConfigSource,
} from "../platform/config/loader.js";
import { evaluateTierReadiness } from "../platform/config/tier-readiness.js";
import { TenantDlpGuard } from "../platform/dlp.js";
import { meetSecrets } from "../platform/meet/index.js";
import {
  assertActorMatchesRequestTenant,
  assertDeploymentResidency,
  assertRegionalDatabase,
  installTenantContextHook,
  installTenantPostgresContextHook,
  isLongLivedTenantRequest,
  resolveTenantContext,
  setTenantPostgresActorId,
  withTenantPostgresContext,
} from "../platform/tenancy/index.js";
import type { installAuth } from "./auth.js";
import { verifyDefaultOrgAtBoot } from "./default-org.js";
import { CredentialAuthError, installTenantApiRpsLimitHook } from "./request-principal.js";

export async function installApps(context: Awaited<ReturnType<typeof installAuth>>) {
  const {
    bootEnv,
    app,
    metrics,
    sql,
    redis,
    tenantApiRpsLimiter,
    oauthStore,
    agentCredentialStore,
    betterAuthConfig,
    betterAuthRuntime,
    orgStore,
    domainsStore,
    securityPoliciesStore,
    planStore,
    defaultOrg,
    auditStore,
    eventBus,
    chatStore,
    meteringClient,
    betterAuthPlatform,
    sessionPolicyAuthorizer,
  } = context;
  const platformConfigStore = new PostgresPlatformConfigStore(sql);

  const platformConfig = new PlatformConfigAdminService(platformConfigStore, process.env, eventBus);

  // P2-4: the same config source list backs both the initial load and the
  // runtime hot-reload, so a NATS-published change re-merges env + Postgres
  // overrides identically.
  const configSources = [
    new EnvConfigSource(process.env),
    new PostgresOverrideConfigSource(platformConfigStore),
  ];

  // `runtimeConfiguration.current` is a mutable holder: the hot-reload subscription swaps in a
  // freshly merged config so runtime readers (observability, readiness probes)
  // see config changes without a restart.
  const runtimeConfiguration = { current: await loadHelixConfig(configSources) };

  assertDeploymentResidency({
    region: bootEnv.HELIX_REGION,
    storageRegion: bootEnv.RUSTFS_REGION,
    production: bootEnv.NODE_ENV === "production",
    storageKmsKeyId: bootEnv.RUSTFS_SSE_KMS_KEY_ID,
    mailKmsKeyId: bootEnv.MAIL_DKIM_KMS_KEY_ID,
    mailKmsRegion: bootEnv.MAIL_DKIM_KMS_REGION,
    searchIndexUid: bootEnv.MEILI_INDEX_UID ?? bootEnv.MEILISEARCH_INDEX_UID,
    ollamaUrl: bootEnv.OLLAMA_BASE_URL,
    openAiApiKey: bootEnv.OPENAI_API_KEY,
    telemetryEnabled: runtimeConfiguration.current.observability?.enabled === true,
    telemetryRegion: bootEnv.HELIX_OTEL_REGION,
    auditRegion: envFlag("AUDIT_IMMUTABLE_S3_ENABLED", false)
      ? (bootEnv.AUDIT_IMMUTABLE_S3_REGION ?? "us-east-1")
      : undefined,
    siemEnabled: envFlag("AUDIT_SIEM_SYSLOG_ENABLED", false),
    siemRegion: bootEnv.HELIX_SIEM_REGION,
    meetConfigured:
      bootEnv.MEET_JITSI_PUBLIC_URL !== undefined || bootEnv.MEET_JITSI_DOMAIN !== undefined,
    meetRegion: bootEnv.MEET_JITSI_REGION,
    ai: runtimeConfiguration.current.ai,
  });

  if (bootEnv.HELIX_REGION !== "default") {
    await assertRegionalDatabase(sql, bootEnv.HELIX_REGION);
  }

  const { applyOperatorAiFromHelixConfig } = await import("../platform/ai/operator-settings.js");

  applyOperatorAiFromHelixConfig(runtimeConfiguration.current);

  await verifyDefaultOrgAtBoot({
    config: runtimeConfiguration.current,
    orgs: orgStore,
    defaultOrg,
    logger: app.log,
  });

  const configuredTenantRootHosts =
    bootEnv.HELIX_TENANT_ROOT_HOSTS?.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0) ??
    tenantRootHostFromPublicUrl(
      bootEnv.HELIX_PUBLIC_URL ?? bootEnv.PUBLIC_BASE_URL ?? bootEnv.BETTER_AUTH_URL,
    );

  const resolveTenantForRequest = (request: Pick<FastifyRequest, "headers" | "url" | "method">) =>
    resolveTenantContext({
      config: runtimeConfiguration.current,
      orgs: orgStore,
      plans: planStore,
      request,
      defaultOrg,
      rootHosts: configuredTenantRootHosts,
      domains: {
        async findVerifiedOrgId(hostname) {
          return (await domainsStore.findVerifiedDomain(hostname))?.orgId ?? null;
        },
      },
      ...(bootEnv.HELIX_REGION === "default" ? {} : { deploymentRegion: bootEnv.HELIX_REGION }),
      ...(bootEnv.HELIX_TENANT_PROXY_SECRET === undefined
        ? {}
        : { proxyAssertion: { secret: bootEnv.HELIX_TENANT_PROXY_SECRET } }),
    });

  installTenantContextHook(app, {
    resolveTenantContext: (request) => resolveTenantForRequest(request),
  });

  installTenantPostgresContextHook(app, sql);

  installTenantApiRpsLimitHook(app, {
    limiter: tenantApiRpsLimiter,
    events: eventBus,
    onQuotaEventError: (error: unknown) => {
      app.log.error({ error }, "Tenant API RPS quota event emission failed");
    },
  });

  const sessionActorResolver: SessionActorResolver | undefined =
    betterAuthRuntime === undefined
      ? undefined
      : {
          resolve: createBetterAuthSessionActorResolver(
            betterAuthPlatform,
            betterAuthRuntime.sessionVerifier,
            {
              resolveOrgId: async (request) =>
                (
                  await resolveTenantForRequest({
                    headers: request.headers,
                    method: request.method ?? "GET",
                    url: request.url ?? "/",
                  })
                ).orgId,
              policyAuthorizer: sessionPolicyAuthorizer,
            },
          ),
        };

  // PRD §9.2: resolve the request actor, trying API-key / mTLS credential
  // authentication first so the per-credential policy (IP allowlist,
  // allowed-hours, expiry, revocation) is enforced on every authenticated
  // surface. A presented-but-rejected credential raises `CredentialAuthError`,
  // which the error handler maps to the appropriate 401/403 response. When no
  // credential is presented, falls back to bearer access tokens and sessions.
  const resolvePrincipalFromAuthenticatedRequest = async (request: FastifyRequest) => {
    const resolution = await toolInvocationPrincipalFromRequest(
      request,
      oauthStore,
      sessionActorResolver,
      agentCredentialStore,
    );
    if (!resolution.ok) {
      throw new CredentialAuthError(resolution.statusCode, resolution.code, resolution.message);
    }
    assertActorMatchesRequestTenant(request, resolution.principal.actor);
    if (resolution.principal.actor.id !== unauthenticatedActor.id)
      await setTenantPostgresActorId(resolution.principal.actor.id);
    return resolution.principal;
  };

  const principalFromAuthenticatedRequest = (request: FastifyRequest) =>
    request.tenant !== null && isLongLivedTenantRequest(request)
      ? withTenantPostgresContext(sql, { orgId: request.tenant.orgId }, () =>
          resolvePrincipalFromAuthenticatedRequest(request),
        )
      : resolvePrincipalFromAuthenticatedRequest(request);

  const actorFromAuthenticatedRequest = async (request: FastifyRequest) =>
    (await principalFromAuthenticatedRequest(request)).actor;

  // Confirmed Helix architecture model: core apps (mail, chat, drive,
  // calendar, meet, assistant) are toggleable platform modules — not plugins.
  // The registration plan resolves, once at startup, which core-app modules
  // this process registers. Two switches gate registration:
  //  - org-admin global enablement (`config.modules[appId].enabled`, default
  //    on) — persisted via the platform-config admin API;
  //  - role-based boot (`HELIX_ROLE` / `HELIX_APPS`) — lets the SAME image be
  //    booted as a subset role (e.g. `HELIX_APPS=chat,meet`) so WS-heavy apps
  //    can run as their own k8s Deployment.
  // Every `register<App>...` call below is invoked conditionally on
  // `coreApps.shouldRegister(appId)`, so a disabled (or out-of-role) app is
  // not registered or served at all.
  const coreApps = new CoreAppRegistrationPlan({
    ...(runtimeConfiguration.current.modules === undefined
      ? {}
      : { modules: runtimeConfiguration.current.modules }),
    ...(bootEnv.HELIX_ROLE === undefined ? {} : { role: bootEnv.HELIX_ROLE }),
    ...(bootEnv.HELIX_APPS === undefined ? {} : { apps: bootEnv.HELIX_APPS }),
  });

  const configuredMeetSecrets = coreApps.shouldRegister("meet") ? meetSecrets(bootEnv) : null;

  app.log.info(
    {
      role: coreApps.role,
      registeredApps: coreApps.registeredAppIds(),
    },
    "Resolved core-app registration plan",
  );

  const chatRetentionWorker = coreApps.shouldRegister("chat")
    ? new ChatRetentionWorker({
        store: chatStore,
        organizations: new PostgresChatRetentionOrganizationSource(sql),
        onResult: (result) => {
          if (result.tombstonedMessages > 0 || result.saturatedOrganizations.length > 0) {
            app.log.info(result, "Chat retention sweep completed");
          }
        },
        onError: (error) => {
          app.log.error({ error }, "Chat retention sweep failed");
        },
      })
    : undefined;

  const aiProvenance = new PostgresAIProvenanceStore(sql);

  // P0-6: durable, replica-shared resource classification tags. The Postgres
  // store replaces the restart-volatile in-memory store; derivation applies
  // the PRD §8.4 label/folder/heuristic rules and persists the result.
  const resourceClassificationStore = new PostgresResourceClassificationStore(sql);

  const resourceClassificationService = new ResourceClassificationService(
    resourceClassificationStore,
  );

  const dlp = new TenantDlpGuard(securityPoliciesStore, resourceClassificationService, auditStore);

  const assistantMemory = new PostgresMemoryStore(sql, {
    embeddingProvider: createAssistantEmbeddingProvider(runtimeConfiguration.current.ai),
    defaultSource: "assistant.conversation",
  });

  const securityTier = runtimeConfiguration.current.security.tier;

  // P2-1: startup tier-hardening readiness check. For the configured tier,
  // verify the required controls are satisfiable; fail closed when a required
  // in-app-enforceable control (Tier 2+ audit shipping, Tier 3 Vault/SIEM) is
  // missing, and emit explicit warnings for controls that genuinely cannot be
  // verified in-app (internal mTLS, encryption at rest). Tier 1 never blocks.
  const tierReadiness = evaluateTierReadiness(securityTier, process.env);

  for (const warning of tierReadiness.warnings) {
    app.log.warn(
      { tier: tierReadiness.tier, control: warning.control },
      `Tier control cannot be verified in-app: ${warning.detail}`,
    );
  }

  if (!tierReadiness.ok) {
    for (const failure of tierReadiness.failures) {
      app.log.error(
        { tier: tierReadiness.tier, control: failure.control },
        `Tier control unsatisfied: ${failure.detail}`,
      );
    }
    throw new Error(
      `Tier '${tierReadiness.tier}' readiness check failed: ${tierReadiness.failures
        .map((failure) => failure.control)
        .join(", ")}. Resolve the controls above.`,
    );
  }

  // P2-1: MFA-required-for-admins enforcement. On tiers that require admin MFA
  // (Tier 2+), admin-scoped requests from an actor without a verified MFA
  // factor are rejected before the route handler runs.
  const mfaAssurance =
    betterAuthRuntime === undefined || betterAuthConfig === undefined
      ? undefined
      : new PostgresSessionMfaAssurance(
          sql,
          betterAuthRuntime.sessionVerifier,
          betterAuthConfig.baseUrl,
        );

  const mfaResolver: MfaVerificationResolver = mfaAssurance ?? unverifiedMfaResolver;

  const recoveryCodes =
    betterAuthConfig === undefined
      ? undefined
      : new PostgresRecoveryCodeBroker(sql, betterAuthConfig.secret);

  // Production has already failed closed without Redis; local development may
  // explicitly use the process-local limiter.
  const aiCostLimiter: AICostLimiter =
    redis === undefined
      ? new InMemoryAICostLimiter()
      : new RedisAICostLimiter(ioredisAICostClient(redis));

  // Per-user AI cost limit overrides (TASK-217 "limit" half). The admin API
  // and UI read/write these; tier defaults apply when no override exists.
  const aiCostLimitStore: AICostLimitStore = new PostgresAICostLimitStore(sql);

  const assistantAi = createAssistantAIRouter(aiProvenance, {
    costLimiter: aiCostLimiter,
    metering: meteringClient,
    metrics,
    securityTier,
    onMeteringError: (error: unknown) => {
      app.log.error({ error }, "AI token metering emission failed");
    },
    // P0-7: emit the 80%-budget warning notification that was previously
    // computed and discarded.
    onCostWarning: (event) => {
      eventBus
        .publish("platform.ai_cost.warning", {
          orgId: event.actor.orgId,
          actorId: event.actor.id,
          feature: event.feature,
          providerId: event.providerId,
          model: event.model,
          actorDailyUsedUsdMicros: event.result.usage.actorDaily.usedUsdMicros,
          actorDailyLimitUsdMicros: event.result.usage.actorDaily.limitUsdMicros,
          featureDailyUsedUsdMicros: event.result.usage.featureDaily.usedUsdMicros,
          featureDailyLimitUsdMicros: event.result.usage.featureDaily.limitUsdMicros,
          warningThresholdRatio: 0.8,
          occurredAt: event.result.record.occurredAt,
        })
        .catch((error: unknown) => {
          app.log.error({ error }, "Failed to publish AI cost budget warning notification");
        });
    },
    ...(runtimeConfiguration.current.ai === undefined
      ? {}
      : { aiConfig: runtimeConfiguration.current.ai }),
  });
  return {
    ...context,
    platformConfig,
    configSources,
    runtimeConfiguration,
    applyOperatorAiFromHelixConfig,
    sessionActorResolver,
    principalFromAuthenticatedRequest,
    actorFromAuthenticatedRequest,
    coreApps,
    configuredMeetSecrets,
    chatRetentionWorker,
    resourceClassificationService,
    dlp,
    assistantMemory,
    securityTier,
    mfaAssurance,
    mfaResolver,
    recoveryCodes,
    aiCostLimitStore,
    assistantAi,
  };
}
