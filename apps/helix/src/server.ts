import { KMSClient } from "@aws-sdk/client-kms";
import cors from "@fastify/cors";
import { resolveTxt } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readDomainsWithRecords } from "./platform/admin/domains.js";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import { ContractValidationError } from "@helix/contracts";
import { createMeteringClient } from "@helix/sdk";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { fromNodeHeaders } from "better-auth/node";
import fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import { Redis } from "ioredis";
import { z, ZodError } from "zod";
import {
  systemActor,
  toolInvocationPrincipalFromRequest,
  unauthenticatedActor,
  untrustedIdentityHeader,
  type SessionActorResolver,
} from "./api/actor.js";
import { ApiError, ForbiddenError, NotFoundError } from "./api/api-error.js";
import { buildAsyncApiDocument } from "./api/asyncapi.js";
import { createResourceClassifier } from "./api/classify-resource.js";
import { trustedProxyAddresses } from "./api/client-ip.js";
import { buildErrorEnvelope, toolErrorEnvelope } from "./api/error-envelope.js";
import {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  fingerprintRequestPayload,
  idempotencyStorageKey,
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
  resolveIdempotency,
  type IdempotencyStore,
} from "./api/idempotency.js";
import { createStoreBackedMcpResourceProvider } from "./api/mcp-resources.js";
import { formatSseEvent, handleMcpJsonRpcRequest, handleMcpStreamingRequest } from "./api/mcp.js";
import { createPlatformMetrics, installHttpMetrics } from "./api/metrics.js";
import { buildOpenApiDocument, openApiDocumentToYaml } from "./api/openapi.js";
import {
  API_BODY_LIMIT_BYTES,
  API_REQUEST_TIMEOUT_MS,
  WEBSOCKET_MAX_PAYLOAD_BYTES,
} from "./api/request-body.js";
import { requireActorScope } from "./api/scopes.js";
import { projectToolListItem } from "./api/tool-projection.js";
import { createRequestContext } from "./api/trace.js";
import { createHelixTRPCRouter } from "./api/trpc.js";
import {
  HELIX_API_VERSION_HEADER_VALUE,
  HELIX_API_VERSION_PREFIX,
  HELIX_SERVER_VERSION,
  internalApiUrl,
} from "./api/version.js";
import { env } from "./config/env.js";
import { resolveRedisConnection } from "./config/redis-connection.js";
import {
  assertTenantRlsCoverage,
  assertTenantSafeDatabaseRole,
  createSqlClient,
} from "./db/client.js";
import { listPendingMigrations } from "./db/migration-runner.js";
import { resolvePlatformMigrationSources } from "./db/migration-sources.js";
import { resolveAiEnv } from "./platform/ai/operator-settings.js";
import { OAuthTokenService } from "./platform/auth/oauth.js";
import { createOutboundHttpClient } from "./platform/outbound-http.js";
import { helixLoggerOptions } from "./platform/security/logger-redaction.js";
import { parseTrustedOrigins } from "./platform/security/origin-policy.js";
import { registerAdminIdentityRoutes } from "./platform/admin/identity.js";
import { registerAdminScimCredentialRoutes } from "./platform/admin/scim-credentials.js";
import { PostgresAdminServiceStatusStore } from "./platform/admin/service-status.js";
import { AdminServicesCatalog, registerAdminServicesRoutes } from "./platform/admin/services.js";
import {
  actorExistsInOrg,
  disableActorForOffboard,
  PostgresAdminUsersStore,
  registerAdminUsersRoutes,
  revokeSessionsForActorSql,
} from "./platform/auth/admin-users.js";
import {
  PostgresAppPasswordStore,
  registerAppPasswordTools,
} from "./platform/auth/app-passwords.js";
import { AuthorizationCodeService } from "./platform/auth/authorization-code.js";
import { PostgresOAuthAuthorizationStore } from "./platform/auth/authorization-store.js";
import {
  PostgresAgentCredentialStore,
  PostgresAuthorizationCodeStore,
  PostgresOAuthStore,
} from "./platform/auth/postgres-store.js";
import { registerOAuthRoutes } from "./platform/auth/routes.js";
import { PostgresTenantScimCredentialStore } from "./platform/auth/scim-credentials.js";
import { PostgresScimProvisioningStore } from "./platform/auth/scim-provisioning.js";
import { registerTenantScimRoutes } from "./platform/auth/scim-routes.js";
import { resolveTenantOidcPrivateKey, resolveTenantOidcUser } from "./platform/auth/sso-runtime.js";
import { PostgresTenantIdpConfigStore } from "./platform/auth/tenant-idp-configs.js";
import {
  toolInvocationOptions,
  type ToolInvocationPrincipal,
} from "./platform/auth/tool-invocation-principal.js";
import {
  agentCredentialScopeCatalog,
  registerAgentCredentialTools,
} from "./platform/auth/tools.js";
import { PostgresBillingStore, registerAdminBillingRoutes } from "./platform/admin/billing.js";
import { AuthoritativeDnsResolver } from "./platform/admin/dns-resolver.js";
import { PostgresDomainsStore, registerAdminDomainsRoutes } from "./platform/admin/domains.js";
import { PostgresGroupsStore, registerAdminGroupsRoutes } from "./platform/admin/groups.js";
import {
  PostgresOAuthAppsStore,
  registerAdminOAuthAppsRoutes,
} from "./platform/admin/oauth-apps.js";
import {
  PostgresSecurityPoliciesStore,
  readSecurityPolicies,
  registerAdminSecurityPoliciesRoutes,
} from "./platform/admin/security-policies.js";
import { registerTenantConfigAdminRoutes } from "./platform/admin/tenant-config.js";
import {
  AIRouter,
  createAICostGuard,
  createAnthropicCompatibleProvider,
  createBedrockCredentialProvider,
  createBedrockProvider,
  createConfiguredVectorStore,
  createOpenAICompatibleEmbeddingProvider,
  createOpenAICompatibleProvider,
  createVertexProvider,
  deriveClassification,
  EnrichmentWorker,
  InMemoryAICostLimiter,
  ioredisAICostClient,
  PostgresAICostLimitStore,
  PostgresAIProvenanceStore,
  PostgresMemoryStore,
  PostgresResourceClassificationStore,
  RedisAICostLimiter,
  registerAICostLimitAdminRoutes,
  ResourceClassificationService,
  type AICostLimiter,
  type AICostLimitStore,
  type AICostWarningEvent,
  type BedrockCredentialSource,
  type MemoryEmbeddingProvider,
  type VertexCredentials,
} from "./platform/ai/index.js";
import {
  AssistantOrchestrator,
  AssistantSlashCommandHooks,
  PostgresAssistantStore,
  registerAssistantTools,
  type AssistantSendMessageInput,
  type AssistantStreamEvent,
} from "./platform/assistant/index.js";
import {
  createAuditDestinationShipper,
  type AuditDestinationConfig,
} from "./platform/audit/destinations.js";
import {
  createHmacAuditAnchorAuthenticator,
  createStorageClientImmutableAuditStore,
  type ImmutableAuditObjectLockMode,
} from "./platform/audit/immutable-s3.js";
import { registerAuditLogAdminRoutes } from "./platform/audit/routes.js";
import { AuditShippingWorker } from "./platform/audit/shipping-worker.js";
import type { SiemAuditFormat } from "./platform/audit/siem-format.js";
import type { SiemSyslogTransport } from "./platform/audit/siem-syslog.js";
import { PostgresAuditStore } from "./platform/audit/store.js";
import { AuditVerifierWorker, PostgresAuditVerifierLease } from "./platform/audit/worker.js";
import {
  createBetterAuthPlatformModule,
  createBetterAuthRuntime,
  createBetterAuthSessionActorResolver,
  PostgresBetterAuthActorStore,
  PostgresBetterAuthSessionIssuer,
  PostgresBetterAuthSessionPolicyAuthorizer,
  type BetterAuthInstance,
  type BetterAuthSessionVerifier,
} from "./platform/auth/better-auth.js";
import {
  browserSecurityHeaders,
  createCsrfToken,
  csrfTokenFromCookie,
  isTrustedCookieMutation,
  isTrustedCorsOrigin,
  normalizeTrustedOrigins,
  serializeCsrfCookie,
} from "./platform/auth/browser-security.js";
import {
  registerBackupAdminRoutes,
  ScriptedBackupAdminService,
} from "./platform/backup/admin-routes.js";
import { PostgresRestoreJobStore, RestoreJobWorker } from "./platform/backup/restore-jobs.js";
import {
  CalendarInvitationDeliveryWorker,
  createMailCalendarInvitationSender,
  PostgresCalendarInvitationDeliveryStore,
  PostgresCalendarSchedulingStore,
  PostgresCalendarStore,
  registerCalendarIndexer,
  registerCalendarRoutes,
  registerCalendarSchedulingRoutes,
  registerCalendarTools,
} from "./platform/calendar/index.js";
import {
  PostgresCardDavContactStore,
  PostgresPeopleStore,
  registerCardDavIndexer,
  registerCardDavRoutes,
  registerPeopleRoutes,
} from "./platform/carddav/index.js";
import {
  ChatRetentionWorker,
  createChatNatsSecurityPolicy,
  EventBusChatRoomBus,
  InMemoryChatPresenceStore,
  PostgresChatAttachmentStore,
  PostgresChatModerationStore,
  PostgresChatRetentionOrganizationSource,
  PostgresChatRoomEventLog,
  PostgresChatStore,
  PostgresChatWebSocketTicketStore,
  RedisChatPresenceStore,
  registerChatEnrichments,
  registerChatIndexer,
  registerChatModerationRoutes,
  registerChatRoutes,
  registerChatTools,
} from "./platform/chat/index.js";
import { dlpDecisionError, TenantDlpGuard } from "./platform/dlp.js";
import { loadDriveConfig } from "./platform/drive/config.js";
import {
  createClamAvVirusScanner,
  DriveVirusScanRetryWorker,
  PostgresDriveStore,
  PostgresDriveWorkflowStore,
  registerDriveEnrichments,
  registerDriveIndexer,
  registerDriveRoutes,
  registerDriveScanAdminRoutes,
  registerDriveShareLinkRoute,
  registerDriveTools,
  safeDriveContentHeaders,
  sendStreamWithRangeSupport,
} from "./platform/drive/index.js";
import { InMemoryEventBus } from "./platform/events/in-memory-event-bus.js";
import { NatsEventBus } from "./platform/events/nats-event-bus.js";
import { registerEventRoutes } from "./platform/events/routes.js";
import { createEventSchemaRegistry } from "./platform/events/schema-registry.js";
import { EventStreamLimiter } from "./platform/events/stream-limit.js";
import { PostgresGovernanceStore, registerGovernanceRoutes } from "./platform/governance/index.js";
import {
  LeaderElection,
  PostgresAdvisoryLockClient,
  SingletonWorkerSupervisor,
  type SupervisedWorker,
} from "./platform/leader/election.js";
import { mailConfig } from "./platform/mail/config.js";
import {
  ClamavScanner,
  createBetaSpamSecondPass,
  DispatchTimeTransportResolver,
  KmsDkimPrivateKeyProtector,
  MailAdminStatusService,
  MailAttachmentCleanupWorker,
  MailDeliveryAlertMonitor,
  MailDeliveryError,
  MailTrashPurgeWorker,
  NodemailerMailTransport,
  OutboundMailDispatcher,
  OutboundMailWorker,
  parseInboundAuthenticationPolicy,
  PostgresMailAttachmentIngestor,
  PostgresMailDeliveryEventStore,
  PostgresMailDkimKeyStore,
  PostgresMailDmarcReportStore,
  PostgresMailQuarantineStore,
  PostgresMailRoutingRuleStore,
  PostgresMailStore,
  PostgresMailTrashPurger,
  PostgresOutboundProviderStore,
  registerMailAdminRoutes,
  registerMailDeliveryAdminRoutes,
  registerMailDeliveryEventAdminRoutes,
  registerMailDeliveryEventRoutes,
  registerMailEnrichments,
  registerMailIndexer,
  registerMailProviderWebhookRoutes,
  registerMailQuarantineAdminRoutes,
  registerMailSourceRoutes,
  registerMailStreamRoutes,
  registerMailTools,
  registerOutboundMailAdminRoutes,
  SmtpMailReceiver,
  SmtpSubmissionServer,
  SpamdScanner,
} from "./platform/mail/index.js";
import {
  createJibriRecorderHealthCheck,
  MeetLifecycleWorker,
  meetSecrets,
  PostgresMeetStore,
  registerMeetRoutes,
  registerMeetTools,
} from "./platform/meet/index.js";
import {
  MeteringIngestWorker,
  MeteringRollupWorker,
  PostgresMeteringEventStore,
  PostgresMeteringRollupStore,
} from "./platform/metering/index.js";
import {
  PostgresNotificationStore,
  registerNotificationTools,
} from "./platform/notifications/index.js";
import { PendingActionExpiryWorker } from "./platform/tools/pending-action-expiry-worker.js";
import type {
  Actor,
  AiConfig,
  AiProviderConfig,
  ChatRequest,
  ChatResponse,
  EventBus,
  HelixConfig,
  JsonObject,
  LLMProviderCapability,
  MeteringClient,
  ModelInfo,
  SecurityTier,
} from "@helix/sdk-types";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import type { PlatformMetrics } from "./api/metrics.js";
import { registerAdminOverviewRoutes } from "./platform/admin/overview.js";
import { evaluateOrgAdminMfa } from "./platform/admin/security-policy-runtime.js";
import {
  buildCoreAppsAdminStatus,
  registerCoreAppsAdminRoutes,
} from "./platform/apps/admin-routes.js";
import { CoreAppRegistrationPlan, resolveCoreAppStatuses } from "./platform/apps/core-apps.js";
import { enforceCredentialPolicy, type AgentCredentialStore } from "./platform/auth/credentials.js";
import {
  installCrownJewelGate,
  PostgresCrownJewelApprovalStore,
  requestHasCrownJewelApproval,
} from "./platform/auth/crown-jewel.js";
import {
  PostgresDomainIdentityStore,
  registerDomainIdentityDiscoveryRoute,
} from "./platform/auth/domain-identity.js";
import {
  authResponseSessionToken,
  PostgresRecoveryCodeBroker,
  PostgresSessionMfaAssurance,
  recoveryCodeDigest,
  unverifiedMfaResolver,
  verifiedMfaSessionToken,
  type MfaAssuranceMarker,
  type MfaVerificationResolver,
} from "./platform/auth/mfa.js";
import type { AccessTokenStore } from "./platform/auth/oauth.js";
import {
  PlatformConfigAdminService,
  PostgresPlatformConfigStore,
  registerPlatformConfigAdminRoutes,
} from "./platform/config/admin.js";
import {
  EnvConfigSource,
  loadHelixConfig,
  PostgresOverrideConfigSource,
  subscribeToConfigHotReload,
} from "./platform/config/loader.js";
import { evaluateTierReadiness } from "./platform/config/tier-readiness.js";
import { tierDefaults } from "./platform/config/tier.js";
import { loadConnectors, registerConnectorsAdminRoute } from "./platform/connectors/index.js";
import { TenantConfigFeatureFlagProvider } from "./platform/feature-flags/provider.js";
import {
  ReadinessMonitor,
  registerHealthRoutes,
  type ReadinessProbe,
} from "./platform/health/readiness.js";
import {
  InMemoryAgentRateCostLimiter,
  InMemoryTenantApiRpsLimiter,
  InMemoryTenantHourlyQuotaLimiter,
  RedisAgentRateCostLimiter,
  RedisTenantApiRpsLimiter,
  RedisTenantHourlyQuotaLimiter,
  type AgentLimitBudget,
  type TenantApiRpsLimiter,
  type TenantHourlyQuotaLimiter,
} from "./platform/limits/index.js";
import { MailProviderConfigurationError } from "./platform/mail/errors.js";
import { isSaas } from "./platform/mode/index.js";
import { OutboxWorker } from "./platform/outbox/outbox.js";
import { PostgresOutboxStore } from "./platform/outbox/postgres-store.js";
import {
  CerbosToolAccessPolicy,
  ObservedToolAccessPolicy,
  ScopeToolAccessPolicy,
} from "./platform/permissions/tool-access.js";
import { registerPluginAdminRoutes } from "./platform/plugins/admin-routes.js";
import {
  PluginLifecycle,
  PostgresPluginLifecycleStore,
  registerPluginTools,
} from "./platform/plugins/tools.js";
import { loadPluginTrustFile } from "./platform/plugins/trust.js";
import {
  authorizeWorkspaceSearchHit,
  AuthorizingSearchEngine,
  createMeilisearchHttpClient,
  createPostgresSearchReindexSources,
  MeilisearchSearchEngine,
  PostgresSearchDurabilityStore,
  PostgresSearchReindexJobService,
  registerSearchAdminRoutes,
  registerSearchTools,
  SearchEventIndexer,
  SearchMutationWorker,
  SearchReconciliationWorker,
  SearchReindexService,
  SearchShadowReindexWorker,
  SemanticSearchEngine,
} from "./platform/search/index.js";
import type { GlobalSearchType } from "./platform/search/scope.js";
import {
  createVaultTenantSecretReaderFromEnv,
  TenantEnvelopeCipher,
} from "./platform/secrets/index.js";
import {
  InMemorySignupAbuseProtector,
  ioredisSignupRateLimitClient,
  parseBlockedSignupEmailDomains,
  RedisSignupAbuseProtector,
} from "./platform/signup/abuse.js";
import {
  SignupOnboardingInviteEmailWorker,
  SignupVerificationEmailWorker,
} from "./platform/signup/email-delivery.js";
import { signupEventSchemas } from "./platform/signup/event-schemas.js";
import { PostgresSignupOnboardingInviteTokenStore } from "./platform/signup/invites.js";
import { PostgresSignupOnboardingStore } from "./platform/signup/onboarding.js";
import {
  DefaultSignupPasswordScreener,
  HaveIBeenPwnedPasswordChecker,
} from "./platform/signup/password-screening.js";
import { GoogleRecaptchaVerifier } from "./platform/signup/recaptcha.js";
import {
  ConfiguredCountrySignupRiskReviewer,
  parseSignupManualReviewCountries,
} from "./platform/signup/risk-review.js";
import { registerSignupRoutesForMode } from "./platform/signup/routes.js";
import {
  PostgresSignupEmailVerificationTokenStore,
  PostgresSignupOwnerEmailLookup,
  PostgresSignupVerifiedIdentityStore,
} from "./platform/signup/verification.js";
import {
  ByoStorageHealthWorker,
  createDefaultTenantStorageResolver,
  createS3CompatibleStorage,
  createTenantStorageMigrationPairResolver,
  createTenantStorageResolver,
  PostgresTenantStorageMigrationJobStore,
  resolveTenantStorageSnapshot,
  TenantStorageMigrationWorker,
} from "./platform/storage/index.js";
import {
  assertActorMatchesRequestTenant,
  assertDeploymentResidency,
  assertRegionalDatabase,
  buildEffectiveTenantConfig,
  createPostgresTenantExportManifestPlanner,
  createRedisTenantDeletionCachePurger,
  ensureDefaultOrgForMode,
  initialOwnerActorStepName,
  installTenantContextHook,
  installTenantPostgresContextHook,
  objectStorePrefixStepName,
  PostgresOrgStore,
  PostgresPlanStore,
  PostgresTenantBootstrapSeedStore,
  PostgresTenantDeletionStore,
  PostgresTenantOwnerActorStore,
  PostgresTenantProvisioningStore,
  PostgresTenantStorageNamespaceStore,
  regionalResourceName,
  registerTenantLifecycleRoutes,
  resolveDefaultOrgInput,
  resolveTenantContext,
  setTenantPostgresActorId,
  TenantActorMismatchError,
  tenantBootstrapSeedStepName,
  TenantDeletionWorkflow,
  TenantHardDeleteWorker,
  TenantProvisioningWorker,
  TenantResolutionError,
  withTenantPostgresContext,
  type DefaultOrgInput,
  type OrgRecord,
  type OrgStore,
  type TenantProvisioningStep,
} from "./platform/tenancy/index.js";
import {
  createToolRegistry,
  type RuntimeToolRegistry,
  type ToolInvokeErrorResult,
} from "./platform/tool-registry.js";
import { createAgentOperationalControlTools } from "./platform/tools/agent-operational-controls-tools.js";
import { RuntimeAgentOperationalControlStore } from "./platform/tools/agent-operational-controls.js";
import { PostgresPendingActionStore } from "./platform/tools/pending-actions-postgres-store.js";
import { InMemoryConfirmationGate } from "./platform/tools/registry.js";
import {
  OutboundWebhookWorker,
  PostgresWebhookStore,
  registerWebhookRoutes,
  registerWebhookTools,
  registerWebhookVerificationDocsRoute,
  TenantEnvelopeWebhookSecretResolver,
} from "./platform/webhooks/index.js";
const toolParamsSchema = z.object({
  toolId: z.string().min(1),
});
const pendingActionParamsSchema = z.object({
  pendingId: z.string().uuid(),
});
/**
 * Raised when an API-key / mTLS credential is presented on the request path
 * but fails authentication or per-credential policy enforcement (PRD §9.2).
 * The server error handler maps this to the carried HTTP status.
 */
export class CredentialAuthError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CredentialAuthError";
  }
}
/**
 * Resolve the request actor, enforcing API-key / mTLS credential policy first
 * (PRD §9.2) and falling back to bearer access tokens and sessions. Shared by
 * the tool REST routes so credential enforcement is live on every surface.
 */
async function resolveRequestPrincipal(
  request: FastifyRequest,
  tokenStore: AccessTokenStore,
  sessionResolver: SessionActorResolver | undefined,
  credentialStore: AgentCredentialStore | undefined,
): Promise<ToolInvocationPrincipal> {
  const resolution = await toolInvocationPrincipalFromRequest(
    request,
    tokenStore,
    sessionResolver,
    credentialStore,
  );
  if (!resolution.ok) {
    throw new CredentialAuthError(resolution.statusCode, resolution.code, resolution.message);
  }
  assertActorMatchesRequestTenant(request, resolution.principal.actor);
  if (resolution.principal.actor.id !== unauthenticatedActor.id)
    await setTenantPostgresActorId(resolution.principal.actor.id);
  return resolution.principal;
}
export interface ToolRestRoutesOptions {
  readonly tools: RuntimeToolRegistry;
  readonly metrics: PlatformMetrics;
  readonly tokenStore: AccessTokenStore;
  readonly sessionResolver?: SessionActorResolver;
  /**
   * Store backing API-key / mTLS credential authentication and per-credential
   * policy enforcement (PRD §9.2). When omitted, credential auth is disabled.
   */
  readonly credentialStore?: AgentCredentialStore;
  /**
   * Store backing `Idempotency-Key` replay for mutating tool calls (P1-10).
   * When omitted, idempotency handling is disabled.
   */
  readonly idempotencyStore?: IdempotencyStore;
  /** TTL for stored idempotency records, in milliseconds. */
  readonly idempotencyTtlMs?: number;
}
/** Derives a trace identifier for error envelopes and idempotency scoping. */
function traceIdForRequest(request: FastifyRequest): string {
  const context = createRequestContext(request);
  return context.traceId ?? context.requestId;
}
export interface TenantApiRpsLimitHookOptions {
  readonly limiter: TenantApiRpsLimiter;
  readonly events?: Pick<EventBus, "publish"> | undefined;
  readonly onQuotaEventError?: ((error: unknown) => void) | undefined;
}
export function installUntrustedIdentityHeaderGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    const header = untrustedIdentityHeader(request.headers);
    if (header !== undefined) {
      return reply.code(401).send(
        buildErrorEnvelope({
          statusCode: 401,
          code: "untrusted_identity_assertion",
          message: "Client-supplied identity assertions are not accepted.",
          traceId: traceIdForRequest(request),
          details: { header },
        }),
      );
    }
  });
}
/* Paths that hold a connection open rather than answering and closing.
 *
 * Only `/events/ws` for now, deliberately. `/sse/mail` and `/ws/chat` have the
 * same shape and the same argument applies to them, but they are metered today
 * and nothing has been observed to suffer for it — exempting a surface means
 * moving it onto the concurrency cap instead, and that is a change worth making
 * per surface, with its own verification, rather than in a sweep. */
const LONG_LIVED_STREAM_PATHS: ReadonlySet<string> = new Set(["/events/ws"]);
export function isLongLivedStreamPath(path: string): boolean {
  return LONG_LIVED_STREAM_PATHS.has(path);
}
export function installTenantApiRpsLimitHook(
  app: FastifyInstance,
  options: TenantApiRpsLimitHookOptions,
): void {
  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (path === "/api/auth" || path.startsWith("/api/auth/")) {
      return;
    }
    /* Long-lived streams are exempt from the *rate* meter.
     *
     * `api_rps_limit` bounds work per unit time, and that is the wrong shape
     * for a connection that costs one upgrade and then lives for minutes. The
     * cost was real and visible: the admin console opens its event sockets as a
     * section mounts, so the upgrades landed in the same one-second window as
     * that section's own queries and pushed the page over its own budget — a
     * liveness feature stealing the request budget from the data it exists to
     * keep fresh.
     *
     * These connections are still bounded, just by the right control: a
     * per-org cap on *concurrent* streams, enforced at upgrade time by
     * `assertStreamConnectionAvailable` below. */
    if (isLongLivedStreamPath(path)) {
      return;
    }
    const tenant = request.tenant;
    if (tenant === null) {
      return;
    }
    const effectiveConfig = tenant.effectiveConfig;
    const decision = await options.limiter.consume({
      orgId: tenant.orgId,
      limit: effectiveConfig.quotas.api_rps_limit,
    });
    if (decision.allowed) {
      reply.header(
        "x-helix-quota-api-rps-limit",
        decision.limit === null ? "unlimited" : String(decision.limit),
      );
      reply.header(
        "x-helix-quota-api-rps-remaining",
        decision.remaining === null ? "unlimited" : String(decision.remaining),
      );
      if (decision.resetsAt !== null) {
        reply.header("x-helix-quota-api-rps-reset", decision.resetsAt);
      }
      return;
    }
    reply.header("retry-after", String(decision.retryAfterSeconds));
    reply.header("x-helix-quota-api-rps-limit", String(decision.limit));
    reply.header("x-helix-quota-api-rps-remaining", "0");
    reply.header("x-helix-quota-api-rps-reset", decision.resetsAt);
    void options.events
      ?.publish("quota.api_rps.exceeded", {
        orgId: tenant.orgId,
        quota: "api_rps_limit",
        surface: "http.request",
        limit: decision.limit,
        used: decision.used,
        remaining: decision.remaining,
        retryAfterSeconds: decision.retryAfterSeconds,
        resetsAt: decision.resetsAt,
        method: request.method,
        path,
      })
      .catch((error: unknown) => {
        options.onQuotaEventError?.(error);
      });
    return reply.code(429).send(
      buildErrorEnvelope({
        statusCode: 429,
        code: "quota.api_rps.exceeded",
        message: "Tenant API request rate limit exceeded.",
        traceId: traceIdForRequest(request),
        details: {
          quota: "api_rps_limit",
          limit: decision.limit,
          used: decision.used,
          remaining: decision.remaining,
          retryAfterSeconds: decision.retryAfterSeconds,
          resetsAt: decision.resetsAt,
        },
      }),
    );
  });
}
/** Extracts the `Idempotency-Key` header value if present. */
function idempotencyKeyFromRequest(request: FastifyRequest): string | undefined {
  const header = request.headers["idempotency-key"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
export interface ActionStatusRoutesOptions {
  readonly tools: RuntimeToolRegistry;
  readonly tokenStore: AccessTokenStore;
  readonly sessionResolver?: SessionActorResolver;
  /** Store backing API-key / mTLS credential authentication (PRD §9.2). */
  readonly credentialStore?: AgentCredentialStore;
}
export type PendingActionMutationRoutesOptions = ActionStatusRoutesOptions;
type ToolRestRouteMethod = "GET" | "POST";
export function registerToolRestRoutes(
  app: FastifyInstance,
  options: ToolRestRoutesOptions,
  methods: readonly ToolRestRouteMethod[] = ["POST", "GET"],
): void {
  if (methods.includes("POST")) {
    app.post("/api/tools/:toolId", async (request, reply) => {
      const params = toolParamsSchema.parse(request.params);
      const traceId = traceIdForRequest(request);
      const tool = options.tools.get(params.toolId);
      const principal = await resolveRequestPrincipal(
        request,
        options.tokenStore,
        options.sessionResolver,
        options.credentialStore,
      );
      // P1-10: Idempotency-Key replay for mutating (non-read) tool calls. Read
      // tools are naturally idempotent so the key is ignored for them.
      const idempotencyKey = idempotencyKeyFromRequest(request);
      const idempotencyStore = options.idempotencyStore;
      const idempotency:
        | {
            readonly store: IdempotencyStore;
            readonly key: string;
            readonly hash: string;
          }
        | undefined =
        idempotencyStore !== undefined &&
        idempotencyKey !== undefined &&
        tool !== undefined &&
        tool.sideEffects !== "read"
          ? await (async () => {
              return {
                store: idempotencyStore,
                key: idempotencyStorageKey({
                  orgId: principal.actor.orgId,
                  actorId: principal.actor.id,
                  toolId: params.toolId,
                  idempotencyKey,
                }),
                hash: fingerprintRequestPayload(request.body),
              };
            })()
          : undefined;
      if (idempotency !== undefined) {
        const outcome = await resolveIdempotency(
          idempotency.store,
          idempotency.key,
          idempotency.hash,
        );
        if (outcome.kind === "conflict") {
          reply.header("api-version", HELIX_API_VERSION_HEADER_VALUE);
          return reply.code(409).send(
            buildErrorEnvelope({
              statusCode: 409,
              code: "idempotency_key_reused",
              message: "Idempotency-Key was already used with a different request payload.",
              traceId,
            }),
          );
        }
        if (outcome.kind === "replay") {
          reply.header("idempotency-replayed", "true");
          const replayed = outcome.record.result;
          if (!replayed.ok) {
            return sendToolInvokeError(reply, replayed, traceId);
          }
          if (replayed.status === "pending_confirmation") {
            return reply.code(202).send({ status: replayed.status, pending: replayed.pending });
          }
          return reply.code(outcome.record.statusCode).send(replayed.output);
        }
      }
      const result = await invokeTool(
        options.tools,
        principal,
        params.toolId,
        request.body,
        request,
      );
      if (idempotency !== undefined) {
        const statusCode = result.ok
          ? result.status === "pending_confirmation"
            ? 202
            : 200
          : result.statusCode;
        // Only persist deterministic outcomes — transient 5xx failures should
        // be retryable rather than pinned to a stored error.
        if (result.ok || result.statusCode < 500) {
          await idempotency.store.set(idempotency.key, {
            result,
            statusCode,
            requestHash: idempotency.hash,
            expiresAt: Date.now() + (options.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS),
          });
        }
      }
      if (!result.ok) {
        return sendToolInvokeError(reply, result, traceId);
      }
      if (result.status === "pending_confirmation") {
        return reply.code(202).send({ status: result.status, pending: result.pending });
      }
      return result.output;
    });
  }
  if (methods.includes("GET")) {
    app.get("/api/tools/:toolId", async (request, reply) => {
      const params = toolParamsSchema.parse(request.params);
      const traceId = traceIdForRequest(request);
      const tool = options.tools.get(params.toolId);
      if (tool === undefined) {
        return reply.code(404).send(
          buildErrorEnvelope({
            statusCode: 404,
            code: "tool_not_found",
            message: `Unknown tool: ${params.toolId}`,
            traceId,
          }),
        );
      }
      if (tool.sideEffects !== "read") {
        return reply.code(405).send(
          buildErrorEnvelope({
            statusCode: 405,
            code: "method_not_allowed",
            message: `Tool is not safe for GET: ${params.toolId}`,
            traceId,
          }),
        );
      }
      const result = await invokeTool(
        options.tools,
        await resolveRequestPrincipal(
          request,
          options.tokenStore,
          options.sessionResolver,
          options.credentialStore,
        ),
        params.toolId,
        request.query,
        request,
      );
      if (!result.ok) {
        return sendToolInvokeError(reply, result, traceId);
      }
      if (result.status === "pending_confirmation") {
        return reply.code(202).send({ status: result.status, pending: result.pending });
      }
      return result.output;
    });
  }
}
export function registerActionStatusRoutes(
  app: FastifyInstance,
  options: ActionStatusRoutesOptions,
): void {
  const actionStatusHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const params = pendingActionParamsSchema.parse(request.params);
    const principal = await resolveRequestPrincipal(
      request,
      options.tokenStore,
      options.sessionResolver,
      options.credentialStore,
    );
    const result = await options.tools.getPendingAction(params.pendingId, {
      actor: principal.actor,
    });
    if (!result.ok) {
      return sendToolInvokeError(reply, result, traceIdForRequest(request));
    }
    return { action: result.pending };
  };
  app.get("/actions/:pendingId", actionStatusHandler);
}
/** Register authenticated approval/cancellation routes with fresh credential policy resolution. */
export function registerPendingActionMutationRoutes(
  app: FastifyInstance,
  options: PendingActionMutationRoutesOptions,
): void {
  app.post("/api/tools/pending/:pendingId/approve", async (request, reply) => {
    const params = pendingActionParamsSchema.parse(request.params);
    const principal = await resolveRequestPrincipal(
      request,
      options.tokenStore,
      options.sessionResolver,
      options.credentialStore,
    );
    const result = await options.tools.approvePending(params.pendingId, {
      ...toolInvocationOptions(principal, createRequestContext(request)),
    });
    if (!result.ok) {
      return sendToolInvokeError(reply, result, traceIdForRequest(request));
    }
    if (result.status === "pending_confirmation") {
      return reply.code(202).send({ status: result.status, pending: result.pending });
    }
    return { status: "executed", output: result.output };
  });
  app.post("/api/tools/pending/:pendingId/cancel", async (request, reply) => {
    const params = pendingActionParamsSchema.parse(request.params);
    const principal = await resolveRequestPrincipal(
      request,
      options.tokenStore,
      options.sessionResolver,
      options.credentialStore,
    );
    const result = await options.tools.cancelPending(params.pendingId, {
      ...toolInvocationOptions(principal, createRequestContext(request)),
    });
    if (!result.ok) {
      return sendToolInvokeError(reply, result, traceIdForRequest(request));
    }
    return { status: result.status, pending: result.pending };
  });
}
const assistantChatStreamBodySchema = z.object({
  message: z.string().min(1).max(100000),
  conversationId: z.string().uuid().optional(),
  title: z.string().min(1).max(200).optional(),
  memoryOptIn: z.boolean().optional(),
});
/** Minimal orchestrator surface needed by the assistant SSE route. */
export interface AssistantStreamOrchestrator {
  sendMessageStream(input: AssistantSendMessageInput): AsyncGenerator<AssistantStreamEvent>;
}
export interface AssistantStreamRouteOptions {
  readonly orchestrator: AssistantStreamOrchestrator;
  /** Tool registry used to serve non-streaming `assistant.chat` requests. */
  readonly tools: RuntimeToolRegistry;
  readonly tokenStore: AccessTokenStore;
  readonly sessionResolver?: SessionActorResolver;
  readonly credentialStore?: AgentCredentialStore;
  readonly onError?: (error: unknown) => void;
}
/**
 * Registers the assistant SSE streaming endpoint (PRD §9.5).
 *
 * `POST /api/tools/assistant.chat` runs {@link AssistantOrchestrator.sendMessageStream}
 * and, when the client negotiates `text/event-stream`, emits each incremental
 * `delta` event followed by a terminal `final` event carrying the full turn.
 * This static route is registered before the parametric `/api/tools/:toolId`
 * route, so it takes precedence for the assistant chat tool while every other
 * tool keeps the standard JSON REST behaviour. When the client does NOT accept
 * an event stream the request is served through the standard JSON
 * tool-invocation path so non-streaming callers are unaffected.
 */
export function registerAssistantStreamRoute(
  app: FastifyInstance,
  options: AssistantStreamRouteOptions,
): void {
  app.post("/api/tools/assistant.chat", async (request, reply) => {
    if (!acceptsEventStream(request)) {
      // Non-streaming callers use the standard JSON tool-invocation path.
      const traceId = traceIdForRequest(request);
      const result = await invokeTool(
        options.tools,
        await resolveRequestPrincipal(
          request,
          options.tokenStore,
          options.sessionResolver,
          options.credentialStore,
        ),
        "assistant.chat",
        request.body,
        request,
      );
      if (!result.ok) {
        return sendToolInvokeError(reply, result, traceId);
      }
      if (result.status === "pending_confirmation") {
        return reply.code(202).send({ status: result.status, pending: result.pending });
      }
      return result.output;
    }
    // Validate the streaming request body BEFORE the SSE headers are written.
    // On invalid input every other tool route returns the canonical HelixError
    // envelope (`{error:{code,message,traceId}}`); align this route to it
    // instead of leaking Fastify's raw `{statusCode,error,message}` 500.
    const parsedBody = assistantChatStreamBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      const traceId = traceIdForRequest(request);
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: `Invalid assistant.chat request body: ${parsedBody.error.message}`,
          traceId,
        }),
      );
    }
    const body = parsedBody.data;
    const principal = await resolveRequestPrincipal(
      request,
      options.tokenStore,
      options.sessionResolver,
      options.credentialStore,
    );
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "api-version": HELIX_API_VERSION_HEADER_VALUE,
    });
    try {
      const stream = options.orchestrator.sendMessageStream({
        actor: principal.actor,
        principal,
        content: body.message,
        request: createRequestContext(request),
        ...(body.conversationId === undefined ? {} : { conversationId: body.conversationId }),
        ...(body.title === undefined ? {} : { title: body.title }),
        ...(body.memoryOptIn === undefined ? {} : { memoryOptIn: body.memoryOptIn }),
      });
      for await (const event of stream) {
        reply.raw.write(formatAssistantSseEvent(event));
      }
    } catch (error) {
      options.onError?.(error);
      reply.raw.write(
        formatAssistantSseEvent({
          type: "error",
          message: "The assistant stream failed.",
        }),
      );
    } finally {
      reply.raw.end();
    }
    return reply;
  });
}
/** An assistant SSE frame: a stream event or a terminal error notice. */
export type AssistantSseFrame =
  | AssistantStreamEvent
  | {
      readonly type: "error";
      readonly message: string;
    };
/** Serializes an assistant SSE frame to the `text/event-stream` wire format. */
export function formatAssistantSseEvent(event: AssistantSseFrame): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
export interface DefaultOrgBootLogger {
  info(input: JsonObject, message: string): void;
}
export async function verifyDefaultOrgAtBoot(input: {
  readonly config: Pick<HelixConfig, "mode">;
  readonly orgs: Pick<OrgStore, "getOrCreateDefaultOrg">;
  readonly defaultOrg: DefaultOrgInput;
  readonly logger: DefaultOrgBootLogger;
}): Promise<OrgRecord | null> {
  const bootDefaultOrg = await ensureDefaultOrgForMode({
    config: input.config,
    orgs: input.orgs,
    defaultOrg: input.defaultOrg,
  });
  if (bootDefaultOrg !== null) {
    input.logger.info(
      {
        orgId: bootDefaultOrg.id,
        slug: bootDefaultOrg.slug,
        region: bootDefaultOrg.region,
      },
      "Verified single-tenant default org at boot",
    );
  }
  return bootDefaultOrg;
}
export const HELIX_LOG_REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers.sec-websocket-protocol",
  "password",
  "secret",
  "token",
  "ticket",
];
export async function createHelixServer(): Promise<FastifyInstance> {
  const bootEnv = env();
  const trustedOrigins = parseTrustedOrigins(bootEnv.BETTER_AUTH_TRUSTED_ORIGINS);
  const trustedProxies = trustedProxyAddresses(bootEnv.HELIX_TRUSTED_PROXIES);
  const app = fastify({
    logger: helixLoggerOptions(bootEnv.LOG_LEVEL),
    ...(trustedProxies.length === 0 ? {} : { trustProxy: [...trustedProxies] }),
    // Binary uploads bypass the API tier through scoped storage URLs. Keep
    // JSON control-plane requests small and terminate slow bodies promptly.
    bodyLimit: API_BODY_LIMIT_BYTES,
    requestTimeout: API_REQUEST_TIMEOUT_MS,
    // Tool routes carry signed pending-action ids and other long path
    // segments; Fastify's default `maxParamLength` of 100 silently 404s
    // anything longer. 2 KB matches the URL-segment ceiling most reverse
    // proxies tolerate without rejecting the request outright.
    routerOptions: {
      maxParamLength: 2048,
    },
  });
  const metrics = createPlatformMetrics();
  const responseSecurityHeaders = browserSecurityHeaders({
    production: bootEnv.NODE_ENV === "production",
    jitsiPublicUrl: bootEnv.MEET_JITSI_PUBLIC_URL,
  });
  // P1-10: advertise the API version on every response so clients can detect
  // the contract they are talking to without parsing the OpenAPI document.
  app.addHook("onSend", async (_request, reply) => {
    if (!reply.hasHeader("api-version")) {
      reply.header("api-version", HELIX_API_VERSION_HEADER_VALUE);
    }
    for (const [name, value] of Object.entries(responseSecurityHeaders)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
  });
  installUntrustedIdentityHeaderGuard(app);
  // PRD §9.2: a presented-but-rejected API-key / mTLS credential surfaces as a
  // CredentialAuthError; map it to the carried 401/403 canonical error
  // envelope rather than a generic 500. ApiError / ContractValidationError /
  // ZodError share the same envelope path (G4).
  app.setErrorHandler((error, request, reply) => {
    const traceId = traceIdForRequest(request);
    if (error instanceof ApiError) {
      if (error.retryAfterSeconds !== undefined) {
        reply.header("retry-after", String(error.retryAfterSeconds));
      }
      const details =
        error.details !== undefined &&
        typeof error.details === "object" &&
        error.details !== null &&
        !Array.isArray(error.details)
          ? (error.details as Record<string, unknown>)
          : error.details !== undefined
            ? { value: error.details }
            : undefined;
      return reply.code(error.statusCode).send(
        buildErrorEnvelope({
          statusCode: error.statusCode,
          code: error.code,
          message: error.message,
          traceId,
          ...(details === undefined ? {} : { details }),
        }),
      );
    }
    if (error instanceof ContractValidationError) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: error.message,
          traceId,
          details: { issues: error.issues },
        }),
      );
    }
    if (error instanceof ZodError) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: "Request validation failed",
          traceId,
          details: {
            issues: error.issues.map((i) => ({
              path: i.path,
              message: i.message,
            })),
          },
        }),
      );
    }
    if (error instanceof CredentialAuthError) {
      return reply.code(error.statusCode).send(
        buildErrorEnvelope({
          statusCode: error.statusCode,
          code: error.code,
          message: error.message,
          traceId,
        }),
      );
    }
    if (error instanceof TenantResolutionError) {
      return reply.code(error.statusCode).send(
        buildErrorEnvelope({
          statusCode: error.statusCode,
          code: error.code,
          message: error.message,
          traceId,
        }),
      );
    }
    if (error instanceof TenantActorMismatchError) {
      return reply.code(error.statusCode).send(
        buildErrorEnvelope({
          statusCode: error.statusCode,
          code: error.code,
          message: error.message,
          traceId,
        }),
      );
    }
    throw error;
  });
  app.setNotFoundHandler((request, reply) => {
    const traceId = traceIdForRequest(request);
    return reply.code(404).send(
      buildErrorEnvelope({
        statusCode: 404,
        code: "not_found",
        message: `Route ${request.method} ${request.url} not found`,
        traceId,
      }),
    );
  });
  const sql = createSqlClient();
  if (bootEnv.NODE_ENV === "production") {
    await assertTenantSafeDatabaseRole(sql);
    await assertTenantRlsCoverage(sql);
  }
  const redisConnection = resolveRedisConnection(bootEnv);
  const redis =
    redisConnection === undefined
      ? undefined
      : new Redis(redisConnection.url, redisConnection.options);
  if (bootEnv.NODE_ENV === "production" && redis === undefined) {
    throw new Error("REDIS_URL is required in production for distributed limits and idempotency.");
  }
  const idempotencyStore: IdempotencyStore =
    redis === undefined ? new InMemoryIdempotencyStore() : new RedisIdempotencyStore(redis);
  const tenantApiRpsLimiter: TenantApiRpsLimiter =
    redis === undefined ? new InMemoryTenantApiRpsLimiter() : new RedisTenantApiRpsLimiter(redis);
  const tenantHourlyQuotaLimiter: TenantHourlyQuotaLimiter =
    redis === undefined
      ? new InMemoryTenantHourlyQuotaLimiter()
      : new RedisTenantHourlyQuotaLimiter(redis);
  const oauthIssuer =
    bootEnv.BETTER_AUTH_URL ??
    bootEnv.HELIX_PUBLIC_URL ??
    bootEnv.PUBLIC_BASE_URL ??
    "http://localhost:3000";
  const oauthStore = new PostgresOAuthStore(sql, oauthIssuer);
  // PRD §9.2: expanded agent credential model. The credential store resolves
  // `api_key` / `mtls_cert` credentials together with their per-credential
  // policy (IP allowlist, allowed-hours, expiry, revocation) for request-path
  // enforcement. The authorization-code store backs the OAuth 2.1
  // Authorization Code flow with PKCE (PRD §13.6).
  const agentCredentialStore = new PostgresAgentCredentialStore(sql);
  const authorizationCodeStore = new PostgresAuthorizationCodeStore(sql);
  const oauthAuthorizationStore = new PostgresOAuthAuthorizationStore(sql);
  const authorizationCodeService = new AuthorizationCodeService({
    codeStore: authorizationCodeStore,
  });
  const mailCfg = mailConfig(bootEnv);
  const identityMailTransport =
    mailCfg.outbound === undefined ? undefined : new NodemailerMailTransport(mailCfg.outbound);
  const tenantStorageSecretReader = createVaultTenantSecretReaderFromEnv(process.env);
  const betterAuthConfig = getBetterAuthRuntimeConfig(process.env);
  if (
    bootEnv.NODE_ENV === "production" &&
    betterAuthConfig !== undefined &&
    identityMailTransport === undefined
  ) {
    throw new Error("Outbound SMTP is required in production for secure account recovery.");
  }
  const betterAuthRuntime =
    betterAuthConfig === undefined
      ? undefined
      : createBetterAuthRuntime({
          ...betterAuthConfig,
          resolveSsoUser: (input) => resolveTenantOidcUser(sql, input),
          resolveSsoPrivateKey: (input) =>
            resolveTenantOidcPrivateKey(sql, tenantStorageSecretReader, input),
          ...(identityMailTransport === undefined
            ? {}
            : {
                sendPasswordReset: async (input) => {
                  await identityMailTransport.send(
                    {
                      from: {
                        address: mailCfg.signupFrom.address,
                        name: mailCfg.signupFrom.name,
                      },
                      to: [{ address: input.email }],
                      cc: [],
                      bcc: [],
                      subject: "Reset your Helix password",
                      text: [
                        "Reset your Helix password",
                        "",
                        "Open this link within 15 minutes:",
                        input.url,
                        "",
                        "If you did not request this, ignore this email.",
                      ].join("\n"),
                      attachments: [],
                    },
                    { idempotencyKey: `password-reset:${recoveryCodeDigest(input.token)}` },
                  );
                },
              }),
        });
  const tenantSecretMaster =
    bootEnv.HELIX_SECRET_ENCRYPTION_KEY ??
    betterAuthConfig?.secret ??
    (bootEnv.NODE_ENV === "production"
      ? undefined
      : "helix_local_database_secret_change_me_32_chars");
  if (tenantSecretMaster === undefined) {
    throw new TypeError(
      "HELIX_SECRET_ENCRYPTION_KEY is required when Better Auth is disabled in production",
    );
  }
  const tenantSecretCipher = new TenantEnvelopeCipher(tenantSecretMaster);
  const betterAuthSessionIssuer =
    betterAuthConfig === undefined
      ? undefined
      : new PostgresBetterAuthSessionIssuer(sql, {
          secret: betterAuthConfig.secret,
          secureCookies: betterAuthConfig.secureCookies,
        });
  const orgStore = new PostgresOrgStore(sql, bootEnv.HELIX_REGION);
  const domainsStore = new PostgresDomainsStore(sql);
  const domainIdentityStore = new PostgresDomainIdentityStore(sql);
  const tenantProvisioningStore = new PostgresTenantProvisioningStore(sql);
  const tenantOwnerActorStore = new PostgresTenantOwnerActorStore(sql);
  const tenantStorageNamespaceStore = new PostgresTenantStorageNamespaceStore(sql);
  const tenantBootstrapSeedStore = new PostgresTenantBootstrapSeedStore(sql);
  const tenantIdpConfigStore = new PostgresTenantIdpConfigStore(sql);
  const securityPoliciesStore = new PostgresSecurityPoliciesStore(sql);
  const tenantScimCredentialStore = new PostgresTenantScimCredentialStore(sql);
  const scimProvisioningStore = new PostgresScimProvisioningStore(sql);
  const signupEmailVerificationTokenStore = new PostgresSignupEmailVerificationTokenStore(sql);
  const signupVerifiedIdentityStore = new PostgresSignupVerifiedIdentityStore(sql);
  const signupOwnerEmailLookup = new PostgresSignupOwnerEmailLookup(sql);
  const signupOnboardingStore = new PostgresSignupOnboardingStore(sql);
  const signupOnboardingInviteTokenStore = new PostgresSignupOnboardingInviteTokenStore(sql);
  const signupPasswordScreener = new DefaultSignupPasswordScreener({
    pwnedPasswords: envFlag("HELIX_SIGNUP_HIBP_PASSWORD_CHECK_ENABLED", true)
      ? new HaveIBeenPwnedPasswordChecker({
          userAgent: bootEnv.HELIX_SIGNUP_HIBP_USER_AGENT,
        })
      : undefined,
  });
  const signupAbuseOptions = {
    maxSignupsPerWindow: bootEnv.HELIX_SIGNUP_RATE_LIMIT_PER_HOUR,
    windowMs: 60 * 60 * 1000,
    blockedEmailDomains: parseBlockedSignupEmailDomains(bootEnv.HELIX_SIGNUP_BLOCKED_EMAIL_DOMAINS),
  };
  const signupAbuseProtector =
    redis === undefined
      ? new InMemorySignupAbuseProtector(signupAbuseOptions)
      : new RedisSignupAbuseProtector(ioredisSignupRateLimitClient(redis), signupAbuseOptions);
  const signupRiskReviewer = new ConfiguredCountrySignupRiskReviewer({
    manualReviewCountries: parseSignupManualReviewCountries(
      bootEnv.HELIX_SIGNUP_MANUAL_REVIEW_COUNTRIES,
    ),
  });
  const signupRecaptchaVerifier =
    bootEnv.HELIX_SIGNUP_RECAPTCHA_SECRET === undefined
      ? undefined
      : new GoogleRecaptchaVerifier({
          secret: bootEnv.HELIX_SIGNUP_RECAPTCHA_SECRET,
          minScore: bootEnv.HELIX_SIGNUP_RECAPTCHA_MIN_SCORE,
          expectedAction: bootEnv.HELIX_SIGNUP_RECAPTCHA_ACTION,
        });
  const tenantProvisioningSteps: TenantProvisioningStep[] = [
    {
      name: objectStorePrefixStepName,
      run: async (record) => {
        await tenantStorageNamespaceStore.ensureDefaultObjectStorePrefix({ orgId: record.orgId });
      },
    },
    {
      name: initialOwnerActorStepName,
      run: async (record) => {
        await tenantOwnerActorStore.ensureInitialOwnerActor({
          orgId: record.orgId,
          email: record.requestedOwnerEmail,
          metadata: { source: "tenant-provisioning" },
        });
      },
    },
    {
      name: tenantBootstrapSeedStepName,
      run: async (record) => {
        await tenantBootstrapSeedStore.ensureTenantBootstrapSeed({
          orgId: record.orgId,
          ownerEmail: record.requestedOwnerEmail,
        });
      },
    },
  ];
  const tenantProvisioningWorker = envFlag("HELIX_TENANT_PROVISIONING_WORKER_ENABLED", false)
    ? new TenantProvisioningWorker({
        store: tenantProvisioningStore,
        steps: tenantProvisioningSteps,
        batchSize: bootEnv.TENANT_PROVISIONING_BATCH_SIZE,
        intervalMs: bootEnv.TENANT_PROVISIONING_INTERVAL_MS,
        onResult: (result) => {
          if (result.claimed > 0) {
            app.log.info(result, "Tenant provisioning worker run completed");
          }
        },
        onError: (error) => {
          app.log.error({ error }, "Tenant provisioning worker error");
        },
      })
    : undefined;
  const planStore = new PostgresPlanStore(sql);
  const defaultOrg = resolveDefaultOrgInput(process.env);
  const appPasswordStore = new PostgresAppPasswordStore(sql);
  const adminUsersStore = new PostgresAdminUsersStore(sql);
  /* Built here rather than inline at its route registration because
       `GET /api/admin/overview` reads through the same instance, and that route is
       registered earlier in this function. */
  const adminDomainsStore = new PostgresDomainsStore(sql);
  const auditStore = new PostgresAuditStore(sql, {
    onAppend: (record) => {
      metrics.recordAuditActivity({ verb: record.verb, objectType: record.objectType });
    },
  });
  const webhookSecretResolver = new TenantEnvelopeWebhookSecretResolver(tenantSecretCipher);
  const webhookStore = new PostgresWebhookStore(sql, tenantSecretCipher);
  const chatModerationStore = new PostgresChatModerationStore(sql);
  const calendarStore = new PostgresCalendarStore(sql);
  const calendarSchedulingStore = new PostgresCalendarSchedulingStore(sql, calendarStore);
  const calendarInvitationDeliveryStore = new PostgresCalendarInvitationDeliveryStore(sql);
  const cardDavContactStore = new PostgresCardDavContactStore(sql);
  const assistantStore = new PostgresAssistantStore(sql);
  const outboxStore = new PostgresOutboxStore(sql);
  const pluginLifecycleStore = new PostgresPluginLifecycleStore(sql);
  if (bootEnv.NODE_ENV === "production" && bootEnv.NATS_URL === undefined) {
    throw new Error("NATS_URL is required in production for cross-replica events.");
  }
  const natsSecurityPolicy =
    bootEnv.NATS_URL === undefined
      ? undefined
      : createChatNatsSecurityPolicy(
          {
            NATS_URL: bootEnv.NATS_URL,
            NATS_USER: bootEnv.NATS_USER,
            NATS_PASSWORD: bootEnv.NATS_PASSWORD,
            NATS_TOKEN: bootEnv.NATS_TOKEN,
            NATS_TLS_CA_FILE: bootEnv.NATS_TLS_CA_FILE,
            NATS_TLS_CERT_FILE: bootEnv.NATS_TLS_CERT_FILE,
            NATS_TLS_KEY_FILE: bootEnv.NATS_TLS_KEY_FILE,
            NODE_ENV: bootEnv.NODE_ENV,
          },
          [defaultOrg.id],
        );
  const eventBus =
    natsSecurityPolicy === undefined
      ? new InMemoryEventBus({
          onError: (error) => {
            app.log.error({ error }, "In-memory event bus subscriber error");
          },
        })
      : await NatsEventBus.connect(natsSecurityPolicy.connection, {
          subjectPrefix: `helix.${bootEnv.HELIX_REGION}`,
        });
  const chatStore = new PostgresChatStore(sql);
  const chatRoomBus = new EventBusChatRoomBus(eventBus, {
    subjectPrefix: "chat",
    events: new PostgresChatRoomEventLog(sql),
    metrics,
  });
  const chatPresence =
    redis === undefined
      ? new InMemoryChatPresenceStore({ ttlSeconds: bootEnv.CHAT_PRESENCE_TTL_SECONDS })
      : new RedisChatPresenceStore(redis, {
          ttlSeconds: bootEnv.CHAT_PRESENCE_TTL_SECONDS,
        });
  const meteringEventStore = new PostgresMeteringEventStore(sql);
  const meteringRollupStore = new PostgresMeteringRollupStore(sql);
  const meteringClient = createMeteringClient(eventBus);
  const meetStore = new PostgresMeetStore(sql);
  const meetLifecycleWorker = new MeetLifecycleWorker({
    store: meetStore,
    onResult: (ended) => {
      if (ended > 0) app.log.info({ ended }, "Empty Meet rooms ended");
    },
    onError: (error) => {
      app.log.error({ error }, "Meet lifecycle worker error");
    },
  });
  const betterAuthPlatform = createBetterAuthPlatformModule({
    actorStore: new PostgresBetterAuthActorStore(sql),
    defaultOrgId: defaultOrg.id,
  });
  const sessionPolicyAuthorizer = new PostgresBetterAuthSessionPolicyAuthorizer(sql);
  const meteringIngestWorker = envFlag("HELIX_METERING_INGEST_WORKER_ENABLED", true)
    ? new MeteringIngestWorker({
        events: eventBus,
        store: meteringEventStore,
        onError: (error) => {
          app.log.error({ error }, "Metering ingest worker error");
        },
      })
    : undefined;
  const meteringRollupWorker = envFlag("HELIX_METERING_ROLLUP_WORKER_ENABLED", true)
    ? new MeteringRollupWorker({
        store: meteringRollupStore,
        intervalMs: Number.parseInt(
          bootEnv.HELIX_METERING_ROLLUP_INTERVAL_MS ??
            bootEnv.METERING_ROLLUP_INTERVAL_MS ??
            "86400000",
          10,
        ),
        periodBatchSize: Number.parseInt(
          bootEnv.HELIX_METERING_ROLLUP_PERIOD_BATCH_SIZE ??
            bootEnv.METERING_ROLLUP_PERIOD_BATCH_SIZE ??
            "250",
          10,
        ),
        onResult: (result) => {
          if (result.eventCount > 0) {
            app.log.info(result, "Metering rollup worker run completed");
          }
        },
        onError: (error) => {
          app.log.error({ error }, "Metering rollup worker error");
        },
      })
    : undefined;
  const platformConfigStore = new PostgresPlatformConfigStore(sql);
  const platformConfig = new PlatformConfigAdminService(platformConfigStore, process.env, eventBus);
  // P2-4: the same config source list backs both the initial load and the
  // runtime hot-reload, so a NATS-published change re-merges env + Postgres
  // overrides identically.
  const configSources = [
    new EnvConfigSource(process.env),
    new PostgresOverrideConfigSource(platformConfigStore),
  ];
  // `runtimeConfig` is a mutable holder: the hot-reload subscription swaps in a
  // freshly merged config so runtime readers (observability, readiness probes)
  // see config changes without a restart.
  let runtimeConfig = await loadHelixConfig(configSources);
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
    telemetryEnabled: runtimeConfig.observability?.enabled === true,
    telemetryRegion: bootEnv.HELIX_OTEL_REGION,
    auditRegion: envFlag("AUDIT_IMMUTABLE_S3_ENABLED", false)
      ? (bootEnv.AUDIT_IMMUTABLE_S3_REGION ?? "us-east-1")
      : undefined,
    siemEnabled: envFlag("AUDIT_SIEM_SYSLOG_ENABLED", false),
    siemRegion: bootEnv.HELIX_SIEM_REGION,
    meetConfigured:
      bootEnv.MEET_JITSI_PUBLIC_URL !== undefined || bootEnv.MEET_JITSI_DOMAIN !== undefined,
    meetRegion: bootEnv.MEET_JITSI_REGION,
    ai: runtimeConfig.ai,
  });
  if (bootEnv.HELIX_REGION !== "default") {
    await assertRegionalDatabase(sql, bootEnv.HELIX_REGION);
  }
  const { applyOperatorAiFromHelixConfig } = await import("./platform/ai/operator-settings.js");
  applyOperatorAiFromHelixConfig(runtimeConfig);
  await verifyDefaultOrgAtBoot({
    config: runtimeConfig,
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
      config: runtimeConfig,
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
  const principalFromAuthenticatedRequest = async (request: FastifyRequest) => {
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
  const actorFromAuthenticatedRequest = async (request: FastifyRequest) =>
    (await principalFromAuthenticatedRequest(request)).actor;
  // Confirmed Helix architecture model: core apps (mail, chat, drive, docs,
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
    ...(runtimeConfig.modules === undefined ? {} : { modules: runtimeConfig.modules }),
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
    embeddingProvider: createAssistantEmbeddingProvider(runtimeConfig.ai),
    defaultSource: "assistant.conversation",
  });
  const securityTier = runtimeConfig.security.tier;
  const pluginTrust = await loadPluginTrustFile(bootEnv.HELIX_PLUGIN_TRUST_FILE);
  if (tierDefaults[securityTier].pluginSignatureRequired && pluginTrust === undefined) {
    throw new Error(
      `${securityTier} tier requires HELIX_PLUGIN_TRUST_FILE for signed plugin verification.`,
    );
  }
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
    ...(runtimeConfig.ai === undefined ? {} : { aiConfig: runtimeConfig.ai }),
  });
  const driveConfig = loadDriveConfig(bootEnv);
  const clamavScanner =
    mailCfg.clamav === undefined
      ? undefined
      : new ClamavScanner({ ...mailCfg.clamav, tier: securityTier, metrics });
  const spamdScanner = mailCfg.spamd === undefined ? undefined : new SpamdScanner(mailCfg.spamd);
  const inboundMailScanners = {
    tier: securityTier,
    betaSpamSecondPass: createBetaSpamSecondPass(process.env),
    ...(spamdScanner === undefined ? {} : { spam: spamdScanner }),
    ...(clamavScanner === undefined ? {} : { antivirus: clamavScanner }),
    onUnavailable: ({
      scanner,
      policy,
      error,
    }: {
      scanner: string;
      policy: string;
      error: unknown;
    }) => {
      app.log.error(
        { error, scanner, policy },
        "Inbound mail scanner unavailable; tenant scan policy applied",
      );
    },
  };
  const rustfsEndpoint = driveConfig.storage.endpoint;
  if (rustfsEndpoint === undefined) {
    app.log.warn(
      "RUSTFS_ENDPOINT (and RUSTFS_API_PORT) unset; tenant storage writes (docs/sheets/slides/drive) will fail. Set RUSTFS_ENDPOINT=http://localhost:28437 or run docker-compose up rustfs.",
    );
  }
  const driveStorage =
    rustfsEndpoint === undefined
      ? undefined
      : createS3CompatibleStorage({
          endpoint: rustfsEndpoint,
          region: driveConfig.storage.region,
          bucket: driveConfig.storage.bucket,
          credentials: {
            accessKeyId: driveConfig.storage.accessKeyId,
            secretAccessKey: driveConfig.storage.secretAccessKey,
          },
          ...(driveConfig.storage.serverSideEncryption === undefined
            ? {}
            : {
                serverSideEncryption: parseS3ServerSideEncryption(
                  driveConfig.storage.serverSideEncryption,
                ),
                ...(driveConfig.storage.serverSideEncryptionAwsKmsKeyId === undefined
                  ? {}
                  : {
                      serverSideEncryptionAwsKmsKeyId:
                        driveConfig.storage.serverSideEncryptionAwsKmsKeyId,
                    }),
              }),
          ...(driveConfig.storage.serverSideEncryptionAwsKmsKeyId === undefined
            ? {}
            : {
                serverSideEncryptionAwsKmsKeyId:
                  driveConfig.storage.serverSideEncryptionAwsKmsKeyId,
              }),
          ...(driveConfig.storage.securityPolicy === undefined
            ? {}
            : { securityPolicy: driveConfig.storage.securityPolicy }),
          forcePathStyle: driveConfig.storage.forcePathStyle,
        });
  const driveStorageResolver = createTenantStorageResolver({
    defaultClient: driveStorage,
    ...(driveConfig.storage.serverSideEncryption === undefined
      ? {}
      : { defaultServerSideEncryption: driveConfig.storage.serverSideEncryption }),
    loadByoConfig: async (orgId: string) => (await orgStore.findById(orgId))?.byoConfig,
    metrics,
    secretReader: tenantStorageSecretReader,
    ...(bootEnv.HELIX_REGION === "default" ? {} : { deploymentRegion: bootEnv.HELIX_REGION }),
  });
  const helixDefaultStorageResolver = createDefaultTenantStorageResolver(driveStorage, {
    ...(driveConfig.storage.serverSideEncryption === undefined
      ? {}
      : { serverSideEncryption: driveConfig.storage.serverSideEncryption }),
    region: bootEnv.HELIX_REGION,
  });
  const tenantStorageMigrationJobStore = new PostgresTenantStorageMigrationJobStore(sql);
  const tenantStorageMigrationWorker = envFlag(
    "HELIX_TENANT_STORAGE_MIGRATION_WORKER_ENABLED",
    false,
  )
    ? new TenantStorageMigrationWorker({
        store: tenantStorageMigrationJobStore,
        sql,
        resolveStoragePair: createTenantStorageMigrationPairResolver({
          currentStorageResolver: driveStorageResolver,
          helixDefaultStorageResolver,
          snapshotStorageResolver: ({ orgId, state }) =>
            resolveTenantStorageSnapshot({
              orgId,
              state,
              defaultClient: driveStorage,
              secretReader: tenantStorageSecretReader,
              ...(bootEnv.HELIX_REGION === "default"
                ? {}
                : { deploymentRegion: bootEnv.HELIX_REGION }),
            }),
        }),
        intervalMs: bootEnv.HELIX_TENANT_STORAGE_MIGRATION_INTERVAL_MS,
        batchSize: bootEnv.HELIX_TENANT_STORAGE_MIGRATION_BATCH_SIZE,
        onResult: (result) => {
          if (result.claimed > 0) {
            app.log.info(result, "Tenant storage migration worker completed");
          }
        },
        onError: (error) => {
          app.log.error({ error }, "Tenant storage migration worker error");
        },
      })
    : undefined;
  const byoStorageHealthWorker = envFlag("HELIX_BYO_STORAGE_HEALTH_WORKER_ENABLED", true)
    ? new ByoStorageHealthWorker({
        store: orgStore,
        storageResolver: driveStorageResolver,
        intervalMs: bootEnv.HELIX_BYO_STORAGE_HEALTH_REFRESH_INTERVAL_MS,
        batchSize: bootEnv.HELIX_BYO_STORAGE_HEALTH_REFRESH_BATCH_SIZE,
        onResult: (result) => {
          if (result.checkedCount > 0) {
            app.log.info(result, "BYO storage health refresh completed");
          }
        },
        onError: (error) => {
          app.log.error({ error }, "BYO storage health refresh error");
        },
      })
    : undefined;
  const mailAttachmentIngestor = new PostgresMailAttachmentIngestor(sql, {
    storageResolver: driveStorageResolver,
    ...(clamavScanner === undefined ? {} : { scanner: clamavScanner }),
    scannerFailurePolicy: "retain-quarantine",
  });
  const mailAttachmentCleanupWorker = new MailAttachmentCleanupWorker(
    mailAttachmentIngestor,
    undefined,
    (error) => {
      app.log.error({ error }, "Mail attachment cleanup failed");
    },
  );
  const mailTrashPurgeWorker = new MailTrashPurgeWorker(
    new PostgresMailTrashPurger(sql),
    undefined,
    (result) => {
      if (result.purgedMailboxes + result.purgedJournalEntries > 0) {
        app.log.info(result, "Expired mail retention data purged");
      }
    },
    (error) => {
      app.log.error({ error }, "Mail trash purge failed");
    },
  );
  const mailStore = new PostgresMailStore(sql, {
    storageResolver: driveStorageResolver,
    attachmentIngestor: mailAttachmentIngestor,
  });
  const mailQuarantineStore = new PostgresMailQuarantineStore(sql, driveStorageResolver);
  const driveVirusScanner =
    mailCfg.clamav === undefined
      ? undefined
      : createClamAvVirusScanner({
          ...mailCfg.clamav,
          tier: securityTier,
          metrics,
          maxFileBytes: driveConfig.antivirus.maxFileBytes,
          archiveLimits: {
            maxEntries: driveConfig.antivirus.archiveMaxEntries,
            maxUncompressedBytes: driveConfig.antivirus.archiveMaxUncompressedBytes,
            maxExpansionRatio: driveConfig.antivirus.archiveMaxExpansionRatio,
            maxNestedArchives: driveConfig.antivirus.archiveMaxNested,
          },
        });
  const driveStore = new PostgresDriveStore(sql, driveStorage, {
    metrics,
    gc: driveConfig.gc,
    storageResolver: driveStorageResolver,
    events: eventBus,
    contentAddressedDedup: driveConfig.contentAddressedDedup,
    multipartThresholdBytes: driveConfig.multipartThresholdBytes,
    multipartPartSizeBytes: driveConfig.multipartPartSizeBytes,
    dlp,
    requireVirusScanner:
      coreApps.shouldRegister("drive") &&
      (bootEnv.NODE_ENV === "production" || securityTier !== "personal"),
    virusScanMaxAttempts: driveConfig.antivirus.maxAttempts,
    virusScanRetryDelayMs: driveConfig.antivirus.retryDelayMs,
    ...(driveVirusScanner === undefined ? {} : { virusScanner: driveVirusScanner }),
    onVirusScanUnavailable: (event) => {
      app.log.error(event, "Drive antivirus scan unavailable; file remains blocked");
    },
    onQuarantineDeleteError: (event) => {
      app.log.error(event, "Drive quarantine byte deletion failed; retry remains queued");
    },
    onQuotaEventError: (error: unknown) => {
      app.log.error({ error }, "Drive storage quota event emission failed");
    },
  });
  const driveWorkflowStore = new PostgresDriveWorkflowStore(sql);
  const chatAttachmentStore = new PostgresChatAttachmentStore(sql, {
    storageResolver: driveStorageResolver,
    ...(driveVirusScanner === undefined ? {} : { virusScanner: driveVirusScanner }),
    driveStore,
  });
  // This leased worker also collects abandoned uploads, multipart sessions, and unreferenced blobs.
  const driveVirusScanRetryWorker =
    !coreApps.shouldRegister("drive") &&
    !coreApps.shouldRegister("chat") &&
    !coreApps.shouldRegister("mail")
      ? undefined
      : new DriveVirusScanRetryWorker({
          store: driveStore,
          intervalMs: driveConfig.antivirus.retryIntervalMs,
          batchSize: driveConfig.antivirus.retryBatchSize,
          leaseMs: driveConfig.antivirus.leaseMs,
          virusScansEnabled: mailCfg.clamav !== undefined,
          onResult: (result) => {
            if (result.claimed > 0) {
              app.log.info(result, "Drive antivirus/quarantine retry batch completed");
            }
          },
          onError: (error) => {
            app.log.error({ error }, "Drive antivirus/quarantine retry worker failed");
          },
        });
  const searchEngine = await createSearchEngine(bootEnv.HELIX_REGION);
  const semanticEmbeddingProvider = createSemanticSearchEmbeddingProvider(runtimeConfig.ai);
  const vectorStore = createConfiguredVectorStore(runtimeConfig.ai, { sql });
  const projectedSearchEngine =
    searchEngine !== undefined &&
    semanticEmbeddingProvider !== undefined &&
    vectorStore !== undefined
      ? new SemanticSearchEngine({
          keyword: searchEngine,
          embeddings: semanticEmbeddingProvider,
          vectorStore,
        })
      : searchEngine;
  const runtimeSearchEngine =
    projectedSearchEngine === undefined
      ? undefined
      : new AuthorizingSearchEngine({
          engine: projectedSearchEngine,
          authorize: (request, hit) =>
            authorizeWorkspaceSearchHit(
              { chat: chatStore, contacts: cardDavContactStore },
              request,
              hit,
            ),
        });
  const searchSources = createPostgresSearchReindexSources(sql);
  const searchDurabilityStore =
    searchEngine === undefined ? undefined : new PostgresSearchDurabilityStore(sql);
  const searchReindexJobService =
    searchDurabilityStore === undefined
      ? undefined
      : new PostgresSearchReindexJobService(searchDurabilityStore);
  const searchEventIndexer =
    runtimeSearchEngine === undefined
      ? undefined
      : new SearchEventIndexer({
          events: eventBus,
          engine: runtimeSearchEngine,
          ...(searchDurabilityStore === undefined ? {} : { queue: searchDurabilityStore }),
          metrics,
          subject: bootEnv.SEARCH_EVENT_SUBJECT,
          onError: (error) => {
            app.log.error({ error }, "Search event indexer error");
          },
        });
  const searchReindexService =
    runtimeSearchEngine === undefined
      ? undefined
      : new SearchReindexService({
          engine: runtimeSearchEngine,
          sources: searchSources,
          batchSize: bootEnv.SEARCH_REINDEX_BATCH_SIZE,
        });
  const searchMutationWorker =
    searchDurabilityStore === undefined ||
    runtimeSearchEngine === undefined ||
    searchEngine === undefined
      ? undefined
      : new SearchMutationWorker({
          store: searchDurabilityStore,
          engine: runtimeSearchEngine,
          shadowEngine: (uid) => searchEngine.forIndex(uid),
          onError: (error) => {
            app.log.error({ error }, "Durable search projection failed");
          },
        });
  const searchShadowReindexWorker =
    searchDurabilityStore === undefined || searchEngine === undefined
      ? undefined
      : new SearchShadowReindexWorker({
          store: searchDurabilityStore,
          sources: searchSources,
          shadowEngine: (uid) => searchEngine.forIndex(uid),
          swap: (uid) => searchEngine.swapWith(uid),
          onError: (error) => {
            app.log.error({ error }, "Shadow search reindex failed");
          },
        });
  const searchReconciliationWorker =
    searchReindexService === undefined
      ? undefined
      : new SearchReconciliationWorker({
          service: searchReindexService,
          onResult: (result) => {
            metrics.recordOperationalEvent({
              capability: "search",
              operation: "reconcile",
              status: "success",
            });
            metrics.addOperationalUnits({
              capability: "search",
              measure: "reconciled_documents",
              value: result.totalDocuments,
            });
            metrics.setOperationalState({
              capability: "search",
              measure: "drift_objects",
              value: result.deletedDocuments,
            });
            if (result.deletedDocuments > 0) {
              app.log.info(
                { deletedDocuments: result.deletedDocuments },
                "Search reconciliation removed stale Drive projections",
              );
            }
          },
          onError: (error) => {
            metrics.recordOperationalEvent({
              capability: "search",
              operation: "reconcile",
              status: "error",
            });
            app.log.error({ error }, "Search reconciliation failed");
          },
        });
  if (searchEventIndexer !== undefined) {
    registerCardDavIndexer(searchEventIndexer);
    // Indexers are registered per core app, conditionally on enablement +
    // role. A disabled app contributes no search indexer.
    if (coreApps.shouldRegister("mail")) {
      registerMailIndexer(searchEventIndexer, mailStore);
    }
    if (coreApps.shouldRegister("chat")) {
      registerChatIndexer(searchEventIndexer, chatStore);
    }
    if (coreApps.shouldRegister("drive")) {
      registerDriveIndexer(searchEventIndexer, driveStore);
    }
    if (coreApps.shouldRegister("calendar")) {
      registerCalendarIndexer(searchEventIndexer, calendarStore);
    }
  }
  const enrichmentWorker = new EnrichmentWorker({
    events: eventBus,
    subject: bootEnv.ENRICHMENT_EVENT_SUBJECT,
    onResult: (result, event) => {
      app.log.debug({ result, subject: event.subject }, "AI enrichment applied");
    },
    onError: (error, event, handler) => {
      app.log.error(
        { error, subject: event.subject, handlerId: handler.id },
        "AI enrichment handler error",
      );
    },
  });
  // AI enrichment handlers are registered per core app, conditionally on
  // enablement + role.
  if (coreApps.shouldRegister("mail")) {
    registerMailEnrichments(enrichmentWorker, {
      store: mailStore,
      ai: assistantAi,
      entityExtract: envFlag("MAIL_ENTITY_EXTRACT_ENRICHMENT", true),
      classification: envFlag("MAIL_CLASSIFICATION_ENRICHMENT", true),
    });
  }
  if (coreApps.shouldRegister("chat")) {
    registerChatEnrichments(enrichmentWorker, {
      store: chatStore,
      ai: assistantAi,
      actionItems: envFlag("CHAT_ACTION_ITEMS_ENRICHMENT", true),
    });
  }
  if (coreApps.shouldRegister("drive")) {
    registerDriveEnrichments(enrichmentWorker, {
      store: driveStore,
      ai: assistantAi,
      autoTag: driveConfig.autoTagEnrichment,
    });
  }
  const outboxWorker = new OutboxWorker({
    store: outboxStore,
    events: eventBus,
    batchSize: bootEnv.OUTBOX_BATCH_SIZE,
    intervalMs: bootEnv.OUTBOX_POLL_INTERVAL_MS,
    onError: (error) => {
      app.log.error({ error }, "Outbox worker error");
    },
  });
  // Mail background workers run only when the mail app is registered in this
  // process (enabled org-wide AND in the booting role's app set).
  const mailAppRegistered = coreApps.shouldRegister("mail");
  const outboundMailConfig = mailAppRegistered ? mailCfg.outbound : undefined;
  const mailDkimKeyStore = new PostgresMailDkimKeyStore(
    sql,
    new KmsDkimPrivateKeyProtector(
      new KMSClient({
        region: bootEnv.MAIL_DKIM_KMS_REGION,
        ...(bootEnv.MAIL_DKIM_KMS_ENDPOINT === undefined
          ? {}
          : { endpoint: bootEnv.MAIL_DKIM_KMS_ENDPOINT }),
      }),
      bootEnv.MAIL_DKIM_KMS_KEY_ID,
    ),
  );
  const outboundProviderStore = new PostgresOutboundProviderStore(sql);
  const mailDeliveryEventStore = new PostgresMailDeliveryEventStore(sql);
  const sendingDomainStore = {
    listDomains: async (orgId: string) =>
      (await domainsStore.listDomains(orgId))
        .filter((domain) => domain.status === "verified" && domain.mailEnabled)
        .map((domain) => ({ ...domain, isDefault: domain.isPrimary })),
  };
  const mailSecretProvider = {
    resolveSecret: async (reference: string, orgId: string): Promise<string | undefined> =>
      (await tenantStorageSecretReader?.read({ orgId, scope: "mail-provider", handle: reference }))
        ?.credential,
  };
  const outboundTransportResolver = !mailAppRegistered
    ? undefined
    : new DispatchTimeTransportResolver({
        providerStore: outboundProviderStore,
        domainStore: sendingDomainStore,
        secrets: mailSecretProvider,
        dkimResolver: (orgId) => (from) => mailDkimKeyStore.resolveSigningKey(orgId, from),
        cacheTtlMs: 0,
        ...(outboundMailConfig === undefined
          ? {}
          : {
              environmentFallback: {
                id: "validated-smtp-relay",
                kind: "smtp",
                managed: true,
                buildTransport: async () => new NodemailerMailTransport(outboundMailConfig),
              },
            }),
      });
  const outboundMailWorker = !mailAppRegistered
    ? undefined
    : new OutboundMailWorker({
        store: mailStore,
        intervalMs: bootEnv.OUTBOX_POLL_INTERVAL_MS,
        batchSize: bootEnv.OUTBOX_BATCH_SIZE,
        dispatcher: new OutboundMailDispatcher(
          mailStore,
          async (outbound) => {
            if (outboundTransportResolver === undefined)
              throw new MailDeliveryError("Outbound routing is unavailable.", false);
            const decision = await outboundTransportResolver.transportFor(
              outbound.orgId,
              outbound.envelope.from.address.split("@").at(-1) ?? "",
              outbound.providerId,
            );
            const bound = await mailStore.bindOutboundProviderDecision({
              id: outbound.id,
              orgId: outbound.orgId,
              providerId: decision.providerId,
              providerKind: decision.providerKind,
              source: decision.source,
              leaseToken: outbound.leaseToken,
            });
            if (bound === null)
              throw new MailProviderConfigurationError(
                "MAIL_PROVIDER_DECISION_CONFLICT",
                "Outbound provider binding or lease changed before dispatch.",
              );
            return decision.source === "environment" && outboundMailConfig !== undefined
              ? new NodemailerMailTransport(outboundMailConfig, (from) =>
                  mailDkimKeyStore.resolveSigningKey(outbound.orgId, from),
                )
              : decision.transport;
          },
          {
            metrics,
            suppressionStore: mailDeliveryEventStore,
            // Stream/large attachments referenced by Drive objectId (G8 / Mail A2.5).
            resolveAttachment: async (objectId, context) => {
              const file = await driveStore.openFile({
                orgId: context.orgId,
                actorId: context.actorId,
                objectId,
              });
              if (file === null) {
                throw new MailDeliveryError(`Drive attachment ${objectId} is unavailable.`, false);
              }
              if (file.byteSize > bootEnv.MAIL_SMTP_MAX_MESSAGE_BYTES) {
                throw new MailDeliveryError(
                  `Drive attachment ${objectId} exceeds the outbound mail limit.`,
                  false,
                );
              }
              const body = await file.open();
              if (body === null) {
                throw new MailDeliveryError(`Drive attachment ${objectId} is unavailable.`, false);
              }
              return collectBoundedBytes(body, bootEnv.MAIL_SMTP_MAX_MESSAGE_BYTES);
            },
          },
        ),
        onError: (error) => {
          /* Name and message explicitly: pino renders a bare `{ error }` of a
                     custom Error subclass as `{}`, which is a log line that proves
                     something failed while withholding what. */
          app.log.error(
            {
              error,
              errorName: error instanceof Error ? error.name : typeof error,
              errorMessage: error instanceof Error ? error.message : String(error),
              ...(error instanceof MailProviderConfigurationError
                ? { operatorCode: error.operatorCode }
                : {}),
            },
            "Outbound mail dispatch error",
          );
        },
      });
  const signupFromAddress = {
    address: mailCfg.signupFrom.address,
    name: mailCfg.signupFrom.name,
  };
  const signupVerificationEmailWorker =
    identityMailTransport === undefined
      ? undefined
      : new SignupVerificationEmailWorker({
          events: eventBus,
          transport: identityMailTransport,
          from: signupFromAddress,
          onError: (error) => {
            app.log.error({ error }, "Signup verification email delivery error");
          },
        });
  const signupOnboardingInviteEmailWorker =
    identityMailTransport === undefined
      ? undefined
      : new SignupOnboardingInviteEmailWorker({
          events: eventBus,
          transport: identityMailTransport,
          from: signupFromAddress,
          onError: (error) => {
            app.log.error({ error }, "Signup onboarding invite email delivery error");
          },
        });
  const smtpMailReceiverConfig = mailAppRegistered ? mailCfg.receiver : undefined;
  // Config-gated inbound content scanners: spamd (SpamAssassin) and ClamAV.
  const smtpMailReceiver =
    smtpMailReceiverConfig === undefined
      ? undefined
      : new SmtpMailReceiver({
          store: mailStore,
          quarantineStore: mailQuarantineStore,
          resolveRecipient: (address) => mailStore.resolveInboundAddress(address),
          authorizeForward: async ({ orgId, actorId, content }) => {
            const decision = await dlp.evaluate({
              orgId,
              actorId,
              boundary: "mail_send",
              content,
            });
            return decision.action === "allow" || decision.action === "audit";
          },
          runForTenant: (orgId, operation) =>
            withTenantPostgresContext(sql, { orgId }, async () => operation()),
          transportSecurity: smtpMailReceiverConfig.transportSecurity,
          limits: smtpMailReceiverConfig.limits,
          logger: app.log,
          maxMessageBytes: smtpMailReceiverConfig.maxMessageBytes,
          maxRecipients: smtpMailReceiverConfig.maxRecipients,
          maxConnections: smtpMailReceiverConfig.maxConnections,
          socketTimeoutMs: smtpMailReceiverConfig.socketTimeoutMs,
          dataTimeoutMs: smtpMailReceiverConfig.dataTimeoutMs,
          scanners: inboundMailScanners,
          resolveScanFailurePolicy: async (orgId) => {
            if (securityTier !== "personal") {
              return "defer";
            }
            const org = await orgStore.findById(orgId);
            return org?.tier === "personal" ? "deliver" : "defer";
          },
          resolveAuthenticationPolicy: async (orgId) => {
            const org = await orgStore.findById(orgId);
            return parseInboundAuthenticationPolicy(org?.featureFlags.mail_inbound_policy);
          },
        });
  const smtpSubmissionConfig = mailAppRegistered ? mailCfg.submission : undefined;
  const smtpSubmissionServer =
    smtpSubmissionConfig === undefined
      ? undefined
      : new SmtpSubmissionServer({
          appPasswords: appPasswordStore,
          store: mailStore,
          tls: {
            key: await readFile(smtpSubmissionConfig.tlsKeyFile),
            cert: await readFile(smtpSubmissionConfig.tlsCertFile),
          },
          maxMessageBytes: smtpSubmissionConfig.maxMessageBytes,
          maxRecipients: smtpSubmissionConfig.maxRecipients,
          maxConnections: smtpSubmissionConfig.maxConnections,
          socketTimeoutMs: smtpSubmissionConfig.socketTimeoutMs,
          dataTimeoutMs: smtpSubmissionConfig.dataTimeoutMs,
          logger: app.log,
        });
  const outboundWebhookWorker = new OutboundWebhookWorker({
    store: webhookStore,
    secretResolver: webhookSecretResolver,
    events: eventBus,
    subject: bootEnv.WEBHOOK_EVENT_SUBJECT,
    retryBatchSize: bootEnv.WEBHOOK_RETRY_BATCH_SIZE,
    retryIntervalMs: bootEnv.WEBHOOK_RETRY_INTERVAL_MS,
    onError: (error) => {
      app.log.error({ error }, "Outbound webhook worker error");
    },
  });
  const auditVerifierWorker = envFlag("AUDIT_VERIFIER_ENABLED", true)
    ? new AuditVerifierWorker({
        store: auditStore,
        intervalMs: bootEnv.AUDIT_VERIFIER_INTERVAL_MS,
        ...(envFlag("AUDIT_VERIFIER_LEADER_LEASE", false)
          ? { lease: new PostgresAuditVerifierLease(sql) }
          : {}),
        onResult: (result) => {
          metrics.recordAuditHashChainVerification({
            failedOrgCount: result.failedOrgCount,
            verifiedAtSeconds: Date.parse(result.completedAt) / 1000,
          });
          app.log.info(
            {
              checkedOrgCount: result.checkedOrgCount,
              verifiedOrgCount: result.verifiedOrgCount,
              failedOrgCount: result.failedOrgCount,
              status: result.status,
              skippedReason: result.skippedReason,
            },
            "Audit verifier run completed",
          );
        },
        onError: (error) => {
          app.log.error({ error }, "Audit verifier worker error");
        },
      })
    : undefined;
  // Follow-up A: config-selectable audit shipping destinations. Each enabled
  // destination (`immutable-s3` | `siem-syslog` | `audit-immutable-postgres`)
  // gets its own AuditShippingWorker, built through `createAuditDestinationShipper`.
  // Every worker is leader-gated below alongside the other singleton workers.
  const auditDestinationConfigs = getAuditDestinationConfigs(process.env);
  const hardDeleteEnabled = envFlag("HELIX_TENANT_HARD_DELETE_WORKER_ENABLED", false);
  const deletionEvidence = auditDestinationConfigs.find(
    (config) => config.destination === "immutable-s3",
  );
  const deleteTenantSecrets =
    tenantStorageSecretReader?.deleteTenantSecrets.bind(tenantStorageSecretReader);
  if (hardDeleteEnabled && (deletionEvidence === undefined || deleteTenantSecrets === undefined)) {
    throw new Error("Tenant hard deletion requires immutable S3 evidence and a secret store.");
  }
  const tenantDeletionStore = new PostgresTenantDeletionStore(sql);
  const tenantHardDeleteWorker =
    hardDeleteEnabled && deletionEvidence !== undefined && deleteTenantSecrets !== undefined
      ? new TenantHardDeleteWorker({
          store: orgStore,
          steps: [
            {
              name: "verifiable-tenant-deletion",
              async run(org) {
                await new TenantDeletionWorkflow({
                  store: tenantDeletionStore,
                  storageResolver: driveStorageResolver,
                  proofStore: createStorageClientImmutableAuditStore(deletionEvidence.storage),
                  signer: deletionEvidence.signer,
                  ...(projectedSearchEngine === undefined ? {} : { search: projectedSearchEngine }),
                  ...(redis === undefined
                    ? {}
                    : { cache: createRedisTenantDeletionCachePurger(redis) }),
                  secrets: { deleteTenantSecrets },
                  proofRetentionDays: deletionEvidence.retentionDays,
                }).run(org);
              },
            },
          ],
          gracePeriodDays: bootEnv.TENANT_HARD_DELETE_RETENTION_DAYS,
          batchSize: bootEnv.TENANT_HARD_DELETE_BATCH_SIZE,
          intervalMs: bootEnv.TENANT_HARD_DELETE_INTERVAL_MS,
          onResult: (result) => {
            if (result.checked > 0) app.log.info(result, "Tenant hard-delete worker run completed");
          },
          onError: (error) => {
            app.log.error({ error }, "Tenant hard-delete worker error");
          },
        })
      : undefined;
  const auditShippingWorkers = auditDestinationConfigs.map((config) => {
    const shipper = createAuditDestinationShipper(config, {
      sql,
      audit: auditStore,
      metering: meteringClient,
      onMeteringError: (error: unknown) => {
        app.log.error(
          { error, destination: config.destination },
          "Audit storage metering emission failed",
        );
      },
    });
    return {
      name: `audit-shipping-${config.destination}`,
      worker: new AuditShippingWorker({
        store: auditStore,
        destination: config.destination,
        ...(config.batchSize === undefined ? {} : { batchSize: config.batchSize }),
        ...(config.intervalMs === undefined ? {} : { intervalMs: config.intervalMs }),
        shipper,
        onResult: (result) => {
          if (result.status === "shipped") {
            metrics.recordAuditShipping({
              destination: result.destination,
              recordCount: result.shippedRecordCount,
              lagSeconds: result.lagSeconds,
            });
          }
          metrics.setAuditShippingBacklog({
            destination: result.destination,
            recordCount: result.backlog.recordCount,
            lagSeconds: result.lagSeconds,
          });
        },
        onError: (error) => {
          metrics.recordAuditShippingFailure({ destination: config.destination });
          app.log.error({ error, destination: config.destination }, "Audit shipping worker error");
        },
      }),
    };
  });
  const eventSchemas = createEventSchemaRegistry([
    ...signupEventSchemas,
    {
      id: "platform.pending_action.created",
      subject: "platform.pending_action.created",
      title: "Pending action status",
      description: "A pending tool invocation was created or changed state.",
      direction: "publish",
      tags: ["Tools"],
      payloadSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
    {
      id: "platform.ai_cost.warning",
      subject: "platform.ai_cost.warning",
      title: "AI cost budget warning",
      description: "An actor has crossed 80% of a daily AI cost budget.",
      direction: "publish",
      tags: ["AI"],
      payloadSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
    {
      id: "quota.storage.exceeded",
      subject: "quota.storage.exceeded",
      title: "Storage quota exceeded",
      description: "A tenant storage quota denied object storage work before execution.",
      direction: "publish",
      tags: ["Quotas"],
      payloadSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
    {
      id: "quota.export_jobs.exceeded",
      subject: "quota.export_jobs.exceeded",
      title: "Export jobs quota exceeded",
      description: "A tenant export job quota denied work before execution.",
      direction: "publish",
      tags: ["Quotas"],
      payloadSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
    {
      id: "quota.api_rps.exceeded",
      subject: "quota.api_rps.exceeded",
      title: "API RPS quota exceeded",
      description: "A tenant API request-rate quota denied an HTTP request.",
      direction: "publish",
      tags: ["Quotas"],
      payloadSchema: {
        type: "object",
        additionalProperties: true,
      },
    },
  ]);
  const pendingActionStore = new PostgresPendingActionStore(sql);
  // PRD §9.9: confirmation timeout is configurable per security tier. The
  // default window is 10 minutes; stricter tiers expire approvals faster.
  const confirmationTimeoutMs = resolveConfirmationTimeoutMs(securityTier, process.env);
  const confirmationGate = new InMemoryConfirmationGate(pendingActionStore, {
    confirmationTimeoutMs,
    // P0-4(a): notify the pending action's owner when an approval is queued.
    // Publishing the platform event delivers the notification to the owner's
    // realtime feed and (because the outbound-webhook worker subscribes to all
    // events) also fans out to any configured webhook destination.
    onPendingActionCreated: async (record) => {
      try {
        await eventBus.publish("platform.pending_action.created", {
          id: record.id,
          orgId: record.orgId,
          actorId: record.actorId,
          toolId: record.toolId,
          status: record.status,
          createdAt: record.createdAt.toISOString(),
          expiresAt: record.expiresAt.toISOString(),
          ...(record.traceId === null ? {} : { traceId: record.traceId }),
        });
      } catch (error) {
        app.log.error(
          { error, pendingActionId: record.id },
          "Failed to publish pending action notification",
        );
      }
    },
    onPendingActionChanged: async (record) => {
      try {
        await eventBus.publish("platform.pending_action.created", {
          id: record.id,
          orgId: record.orgId,
          actorId: record.requesterActorId,
          toolId: record.toolId,
          status: record.status,
          createdAt: record.createdAt.toISOString(),
          expiresAt: record.expiresAt.toISOString(),
          ...(record.traceId === null ? {} : { traceId: record.traceId }),
        });
      } catch (error) {
        app.log.error(
          { error, pendingActionId: record.id, status: record.status },
          "Failed to publish pending action status notification",
        );
      }
    },
  });
  // P0-4(b): leader-gated worker that transitions stale pending_confirmation
  // actions to `expired` once their per-tier timeout elapses.
  const pendingActionExpiryWorker = new PendingActionExpiryWorker({
    store: pendingActionStore,
    intervalMs: bootEnv.PENDING_ACTION_EXPIRY_INTERVAL_MS,
    batchSize: bootEnv.PENDING_ACTION_EXPIRY_BATCH_SIZE,
    onResult: (result) => {
      if (result.expiredCount > 0 || result.recoveredUnknownCount > 0) {
        app.log.info(
          {
            expiredCount: result.expiredCount,
            recoveredUnknownCount: result.recoveredUnknownCount,
          },
          "Recovered stale pending tool actions",
        );
        for (const record of [...result.expired, ...result.recoveredUnknown]) {
          void eventBus
            .publish("platform.pending_action.created", {
              id: record.id,
              orgId: record.orgId,
              actorId: record.requesterActorId,
              toolId: record.toolId,
              status: record.status,
              createdAt: record.createdAt.toISOString(),
              expiresAt: record.expiresAt.toISOString(),
              ...(record.traceId === null ? {} : { traceId: record.traceId }),
            })
            .catch((error: unknown) => {
              app.log.error(
                { error, pendingActionId: record.id },
                "Failed to publish expired pending action notification",
              );
            });
        }
      }
    },
    onError: (error) => {
      app.log.error({ error }, "Pending action expiry worker error");
    },
  });
  const agentRateCostLimiter =
    redis === undefined ? new InMemoryAgentRateCostLimiter() : new RedisAgentRateCostLimiter(redis);
  const agentLimitBudgetOverride = agentLimitBudgetOverrideFromEnv(process.env);
  const toolAccessPolicy =
    bootEnv.CERBOS_HTTP_URL === undefined
      ? new ObservedToolAccessPolicy(new ScopeToolAccessPolicy(), {
          metrics,
          policyId: "scope",
        })
      : new ObservedToolAccessPolicy(
          new CerbosToolAccessPolicy({ endpoint: bootEnv.CERBOS_HTTP_URL }),
          {
            metrics,
            policyId: "cerbos",
          },
        );
  const featureFlags = new TenantConfigFeatureFlagProvider({
    environment: bootEnv.NODE_ENV,
    loadTenantConfig: async ({ orgId }) => {
      const org = await orgStore.findById(orgId);
      if (org === null) {
        return null;
      }
      return buildEffectiveTenantConfig({
        org,
        plan: await planStore.findById(org.planId),
      });
    },
  });
  const runtimeFeatureFlags = {
    get: featureFlags.get.bind(featureFlags),
    async getAsync<T>(
      key: string,
      defaultValue: T,
      context?: Parameters<typeof featureFlags.getAsync<T>>[2],
    ): Promise<T> {
      return featureFlags.getAsync(key, defaultValue, context);
    },
  };
  // A10: process-local emergency kill / per-org agent-write disable (admin-settable).
  const agentOperationalControls = new RuntimeAgentOperationalControlStore();
  const tools = createToolRegistry({
    accessPolicy: toolAccessPolicy,
    confirmationGate,
    confirmationDefaults: tierDefaults[securityTier],
    auditSink: auditStore,
    agentRateCostLimiter,
    agentLimitTier: securityTier,
    operationalControls: agentOperationalControls,
    ...(agentLimitBudgetOverride === undefined
      ? {}
      : { agentLimitBudget: agentLimitBudgetOverride }),
    metrics,
    featureFlags: runtimeFeatureFlags,
    dlp,
    resolvePendingPrincipal: async (record) => {
      if (record.requesterCredentialId === null) {
        const rows = (await sql`
          select id, org_id, type, display_name, email, scopes
          from actors
          where id = ${record.requesterActorId}
            and org_id = ${record.orgId}
            and disabled_at is null
          limit 1
        `) as unknown as readonly {
          readonly id: string;
          readonly org_id: string;
          readonly type: Actor["type"];
          readonly display_name: string;
          readonly email: string | null;
          readonly scopes: readonly string[];
        }[];
        const requester = rows[0];
        if (requester === undefined) {
          return null;
        }
        return {
          actor: {
            id: requester.id,
            orgId: requester.org_id,
            type: requester.type,
            displayName: requester.display_name,
            ...(requester.email === null ? {} : { email: requester.email }),
            scopes: requester.scopes,
          },
        };
      }
      const credential = await agentCredentialStore.findById(record.requesterCredentialId);
      if (
        credential === null ||
        credential.actorId !== record.requesterActorId ||
        credential.orgId !== record.orgId
      ) {
        return null;
      }
      const enforcement = enforceCredentialPolicy(credential, {
        ...(record.requesterIp === null ? {} : { ip: record.requesterIp }),
        ...(credential.certFingerprint === null
          ? {}
          : { certFingerprint: credential.certFingerprint }),
      });
      if (!enforcement.ok) {
        return null;
      }
      return {
        actor: {
          id: credential.actorId,
          orgId: credential.orgId,
          type: "agent",
          scopes: credential.scopes,
        },
        credentialId: credential.id,
        ...(credential.approvalOwnerActorId === undefined ||
        credential.approvalOwnerActorId === null
          ? {}
          : { credentialOwnerActorId: credential.approvalOwnerActorId }),
        credentialPolicy: credential.policy,
      };
    },
  });
  // P0-6 / PRD §8.4: auto-classify newly created resources. The feature tool
  // create / send / upload handlers call this classifier so mail messages,
  // chat messages, documents, and Drive files are classified and persisted as
  // soon as they are created. The hook is best-effort and never fails the
  // underlying tool call.
  const resourceClassifier = createResourceClassifier(resourceClassificationService, (error) => {
    app.log.error({ error }, "Resource auto-classification failed");
  });
  for (const tool of createAgentOperationalControlTools(agentOperationalControls)) {
    tools.register(tool);
  }
  registerWebhookTools(tools, { store: webhookStore, secretResolver: webhookSecretResolver });
  // Core-app agent tools are contributed per app, conditionally on enablement
  // + role: a disabled app contributes no tools to the registry, so it is
  // absent from REST, tRPC, MCP and the assistant.
  if (coreApps.shouldRegister("mail")) {
    registerMailTools(tools, {
      store: mailStore,
      defaultFromDomain: mailCfg.fromDomain,
      ...(resourceClassifier === undefined ? {} : { classifyResource: resourceClassifier }),
    });
    await registerCanonicalApi(app, async (api) => {
      registerMailDeliveryEventRoutes(api, {
        store: mailDeliveryEventStore,
        providerStore: outboundProviderStore,
        resolveSecret: async (orgId, handle) =>
          (await tenantStorageSecretReader?.read({ orgId, scope: "mail-provider", handle }))
            ?.credential,
      });
      registerMailStreamRoutes(api, {
        events: eventBus,
        resolveActor: async (request) => {
          const actor = await actorFromAuthenticatedRequest(request);
          return { id: actor.id, orgId: actor.orgId };
        },
      });
      registerMailSourceRoutes(api, {
        store: mailStore,
        actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      });
    });
  }
  if (coreApps.shouldRegister("chat")) {
    registerChatTools(tools, {
      store: chatStore,
      bus: chatRoomBus,
      ...(resourceClassifier === undefined ? {} : { classifyResource: resourceClassifier }),
    });
  }
  if (coreApps.shouldRegister("drive")) {
    registerDriveTools(tools, {
      store: driveStore,
      workflows: driveWorkflowStore,
      ...(resourceClassifier === undefined ? {} : { classifyResource: resourceClassifier }),
      // Owner-display resolver for drive.list responses. Batches actor
      // id → display_name + email lookups against the actors table so
      // the UI shows "Avery Park" / "leo@helix.local" instead of raw
      // UUIDs in the owner column.
      resolveActorNames: async (ids) => {
        if (ids.length === 0) return new Map();
        const rows = await sql<
          Array<{
            readonly id: string;
            readonly display_name: string | null;
            readonly email: string | null;
          }>
        >`
          select id, display_name, email
          from actors
          where id in ${sql(ids as string[])}
        `;
        const result = new Map<
          string,
          {
            displayName: string;
            email?: string;
          }
        >();
        for (const row of rows) {
          result.set(row.id, {
            displayName: row.display_name ?? row.email ?? row.id,
            ...(row.email === null ? {} : { email: row.email }),
          });
        }
        return result;
      },
      resolveShareActorRefs: async ({ orgId, refs }) => {
        const normalizedRefs = [
          ...new Set(refs.map((ref) => ref.trim().toLowerCase()).filter((ref) => ref.length > 0)),
        ];
        if (normalizedRefs.length === 0) {
          return { actorIds: [], unresolvedRefs: [] };
        }
        const rows = await sql<
          Array<{
            readonly id: string;
            readonly display_name: string | null;
            readonly email: string | null;
          }>
        >`
          select id, display_name, email
          from actors
          where org_id = ${orgId}
            and disabled_at is null
            and (
              lower(email) in ${sql(normalizedRefs)}
              or lower(display_name) in ${sql(normalizedRefs)}
            )
        `;
        const actorIds = new Set<string>();
        const matchedRefs = new Set<string>();
        for (const row of rows) {
          actorIds.add(row.id);
          const email = row.email?.trim().toLowerCase();
          const displayName = row.display_name?.trim().toLowerCase();
          if (email !== undefined && normalizedRefs.includes(email)) {
            matchedRefs.add(email);
          }
          if (displayName !== undefined && normalizedRefs.includes(displayName)) {
            matchedRefs.add(displayName);
          }
        }
        return {
          actorIds: [...actorIds],
          unresolvedRefs: normalizedRefs.filter((ref) => !matchedRefs.has(ref)),
        };
      },
      // ADM.6: single source of truth for external sharing — the admin security
      // policy. Public links and email-targeted shares honor mode/allowlist.
      getExternalSharingPolicy: async (orgId) =>
        securityPoliciesStore.get(orgId, "external_sharing"),
    });
  }
  const calendarInvitationSender = createMailCalendarInvitationSender({
    store: mailStore,
    defaultFromDomain: bootEnv.MAIL_FROM_DOMAIN,
  });
  const calendarInvitationDeliveryWorker =
    coreApps.shouldRegister("calendar") && mailAppRegistered
      ? new CalendarInvitationDeliveryWorker({
          store: calendarInvitationDeliveryStore,
          sender: calendarInvitationSender,
          intervalMs: bootEnv.OUTBOX_POLL_INTERVAL_MS,
          batchSize: bootEnv.OUTBOX_BATCH_SIZE,
          onError: (error) => {
            app.log.error({ error }, "Calendar invitation delivery error");
          },
        })
      : undefined;
  if (coreApps.shouldRegister("calendar")) {
    registerCalendarTools(tools, {
      store: calendarStore,
      invitationSender: calendarInvitationSender,
      rsvpBaseUrl: bootEnv.PUBLIC_BASE_URL ?? "http://localhost:3000",
    });
  }
  if (configuredMeetSecrets !== null) {
    const recordingAvailable =
      bootEnv.MEET_JIBRI_HEALTH_URL === undefined
        ? undefined
        : createJibriRecorderHealthCheck(bootEnv.MEET_JIBRI_HEALTH_URL);
    registerMeetTools(tools, {
      store: meetStore,
      jwtSecret: configuredMeetSecrets.jwtSecret,
      jwtAppId: bootEnv.MEET_JITSI_JWT_APP_ID ?? "helix",
      jwtIssuer: bootEnv.MEET_JITSI_JWT_ISSUER ?? "helix",
      jwtAudience: bootEnv.MEET_JITSI_JWT_AUDIENCE ?? "jitsi",
      jwtSubject: bootEnv.MEET_JITSI_DOMAIN ?? "meet.localhost",
      publicBaseUrl: bootEnv.PUBLIC_BASE_URL ?? "http://localhost:3000",
      // Full Jitsi origin (with port). Without this, joinUrls drop the
      // port and break in dev (Jitsi runs on :28452 via docker compose
      // --profile meet, not on the default :443).
      jitsiPublicUrl: bootEnv.MEET_JITSI_PUBLIC_URL,
      metrics,
      ...(recordingAvailable === undefined ? {} : { recordingAvailable }),
    });
  }
  if (runtimeSearchEngine !== undefined) {
    registerSearchTools(tools, { engine: runtimeSearchEngine });
  }
  const assistantSlashCommands = new AssistantSlashCommandHooks();
  if (!coreApps.shouldRegister("calendar")) {
    assistantSlashCommands.register("schedule", () => ({
      instruction:
        "Calendar scheduling is unavailable in this deployment. Explain that no calendar action was taken.",
      searchQuery: "",
      toolIds: [],
    }));
  }
  const assistantSearchTypes: readonly GlobalSearchType[] = [
    ...(coreApps.shouldRegister("mail") ? (["mail"] as const) : []),
    ...(coreApps.shouldRegister("chat") ? (["chat"] as const) : []),
    ...(coreApps.shouldRegister("drive") ? (["drive"] as const) : []),
    ...(coreApps.shouldRegister("calendar") ? (["calendar"] as const) : []),
  ];
  const assistantOrchestrator = new AssistantOrchestrator({
    store: assistantStore,
    ai: assistantAi,
    tools,
    memory: assistantMemory,
    ...(runtimeSearchEngine === undefined ? {} : { search: runtimeSearchEngine }),
    searchTypes: assistantSearchTypes,
    confirmationGate,
    slashCommands: assistantSlashCommands,
    classifyUserInput: async ({ content }) =>
      deriveClassification({ content, scanContent: true }).classification,
    blockHighRiskToolsWhenUntrusted: securityTier !== "personal",
  });
  if (coreApps.shouldRegister("assistant")) {
    registerAssistantTools(tools, {
      store: assistantStore,
      orchestrator: assistantOrchestrator,
    });
  }
  // Cross-surface notifications. The activity table is the audit chain;
  // notifications is a per-recipient inbox derived from that activity.
  registerNotificationTools(tools, {
    store: new PostgresNotificationStore(sql),
  });
  const pluginsDir =
    bootEnv.HELIX_PLUGINS_DIR ?? fileURLToPath(new URL("../../../plugins", import.meta.url));
  const pluginDiscovery = {
    tierDefaults: tierDefaults[securityTier],
    ...(pluginTrust === undefined ? {} : { pluginTrust }),
    onError: (artifact: string, error: unknown) => {
      app.log.error({ artifact, error }, "Rejected plugin artifact");
    },
  };
  const connectorResult = await loadConnectors({
    pluginsDir,
    ...pluginDiscovery,
    enabledPluginIds: new Set(),
    onConnectorLoaded: (manifest) => {
      app.log.info(
        { connectorId: manifest.id, version: manifest.version },
        "Loaded external connector",
      );
    },
    onConnectorSkipped: (manifest, reason) => {
      app.log.debug({ connectorId: manifest.id, reason }, "Skipped connector");
    },
    onConnectorError: (error, manifest) => {
      app.log.error({ error, connectorId: manifest.id }, "Failed to load connector");
    },
  });
  const pluginLifecycle = new PluginLifecycle({
    store: pluginLifecycleStore,
    pluginsDir,
    discovery: pluginDiscovery,
    runtime: connectorResult,
    events: eventBus,
    onError: (error, pluginId) => {
      app.log.error({ error, pluginId }, "Failed to reconcile plugin lifecycle");
    },
  });
  await pluginLifecycle.start();
  registerPluginTools(tools, {
    pluginsDir,
    discovery: pluginDiscovery,
    lifecycle: pluginLifecycle,
  });
  const leaderGatedWorkers: {
    readonly name: string;
    readonly worker: SupervisedWorker;
  }[] = [];
  registerAgentCredentialTools(tools, {
    store: agentCredentialStore,
    scopeCatalog: agentCredentialScopeCatalog,
  });
  registerAppPasswordTools(tools, { store: appPasswordStore });
  const trpcRouter = createHelixTRPCRouter({ tools, metrics, platformConfig });
  const readinessProbes: ReadinessProbe[] = [];
  await registerCanonicalApi(app, async (app) => {
    installHttpMetrics(app, metrics);
    // P2-1 / ADM.2: enforce MFA for admin-scoped requests when the security tier
    // requires it (Tier 2+) *or* the org MFA security policy is enabled+required.
    // Every `/api/admin/*` route shares this prefix so a single preHandler gates
    // the surface. Org policy is loaded from the admin security-policies store.
    app.addHook("preHandler", async (request, reply) => {
      const url = request.url.split("?")[0] ?? "";
      if (!isAdminMfaProtectedPath(url)) {
        return;
      }
      const actor = await actorFromAuthenticatedRequest(request);
      const orgMfaPolicy = await securityPoliciesStore.get(actor.orgId, "mfa");
      const decision = evaluateOrgAdminMfa({
        tier: securityTier,
        actor,
        mfaVerified: await mfaResolver.isMfaVerified(request, actor),
        orgMfaPolicy,
      });
      if (!decision.allowed) {
        const traceId = traceIdForRequest(request);
        app.log.warn(
          { actorId: actor.id, tier: securityTier, route: url },
          "Rejected admin-scoped request: verified MFA factor required",
        );
        return reply.code(decision.statusCode).send(
          buildErrorEnvelope({
            statusCode: decision.statusCode,
            code: decision.code,
            message: decision.message,
            traceId,
          }),
        );
      }
    });
    installCrownJewelGate(app, {
      store: new PostgresCrownJewelApprovalStore(sql),
      actorFromRequest: actorFromAuthenticatedRequest,
      mfa: mfaResolver,
      traceId: traceIdForRequest,
    });
    const trustedBrowserOrigins = normalizeTrustedOrigins([
      ...(betterAuthConfig?.trustedOrigins ?? []),
      betterAuthConfig?.baseUrl ??
        bootEnv.HELIX_PUBLIC_URL ??
        bootEnv.PUBLIC_BASE_URL ??
        "http://localhost:3000",
    ]);
    app.addHook("onRequest", async (request, reply) => {
      const origin = request.headers.origin;
      const csrfHeader = request.headers["x-helix-csrf-token"];
      if (
        !isTrustedCookieMutation({
          method: request.method,
          ...(origin === undefined ? {} : { origin }),
          ...(request.headers.cookie === undefined ? {} : { cookie: request.headers.cookie }),
          ...(typeof csrfHeader === "string" ? { csrfToken: csrfHeader } : {}),
          trustedOrigins: trustedBrowserOrigins,
        })
      ) {
        return reply.code(403).send(
          buildErrorEnvelope({
            statusCode: 403,
            code: "csrf_rejected",
            message: "Session-authenticated mutations require a trusted Origin and CSRF token.",
            traceId: traceIdForRequest(request),
          }),
        );
      }
    });
    await app.register(cors, {
      credentials: true,
      origin: (origin, callback) => {
        callback(null, isTrustedCorsOrigin(origin, trustedBrowserOrigins));
      },
    });
    await app.register(cookie);
    app.get("/api/auth/csrf-token", async (request, reply) => {
      const token = csrfTokenFromCookie(request.headers.cookie) ?? createCsrfToken();
      if (csrfTokenFromCookie(request.headers.cookie) === null) {
        reply.header("set-cookie", serializeCsrfCookie(token, bootEnv.NODE_ENV === "production"));
      }
      return { csrfToken: token };
    });
    registerDomainIdentityDiscoveryRoute(app, domainIdentityStore);
    registerBetterAuthRoutes(
      app,
      betterAuthRuntime?.auth,
      mfaAssurance,
      domainIdentityStore,
      recoveryCodes,
      betterAuthRuntime?.sessionVerifier,
    );
    await app.register(websocket, { options: { maxPayload: WEBSOCKET_MAX_PAYLOAD_BYTES } });
    await app.register(swagger, {
      openapi: {
        info: {
          title: "Helix Platform API",
          version: HELIX_SERVER_VERSION,
        },
        openapi: "3.1.0",
      },
    });
    await registerWebhookVerificationDocsRoute(app);
    await app.register(swaggerUi, { routePrefix: "/docs" });
    await app.register(fastifyTRPCPlugin, {
      prefix: "/trpc",
      trpcOptions: {
        router: trpcRouter,
        createContext: async ({ req }: CreateFastifyContextOptions) => ({
          request: createRequestContext(req),
          principal: await principalFromAuthenticatedRequest(req),
        }),
      },
    });
    await registerOAuthRoutes(app, {
      issuer: oauthIssuer,
      tokenService: new OAuthTokenService({
        clientStore: oauthStore,
        tokenStore: oauthStore,
        issuer: oauthIssuer,
        // PRD §13.6: enables the `authorization_code` token grant (PKCE).
        authorizationCodeService,
      }),
      clientStore: oauthStore,
      authorizationCodeService,
      authorizationStore: oauthAuthorizationStore,
      ...(betterAuthConfig === undefined ? {} : { consentSecret: betterAuthConfig.secret }),
      authorizeAuditSink: {
        recordRejection: async (input) => {
          app.log.warn({ oauthAuthorizationRejection: input }, "OAuth authorization rejected");
          if (input.orgId === null) {
            return;
          }
          await auditStore.append({
            orgId: input.orgId,
            actorId: input.actorId ?? "system",
            verb: "oauth.authorization.rejected",
            objectType: "oauth_client",
            metadata: {
              clientId: input.clientId,
              redirectUri: input.redirectUri,
              reason: input.reason,
              ...(input.metadata ?? {}),
            },
          });
        },
      },
      // The consent screen needs a logged-in end user; the BetterAuth session
      // resolver supplies that actor. When sessions are disabled the
      // Authorization Code endpoints stay disabled.
      ...(sessionActorResolver === undefined ? {} : { actorResolver: sessionActorResolver }),
    });
    await registerTenantScimRoutes(app, {
      orgs: orgStore,
      credentials: tenantScimCredentialStore,
      provisioning: scimProvisioningStore,
      auditSink: auditStore,
      metrics,
      documentationUri: bootEnv.HELIX_SCIM_DOCS_URL ?? "https://docs.helix.example/scim",
    });
    await registerAdminIdentityRoutes(app, {
      idpConfigs: tenantIdpConfigStore,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      auditSink: auditStore,
    });
    await registerAdminScimCredentialRoutes(app, {
      credentials: tenantScimCredentialStore,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      auditSink: auditStore,
    });
    await registerPlatformConfigAdminRoutes(app, {
      service: platformConfig,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    });
    await registerAdminServicesRoutes(app, {
      catalog: new AdminServicesCatalog({
        env: process.env,
      }),
      statusStore: new PostgresAdminServiceStatusStore(sql, {
        env: process.env,
      }),
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    });
    await registerPluginAdminRoutes(app, {
      tools,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    });
    if (coreApps.shouldRegister("mail")) {
      await registerMailAdminRoutes(app, {
        service: new MailAdminStatusService({
          env: process.env,
          deliveryHealthStore: mailStore,
        }),
        actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      });
      await registerMailDeliveryAdminRoutes(app, {
        providerStore: new PostgresOutboundProviderStore(sql),
        domainStore: domainsStore,
        dkimStore: mailDkimKeyStore,
        dmarcStore: new PostgresMailDmarcReportStore(sql),
        routingStore: new PostgresMailRoutingRuleStore(sql),
        actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
        auditSink: auditStore,
        verifyDkimDns: async ({ host, record }) =>
          (await resolveTxt(host)).some((parts) => parts.join("") === record),
      });
      registerMailQuarantineAdminRoutes(app, {
        store: mailQuarantineStore,
        mailStore,
        scanners: inboundMailScanners,
        resolveRecipient: (address) => mailStore.resolveInboundAddress(address),
        actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
        auditSink: auditStore,
      });
      registerOutboundMailAdminRoutes(app, {
        store: mailStore,
        deliveryStore: mailDeliveryEventStore,
        actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
        auditSink: auditStore,
      });
      const mailDeliveryAlertMonitor = new MailDeliveryAlertMonitor({
        store: mailDeliveryEventStore,
        emit: (alert) => {
          app.log.warn(
            {
              orgId: alert.orgId,
              category: alert.category,
              count: alert.count,
              threshold: alert.threshold,
              windowMinutes: alert.windowMinutes,
            },
            "Managed mail provider delivery threshold reached",
          );
        },
      });
      await registerMailProviderWebhookRoutes(app, {
        providerStore: outboundProviderStore,
        deliveryStore: mailDeliveryEventStore,
        secrets: mailSecretProvider,
        alertMonitor: mailDeliveryAlertMonitor,
        onSignatureFailure: ({ orgId, providerId }) => {
          app.log.warn({ orgId, providerId }, "Rejected managed mail provider webhook signature");
        },
      });
      await registerMailDeliveryEventAdminRoutes(app, {
        store: mailDeliveryEventStore,
        actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
        auditSink: auditStore,
      });
    }
    // Core-app enablement admin API: org admins view/toggle which core apps are
    // enabled org-wide. Toggling writes `config.modules[appId].enabled` through
    // the same platform-config store + hot-reload path as other config.
    await registerCoreAppsAdminRoutes(app, {
      service: platformConfig,
      role: coreApps.role,
      appIds: coreApps.appIds,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    });
    /* One request for Admin > Overview instead of five. The page reads five
         figures from five endpoints, which is the whole of the tenant's
         five-per-second budget on top of the three the app shell spends — so the
         console's landing page could not load without tripping the limiter it
         reports on. The readers below are the *same* functions the individual
         endpoints use, so the aggregate cannot drift away from the section pages,
         and each is caught separately so one dead source cannot blank the other
         four cards. */
    registerAdminOverviewRoutes(app, {
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      readDomains: (actor) => readDomainsWithRecords(adminDomainsStore, actor.orgId),
      readPolicies: (actor) => readSecurityPolicies(securityPoliciesStore, actor.orgId),
      readPlatformConfig: () => platformConfig.getStatus(),
      readDirectory: async (actor) => {
        /* Same page size Overview's Directory card asks for, so the aggregate and
                 the Users section share one reading rather than disagreeing by a page. */
        const users = await adminUsersStore.listUsers({
          orgId: actor.orgId,
          includeDisabled: true,
          limit: 250,
        });
        return { users, nextCursor: null };
      },
      readCoreApps: () =>
        buildCoreAppsAdminStatus({
          service: platformConfig,
          role: coreApps.role,
          appIds: coreApps.appIds,
        }),
      onSignalError: (input) => {
        app.log.error({ error: input.error, signal: input.signal }, "Admin overview signal failed");
      },
    });
    await registerAuditLogAdminRoutes(app, {
      store: auditStore,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    });
    // P0-7: admin API for per-user AI cost limits.
    registerAICostLimitAdminRoutes(app, {
      store: aiCostLimitStore,
      securityTier,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    });
    await registerAdminUsersRoutes(app, {
      store: adminUsersStore,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      // E7.2: production offboard cascade (org-scoped resolve + disable + sessions + credentials).
      offboardStores: {
        resolveTargetInOrg: (input) => actorExistsInOrg(sql, input),
        disableActor: (input) => disableActorForOffboard(sql, input),
        revokeSessionsForActor: (input) => revokeSessionsForActorSql(sql, input),
        appPasswords: appPasswordStore,
        agentCredentials: oauthStore,
      },
      invites: {
        invites: signupOnboardingInviteTokenStore,
        outbox: outboxStore,
        findOrgById: (orgId) => orgStore.findById(orgId),
        publicBaseUrl:
          bootEnv.BETTER_AUTH_URL ??
          bootEnv.HELIX_PUBLIC_URL ??
          bootEnv.PUBLIC_BASE_URL ??
          "http://localhost:3000",
      },
    });
    await registerPeopleRoutes(app, {
      store: new PostgresPeopleStore(sql),
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    });
    await registerDriveScanAdminRoutes(app, {
      store: driveStore,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      auditSink: auditStore,
    });
    // Wave-1 admin console: Groups & OUs, security policies, OAuth apps,
    // billing, and domain/DNS management. Each route group writes through the
    // immutable audit store so admin-console changes are tamper-evidently logged.
    await registerAdminGroupsRoutes(app, {
      store: new PostgresGroupsStore(sql),
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      auditSink: auditStore,
    });
    await registerGovernanceRoutes(app, {
      store: new PostgresGovernanceStore(sql, driveStorageResolver),
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      auditSink: auditStore,
    });
    await registerAdminSecurityPoliciesRoutes(app, {
      store: securityPoliciesStore,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      auditSink: auditStore,
    });
    await registerTenantConfigAdminRoutes(app, {
      store: orgStore,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      auditSink: auditStore,
      storageResolver: driveStorageResolver,
      storageMigrationJobs: tenantStorageMigrationJobStore,
      plans: planStore,
      featureFlagEvents: eventBus,
      onFeatureFlagEventError: (error) => {
        app.log.error({ error }, "Tenant feature flag change event emission failed");
      },
    });
    await registerTenantLifecycleRoutes(app, {
      orgs: orgStore,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      exportPlanner: createPostgresTenantExportManifestPlanner(sql),
      auditSink: auditStore,
      exportJobLimiter: tenantHourlyQuotaLimiter,
      exportJobLimit: async ({ org }) => {
        const plan = await planStore.findById(org.planId);
        return buildEffectiveTenantConfig({ org, plan }).quotas.export_jobs_per_hour;
      },
      events: eventBus,
      onEventError: (error) => {
        app.log.error({ error }, "Tenant export quota event emission failed");
      },
      metering: meteringClient,
      onMeteringError: (error: unknown) => {
        app.log.error({ error }, "Tenant export metering emission failed");
      },
    });
    await registerAdminOAuthAppsRoutes(app, {
      store: new PostgresOAuthAppsStore(sql),
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      auditSink: auditStore,
      onRevoke: async ({ orgId, actorId, app: oauthApp }) => {
        if (oauthApp.clientId === null) {
          return;
        }
        const credential = (await agentCredentialStore.list({ orgId, includeRevoked: false })).find(
          (candidate) => candidate.clientId === oauthApp.clientId,
        );
        if (credential !== undefined) {
          await agentCredentialStore.revoke({
            orgId,
            operatorActorId: actorId,
            credentialId: credential.id,
          });
        }
      },
    });
    await registerSignupRoutesForMode(app, {
      config: runtimeConfig,
      orgs: orgStore,
      provisioning: tenantProvisioningStore,
      verificationTokens: signupEmailVerificationTokenStore,
      identities: signupVerifiedIdentityStore,
      ...(betterAuthSessionIssuer === undefined ? {} : { sessionIssuer: betterAuthSessionIssuer }),
      outbox: outboxStore,
      abuse: signupAbuseProtector,
      ownerEmails: signupOwnerEmailLookup,
      passwordScreener: signupPasswordScreener,
      ...(signupRecaptchaVerifier === undefined ? {} : { recaptcha: signupRecaptchaVerifier }),
      riskReviewer: signupRiskReviewer,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      onboarding: signupOnboardingStore,
      onboardingInvites: signupOnboardingInviteTokenStore,
      metering: meteringClient,
      metrics,
      onMeteringError: (error: unknown) => {
        app.log.error({ error }, "Signup seat metering emission failed");
      },
      publicBaseUrl:
        bootEnv.BETTER_AUTH_URL ??
        bootEnv.HELIX_PUBLIC_URL ??
        bootEnv.PUBLIC_BASE_URL ??
        "http://localhost:3000",
    });
    if (isSaas(runtimeConfig)) {
      await registerAdminBillingRoutes(app, {
        store: new PostgresBillingStore(sql),
        actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      });
    }
    await registerAdminDomainsRoutes(app, {
      store: domainsStore,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      auditSink: auditStore,
      dnsResolver: new AuthoritativeDnsResolver(),
    });
    const backupAdminService = new ScriptedBackupAdminService({
      ...(bootEnv.HELIX_BACKUP_DIR === undefined
        ? {}
        : { backupDir: join(bootEnv.HELIX_BACKUP_DIR, bootEnv.HELIX_REGION) }),
      ...(bootEnv.HELIX_SECURITY_TIER === undefined ? {} : { tier: bootEnv.HELIX_SECURITY_TIER }),
      ...(bootEnv.HELIX_BACKUP_SCRIPT === undefined
        ? {}
        : { backupScript: bootEnv.HELIX_BACKUP_SCRIPT }),
      ...(bootEnv.HELIX_RESTORE_SCRIPT === undefined
        ? {}
        : { restoreScript: bootEnv.HELIX_RESTORE_SCRIPT }),
    });
    const restoreJobStore = new PostgresRestoreJobStore(sql);
    const restoreJobWorker = new RestoreJobWorker({
      store: restoreJobStore,
      executor: backupAdminService,
      auditSink: auditStore,
      onError: (error) => {
        app.log.error({ error }, "Backup restore worker error");
      },
    });
    await registerBackupAdminRoutes(app, {
      service: backupAdminService,
      restoreJobs: restoreJobStore,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      stepUpVerified: async (request) =>
        mfaResolver.isMfaVerified(request, await actorFromAuthenticatedRequest(request)),
      auditSink: auditStore,
    });
    leaderGatedWorkers.push({ name: "backup-restore-worker", worker: restoreJobWorker });
    if (searchReindexService !== undefined) {
      await registerSearchAdminRoutes(app, {
        service: searchReindexService,
        ...(searchReindexJobService === undefined ? {} : { jobs: searchReindexJobService }),
        actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      });
    }
    await registerEventRoutes(app, {
      bus: eventBus,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      /* `/events/ws` is exempt from the tenant request-rate meter, so this cap on
             concurrent streams is what bounds the resource instead. */
      streamLimiter: new EventStreamLimiter(),
      // Follow-up B: feed the helix_websocket_connections_active gauge.
      metrics,
      onError: (error) => {
        app.log.error({ error }, "Events websocket error");
      },
    });
    await registerWebhookRoutes(app, {
      store: webhookStore,
      tools,
      secretResolver: webhookSecretResolver,
    });
    // Core-app HTTP/WS routes are mounted per app, conditionally on enablement +
    // role. A disabled app's routes are never mounted (the web shell renders an
    // "app disabled" state for it instead).
    const chatRoutes = coreApps.shouldRegister("chat")
      ? await registerChatRoutes(app, {
          store: chatStore,
          attachments: chatAttachmentStore,
          tickets: new PostgresChatWebSocketTicketStore(sql),
          actorFromRequest: async (request) =>
            (await sessionActorResolver?.resolve(request)) ?? unauthenticatedActor,
          bus: chatRoomBus,
          presence: chatPresence,
          trustedOrigins,
          metrics,
          dlp,
          rateLimit: {
            capacity: bootEnv.CHAT_WS_RATE_LIMIT_CAPACITY,
            refillPerSecond: bootEnv.CHAT_WS_RATE_LIMIT_REFILL_PER_SECOND,
          },
          onError: (error) => {
            app.log.error({ error }, "Chat websocket error");
          },
        })
      : undefined;
    if (coreApps.shouldRegister("chat")) {
      await registerChatModerationRoutes(app, {
        store: chatModerationStore,
        actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
        audit: auditStore,
      });
    }
    if (coreApps.shouldRegister("calendar")) {
      await registerCalendarRoutes(app, {
        store: calendarStore,
        actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
        invitationSender: calendarInvitationSender,
      });
      await registerCalendarSchedulingRoutes(app, {
        store: calendarSchedulingStore,
        actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      });
      await registerCardDavRoutes(app, {
        appPasswords: appPasswordStore,
        store: cardDavContactStore,
      });
    }
    if (coreApps.shouldRegister("drive")) {
      await registerDriveRoutes(app, {
        store: driveStore,
        appPasswords: appPasswordStore,
        requireTls: driveConfig.isProduction,
        bodyLimitBytes: driveConfig.antivirus.maxFileBytes,
        dlp,
      });
      await registerDriveShareLinkRoute(app, {
        store: driveStore,
        actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
        dlp,
      });
      // Session-cookie-authenticated content stream for the Web UI. The /dav/*
      // routes registered above require app-password Basic Auth (the WebDAV
      // contract). The browser-driven "Open file" action in the Drive UI
      // needs a path it can hit with the existing helix_session cookie and
      // have the bytes streamed back. This route fills that gap.
      app.get<{
        Params: {
          objectId: string;
        };
      }>("/api/drive/objects/:objectId/content", async (request, reply) => {
        const actor = await actorFromAuthenticatedRequest(request);
        // G6: defense-in-depth scope gate on top of per-object ACL.
        requireActorScope(actor, "drive.read");
        const file = await driveStore.openFile({
          orgId: actor.orgId,
          actorId: actor.id,
          objectId: request.params.objectId,
        });
        if (file === null) {
          throw new NotFoundError("File not found.");
        }
        const dlpDecision = await dlp.evaluate({
          orgId: actor.orgId,
          actorId: actor.id,
          boundary: "drive_download",
          resources: [{ resourceType: "drive.file", resourceId: request.params.objectId }],
          traceId: request.id,
        });
        if (dlpDecision.action === "block" || dlpDecision.action === "quarantine") {
          throw dlpDecisionError(dlpDecision);
        }
        if (dlpDecision.action === "warn") {
          reply.header("x-helix-dlp-warning", dlpDecision.classification);
        }
        if (
          !(await driveStore.canExportFile({
            orgId: actor.orgId,
            actorId: actor.id,
            objectId: request.params.objectId,
          }))
        ) {
          throw new ForbiddenError("Export is disabled for this recording.");
        }
        const responseHeaders = safeDriveContentHeaders(
          file.entry.name,
          file.entry.mimeType ?? "application/octet-stream",
          false,
        );
        return sendStreamWithRangeSupport({
          reply,
          request,
          byteSize: file.byteSize,
          etag: file.etag,
          open: file.open,
          ...responseHeaders,
          lastModified: file.entry.updatedAt,
        });
      });
    }
    if (configuredMeetSecrets !== null) {
      await registerMeetRoutes(app, {
        store: meetStore,
        webhookSecret: configuredMeetSecrets.webhookSecret,
        jwtSecret: configuredMeetSecrets.jwtSecret,
        jwtIssuer: bootEnv.MEET_JITSI_JWT_ISSUER ?? "helix",
        jwtAudience: bootEnv.MEET_JITSI_JWT_AUDIENCE ?? "jitsi",
        jwtSubject: bootEnv.MEET_JITSI_DOMAIN ?? "meet.localhost",
        jitsiPublicUrl: bootEnv.MEET_JITSI_PUBLIC_URL,
        storageResolver: driveStorageResolver,
        ...(clamavScanner === undefined ? {} : { recordingScanner: clamavScanner }),
        requireRecordingScanner: bootEnv.NODE_ENV === "production" || securityTier !== "personal",
        requireRecordingEncryption:
          bootEnv.NODE_ENV === "production" || securityTier !== "personal",
        metrics,
        onError: (error) => {
          app.log.error({ error }, "Meet webhook error");
        },
      });
    }
    // P0-1: every singleton background worker must run on exactly one replica.
    // `pg_try_advisory_lock` previously protected only the audit verifier; the
    // outbox poller, webhook dispatcher, mail worker, enrichment worker, and
    // search indexer started unconditionally and so double-processed on any
    // multi-replica deploy. Each is now wrapped in a SingletonWorkerSupervisor
    // that holds a named leader lease for the worker's lifetime.
    //
    // PostgreSQL sessions may hold multiple independent advisory locks. Sharing
    // one lock client therefore preserves connection-bound lock ownership while
    // reserving only one pool connection, regardless of worker count.
    if (searchEventIndexer !== undefined) {
      leaderGatedWorkers.push({ name: "search-event-indexer", worker: searchEventIndexer });
    }
    if (searchMutationWorker !== undefined) {
      leaderGatedWorkers.push({ name: "search-mutation-worker", worker: searchMutationWorker });
    }
    if (searchShadowReindexWorker !== undefined) {
      leaderGatedWorkers.push({
        name: "search-shadow-reindex-worker",
        worker: searchShadowReindexWorker,
      });
    }
    if (searchReconciliationWorker !== undefined) {
      leaderGatedWorkers.push({
        name: "search-reconciliation-worker",
        worker: searchReconciliationWorker,
      });
    }
    leaderGatedWorkers.push({ name: "meet-lifecycle-worker", worker: meetLifecycleWorker });
    leaderGatedWorkers.push({ name: "ai-enrichment-worker", worker: enrichmentWorker });
    if (outboundMailWorker !== undefined) {
      leaderGatedWorkers.push({ name: "outbound-mail-worker", worker: outboundMailWorker });
    }
    if (calendarInvitationDeliveryWorker !== undefined) {
      leaderGatedWorkers.push({
        name: "calendar-invitation-delivery-worker",
        worker: calendarInvitationDeliveryWorker,
      });
    }
    if (signupVerificationEmailWorker !== undefined) {
      leaderGatedWorkers.push({
        name: "signup-verification-email-worker",
        worker: signupVerificationEmailWorker,
      });
    }
    if (signupOnboardingInviteEmailWorker !== undefined) {
      leaderGatedWorkers.push({
        name: "signup-onboarding-invite-email-worker",
        worker: signupOnboardingInviteEmailWorker,
      });
    }
    if (tenantProvisioningWorker !== undefined) {
      leaderGatedWorkers.push({
        name: "tenant-provisioning-worker",
        worker: tenantProvisioningWorker,
      });
    }
    if (tenantHardDeleteWorker !== undefined) {
      leaderGatedWorkers.push({
        name: "tenant-hard-delete-worker",
        worker: tenantHardDeleteWorker,
      });
    }
    if (meteringIngestWorker !== undefined) {
      leaderGatedWorkers.push({
        name: "metering-ingest-worker",
        worker: meteringIngestWorker,
      });
    }
    if (meteringRollupWorker !== undefined) {
      leaderGatedWorkers.push({
        name: "metering-rollup-nightly",
        worker: meteringRollupWorker,
      });
    }
    if (byoStorageHealthWorker !== undefined) {
      leaderGatedWorkers.push({
        name: "byo-storage-health-refresh-worker",
        worker: byoStorageHealthWorker,
      });
    }
    if (tenantStorageMigrationWorker !== undefined) {
      leaderGatedWorkers.push({
        name: "tenant-storage-migration-worker",
        worker: tenantStorageMigrationWorker,
      });
    }
    if (driveVirusScanRetryWorker !== undefined) {
      leaderGatedWorkers.push({
        name: "drive-virus-scan-retry-worker",
        worker: driveVirusScanRetryWorker,
      });
    }
    if (chatRetentionWorker !== undefined) {
      leaderGatedWorkers.push({
        name: "chat-retention-worker",
        worker: chatRetentionWorker,
      });
    }
    if (smtpMailReceiver !== undefined && smtpMailReceiverConfig !== undefined) {
      const receiver = smtpMailReceiver;
      const receiverConfig = smtpMailReceiverConfig;
      leaderGatedWorkers.push({
        name: "smtp-mail-receiver",
        worker: {
          start: () => receiver.listen(receiverConfig.port, receiverConfig.host),
          stop: () => receiver.close(),
        },
      });
    }
    if (smtpSubmissionServer !== undefined && smtpSubmissionConfig !== undefined) {
      const submission = smtpSubmissionServer;
      const config = smtpSubmissionConfig;
      leaderGatedWorkers.push({
        name: "smtp-submission-server",
        worker: {
          start: () => submission.listen(config.port, config.host),
          stop: () => submission.close(),
        },
      });
    }
    leaderGatedWorkers.push({ name: "outbox-worker", worker: outboxWorker });
    leaderGatedWorkers.push({
      name: "mail-attachment-cleanup-worker",
      worker: mailAttachmentCleanupWorker,
    });
    leaderGatedWorkers.push({ name: "mail-trash-purge-worker", worker: mailTrashPurgeWorker });
    leaderGatedWorkers.push({ name: "outbound-webhook-worker", worker: outboundWebhookWorker });
    // Follow-up A: leader-gate every configured audit-shipping destination worker
    // exactly like the other singleton workers, so multi-replica deploys do not
    // double-ship audit batches.
    for (const { name, worker } of auditShippingWorkers) {
      leaderGatedWorkers.push({ name, worker });
    }
    leaderGatedWorkers.push({
      name: "pending-action-expiry-worker",
      worker: pendingActionExpiryWorker,
    });
    const workerRetryIntervalMs = bootEnv.LEADER_ELECTION_RETRY_INTERVAL_MS;
    const workerLockClient = new PostgresAdvisoryLockClient(sql);
    const workerSupervisors = leaderGatedWorkers.map(
      ({ name, worker }) =>
        new SingletonWorkerSupervisor({
          name,
          worker,
          election: new LeaderElection(workerLockClient),
          retryIntervalMs: workerRetryIntervalMs,
          onLeadershipAcquired: (workerName) => {
            app.log.info({ worker: workerName }, "Singleton worker leadership acquired");
          },
          onLeadershipSkipped: (workerName) => {
            app.log.info(
              { worker: workerName },
              "Singleton worker leadership held by another replica; standing by",
            );
          },
          onError: (error, workerName) => {
            app.log.error({ error, worker: workerName }, "Singleton worker leader election error");
          },
        }),
    );
    await Promise.all(workerSupervisors.map((supervisor) => supervisor.start()));
    // The audit verifier keeps its own per-run leader lease (it sweeps daily, so
    // gating each brief run is sufficient and avoids holding a connection idle).
    auditVerifierWorker?.start();
    app.log.info(
      {
        connectors: connectorResult.loaded.map((connector) => connector.manifest.id),
        webhookFormats: connectorResult.registry.webhookFormats().map((format) => format.id),
      },
      "External connector runtime ready",
    );
    // Expose the loaded-connector view via an admin read route so operators can
    // confirm which external connectors were genuinely loaded.
    registerConnectorsAdminRoute(app, {
      connectors: connectorResult,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    });
    // P2-4: wire config hot-reload. `subscribeToConfigHotReload` was implemented
    // and tested but never called — without this, NATS-published config changes
    // (`helix.config.changed`, emitted by the platform-config admin API) had no
    // runtime effect. On each change the config is re-merged from the same
    // sources and the runtime holder is swapped so runtime readers observe it.
    const unsubscribeConfigHotReload = await subscribeToConfigHotReload({
      events: eventBus,
      reload: () => loadHelixConfig(configSources),
      onReload: (config) => {
        runtimeConfig = config;
        void import("./platform/ai/operator-settings.js").then(
          ({ applyOperatorAiFromHelixConfig }) => {
            applyOperatorAiFromHelixConfig(config);
          },
        );
        app.log.info({ tier: config.security.tier }, "Applied hot-reloaded platform configuration");
      },
    });
    app.addHook("onClose", async () => {
      await pluginLifecycle.close();
      connectorResult.close();
      try {
        chatRoutes?.broadcastShutdown();
      } catch (error) {
        app.log.error({ error }, "Failed to broadcast chat shutdown");
      }
      // Stop supervisors first: each releases its leader lease so a surviving
      // replica can take over the worker immediately.
      await Promise.allSettled(workerSupervisors.map((supervisor) => supervisor.stop()));
      await auditVerifierWorker?.stop();
      await Promise.resolve(unsubscribeConfigHotReload()).catch((error: unknown) => {
        app.log.error({ error }, "Failed to unsubscribe config hot-reload");
      });
      if (redis !== undefined) {
        redis.disconnect();
      }
      await eventBus.close();
      await betterAuthRuntime?.pool.end();
      await sql.end({ timeout: 5 });
    });
    const migrationSources = await resolvePlatformMigrationSources();
    readinessProbes.push(
      {
        id: "database",
        check: async () => {
          await sql`select 1`;
        },
      },
      {
        id: "migrations",
        check: async () => {
          if ((await listPendingMigrations(sql, migrationSources)).length > 0) {
            throw new Error("pending database migrations");
          }
        },
      },
      {
        id: "workers",
        check: async () => {
          if (workerSupervisors.some((supervisor) => !supervisor.isHealthy)) {
            throw new Error("a required worker supervisor is unhealthy");
          }
        },
      },
    );
    const registeredApps = new Set<string>(coreApps.registeredAppIds());
    const storageRequired = ["mail", "drive", "docs", "editors"].some((id) =>
      registeredApps.has(id),
    );
    if (storageRequired) {
      readinessProbes.push({
        id: "object-storage",
        check: async () => {
          if (driveStorage === undefined) {
            throw new Error("object storage is not configured");
          }
          await driveStorage.checkHealth();
        },
      });
    }
    const distributedServicesRequired = securityTier !== "personal";
    if (distributedServicesRequired || redis !== undefined) {
      readinessProbes.push({
        id: "redis",
        check: async () => {
          if (redis === undefined) {
            throw new Error("Redis is unavailable");
          }
          await redis.ping();
        },
      });
    }
    if (distributedServicesRequired || bootEnv.NATS_URL !== undefined) {
      readinessProbes.push({
        id: "event-queue",
        check: async () => {
          if (!(eventBus instanceof NatsEventBus)) {
            throw new Error("a durable event queue is not configured");
          }
          await eventBus.checkHealth();
        },
      });
    }
    const productionServiceRequired = bootEnv.NODE_ENV === "production";
    if (productionServiceRequired || distributedServicesRequired || searchEngine !== undefined) {
      readinessProbes.push({
        id: "search",
        check: async () => {
          if (searchEngine === undefined) {
            throw new Error("search is not configured");
          }
          await searchEngine.search({
            query: "",
            limit: 1,
            filter: 'attributes.orgId = "__helix_readiness__"',
          });
        },
      });
    }
    if (productionServiceRequired || distributedServicesRequired) {
      readinessProbes.push({
        id: "identity-keys",
        check: async () => {
          if (betterAuthRuntime === undefined || betterAuthConfig === undefined) {
            throw new Error("session identity keys are not configured");
          }
        },
      });
    }
    if (
      (registeredApps.has("mail") || registeredApps.has("drive") || registeredApps.has("chat")) &&
      (productionServiceRequired || distributedServicesRequired)
    ) {
      readinessProbes.push({
        id: "antivirus",
        check: async () => {
          if (clamavScanner === undefined) {
            throw new Error("antivirus is not configured");
          }
          await clamavScanner.checkReadiness({
            maxSignatureAgeMs: driveConfig.antivirus.maxSignatureAgeMs,
          });
        },
      });
    }
    if (tierDefaults[securityTier].auditHashChain) {
      const configuredDestinations = new Set<string>(
        auditDestinationConfigs.map((config) => config.destination),
      );
      const requiredDestinations = tierDefaults[securityTier].auditDestinations
        .filter((destination) => destination !== "postgres")
        .map((destination) =>
          destination === "siem"
            ? "siem-syslog"
            : destination === "worm"
              ? "audit-immutable-postgres"
              : destination,
        );
      readinessProbes.push({
        id: "audit",
        check: async () => {
          const shippingWorkersHealthy = auditShippingWorkers.every(({ name, worker }) => {
            const supervisor = workerSupervisors.find((candidate) => candidate.name === name);
            return (
              supervisor !== undefined &&
              supervisor.isHealthy &&
              (!supervisor.isLeader || worker.isHealthy)
            );
          });
          if (
            auditVerifierWorker === undefined ||
            !auditVerifierWorker.isHealthy ||
            !shippingWorkersHealthy ||
            requiredDestinations.some((destination) => !configuredDestinations.has(destination))
          ) {
            throw new Error("a required audit worker is not configured");
          }
        },
      });
    }
    app.get("/metrics", async (_request, reply) => {
      reply.header("content-type", metrics.registry.contentType);
      return metrics.registry.metrics();
    });
    app.get("/api/tools", async (request) => ({
      tools: (await tools.listVisible(await actorFromAuthenticatedRequest(request))).map(
        projectToolListItem,
      ),
    }));
    // Core-app enablement, projected for the web shell. Any authenticated user
    // can read this — the shell drives its left rail + route gating from it so
    // a disabled (or out-of-role) core app is never shown or routed to. Admins
    // toggle enablement via `/api/admin/core-apps`.
    app.get("/api/core-apps", async (request) => {
      await actorFromAuthenticatedRequest(request);
      const status = await platformConfig.getStatus();
      const modules = status.config.modules;
      const currentCoreApps = resolveCoreAppStatuses({
        ...(modules === undefined ? {} : { modules }),
        role: coreApps.role,
        appIds: coreApps.appIds,
      });
      return {
        role: coreApps.role,
        apps: currentCoreApps.statuses.map((appStatus) => ({
          id: appStatus.id,
          name: appStatus.name,
          enabled: appStatus.enabled,
          registered: coreApps.status(appStatus.id).registered,
        })),
      };
    });
    // PRD §9.5: the assistant SSE streaming endpoint. Registered before the
    // parametric `/api/tools/:toolId` route so the static `assistant.chat` path
    // takes precedence and can negotiate `text/event-stream` for streamed turns.
    registerAssistantStreamRoute(app, {
      orchestrator: assistantOrchestrator,
      tools,
      tokenStore: oauthStore,
      credentialStore: agentCredentialStore,
      ...(sessionActorResolver === undefined ? {} : { sessionResolver: sessionActorResolver }),
      onError: (error) => {
        app.log.error({ error }, "Assistant SSE stream error");
      },
    });
    registerToolRestRoutes(
      app,
      {
        tools,
        metrics,
        tokenStore: oauthStore,
        idempotencyStore,
        credentialStore: agentCredentialStore,
        ...(sessionActorResolver === undefined ? {} : { sessionResolver: sessionActorResolver }),
      },
      ["POST"],
    );
    registerActionStatusRoutes(app, {
      tools,
      tokenStore: oauthStore,
      credentialStore: agentCredentialStore,
      ...(sessionActorResolver === undefined ? {} : { sessionResolver: sessionActorResolver }),
    });
    registerPendingActionMutationRoutes(app, {
      tools,
      tokenStore: oauthStore,
      credentialStore: agentCredentialStore,
      ...(sessionActorResolver === undefined ? {} : { sessionResolver: sessionActorResolver }),
    });
    registerToolRestRoutes(
      app,
      {
        tools,
        metrics,
        tokenStore: oauthStore,
        credentialStore: agentCredentialStore,
        ...(sessionActorResolver === undefined ? {} : { sessionResolver: sessionActorResolver }),
      },
      ["GET"],
    );
    app.get("/openapi.json", async () =>
      buildOpenApiDocument(app.swagger(), await tools.listVisible(systemActor)),
    );
    // P1-10: YAML rendering of the OpenAPI document alongside the JSON form.
    app.get("/openapi.yaml", async (_request, reply) => {
      const document = buildOpenApiDocument(app.swagger(), await tools.listVisible(systemActor));
      reply.header("content-type", "application/yaml; charset=utf-8");
      return openApiDocumentToYaml(document);
    });
    app.get("/asyncapi.json", async () => buildAsyncApiDocument({}, eventSchemas.list()));
    const mcpResourceProvider = () =>
      createStoreBackedMcpResourceProvider({
        chat: chatStore,
        calendar: calendarStore,
        mail: mailStore,
        drive: driveStore,
      });
    app.post("/mcp", async (request, reply) => {
      const principal = await principalFromAuthenticatedRequest(request);
      const requestContext = createRequestContext(request);
      // PRD §9.5: when the client negotiates SSE, stream the JSON-RPC response
      // over text/event-stream so long-running tool calls keep the connection
      // warm; otherwise fall back to a plain JSON-RPC POST response.
      if (acceptsEventStream(request)) {
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "api-version": HELIX_API_VERSION_HEADER_VALUE,
        });
        for await (const event of handleMcpStreamingRequest({
          tools,
          principal,
          request: requestContext,
          body: request.body,
          resources: mcpResourceProvider(),
          idempotencyStore,
        })) {
          reply.raw.write(formatSseEvent(event));
        }
        reply.raw.end();
        return reply;
      }
      return handleMcpJsonRpcRequest({
        tools,
        principal,
        request: requestContext,
        body: request.body,
        resources: mcpResourceProvider(),
        idempotencyStore,
      });
    });
  });
  // Kubernetes probes are process lifecycle endpoints, not product API
  // operations, and intentionally remain at their conventional root paths.
  registerHealthRoutes(app, new ReadinessMonitor(readinessProbes));
  return app;
}
export function isAdminMfaProtectedPath(url: string): boolean {
  const path = url.split("?")[0] ?? "";
  return (
    path.startsWith("/api/admin/") ||
    path === "/trpc/tools.explain" ||
    path.startsWith("/trpc/admin.")
  );
}
/** True when the client accepts an SSE stream for the MCP transport. */
function acceptsEventStream(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  const value = Array.isArray(accept) ? accept.join(",") : accept;
  return typeof value === "string" && value.includes("text/event-stream");
}
/** Registers a product API once, beneath the only supported major-version path. */
export async function registerCanonicalApi(
  app: FastifyInstance,
  plugin: FastifyPluginAsync,
): Promise<void> {
  await app.register(
    async (api) => {
      // Routing has already selected the versioned route at this point. Keep
      // handler-local path parsing independent of the deployment prefix (DAV,
      // webhook signatures, and Better Auth all parse request.url themselves)
      // without making the unversioned URL routable.
      api.addHook("onRequest", async (request) => {
        request.raw.url = internalApiUrl(request.raw.url ?? "/");
      });
      await plugin(api, {});
    },
    { prefix: HELIX_API_VERSION_PREFIX },
  );
}
function registerBetterAuthRoutes(
  app: FastifyInstance,
  auth: BetterAuthInstance | undefined,
  mfaAssurance?: MfaAssuranceMarker,
  domainIdentity?: Pick<PostgresDomainIdentityStore, "canonicalize">,
  recoveryCodes?: PostgresRecoveryCodeBroker,
  sessionVerifier?: BetterAuthSessionVerifier,
): void {
  if (auth === undefined) {
    return;
  }
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const path = request.url.split("?")[0] ?? "";
      const sessionUser = await sessionVerifier?.getSessionUser({ headers: request.headers });
      const sessionToken = await sessionVerifier?.getSessionToken?.({ headers: request.headers });
      let requestBody = request.body;
      if (
        request.method === "POST" &&
        path === "/api/auth/sign-in/email" &&
        request.tenant !== null &&
        typeof request.body === "object" &&
        request.body !== null &&
        "email" in request.body &&
        typeof request.body.email === "string" &&
        domainIdentity !== undefined
      ) {
        const email = await domainIdentity.canonicalize(request.tenant.orgId, request.body.email);
        if (email === null) {
          return reply.code(403).send({ message: "Sign-in is unavailable for this domain." });
        }
        requestBody = { ...request.body, email };
      }
      if (
        recoveryCodes !== undefined &&
        (path === "/api/auth/passkey/generate-register-options" ||
          path === "/api/auth/passkey/verify-registration" ||
          path === "/api/auth/passkey/delete-passkey") &&
        (sessionToken === null ||
          sessionToken === undefined ||
          !(await recoveryCodes.isRecentSession(sessionToken)))
      ) {
        return reply.code(403).send({ code: "recent_authentication_required" });
      }
      if (
        recoveryCodes !== undefined &&
        path === "/api/auth/two-factor/verify-backup-code" &&
        typeof requestBody === "object" &&
        requestBody !== null &&
        "code" in requestBody &&
        typeof requestBody.code === "string"
      ) {
        const bridge = await recoveryCodes.consume(requestBody.code);
        requestBody = { ...requestBody, code: bridge ?? "invalid-recovery-code" };
      }
      const response = await auth.handler(createBetterAuthRequest(request, requestBody));
      let body = response.body === null ? null : await response.text();
      if (
        response.ok &&
        recoveryCodes !== undefined &&
        sessionUser !== null &&
        sessionUser !== undefined &&
        (path === "/api/auth/two-factor/enable" ||
          path === "/api/auth/two-factor/generate-backup-codes")
      ) {
        const payload = jsonRecord(body);
        const bridgeCodes = payload?.backupCodes;
        if (
          payload !== null &&
          Array.isArray(bridgeCodes) &&
          bridgeCodes.every((code): code is string => typeof code === "string")
        ) {
          body = JSON.stringify({
            ...payload,
            backupCodes: await recoveryCodes.replace(sessionUser.id, bridgeCodes),
          });
        }
      }
      if (
        response.ok &&
        recoveryCodes !== undefined &&
        sessionUser !== null &&
        sessionUser !== undefined &&
        path === "/api/auth/two-factor/disable"
      ) {
        await recoveryCodes.clear(sessionUser.id);
      }
      const verifiedSessionToken = verifiedMfaSessionToken(
        request.url,
        response.status,
        body,
        response.headers.get("set-cookie"),
      );
      const issuedSessionToken = authResponseSessionToken(body, response.headers.get("set-cookie"));
      if (
        verifiedSessionToken !== null &&
        !(await mfaAssurance?.markVerifiedSession(verifiedSessionToken))
      ) {
        throw new Error("Verified MFA session could not be bound to server-side assurance.");
      }
      if (
        response.ok &&
        recoveryCodes !== undefined &&
        sessionUser !== null &&
        sessionUser !== undefined &&
        FACTOR_MUTATION_PATHS.has(path)
      ) {
        await recoveryCodes.invalidateOtherSessions(
          sessionUser.id,
          issuedSessionToken ?? sessionToken ?? null,
        );
      }
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key !== "content-length") reply.header(key, value);
      });
      return reply.send(body);
    },
  });
}
const FACTOR_MUTATION_PATHS = new Set([
  "/api/auth/two-factor/enable",
  "/api/auth/two-factor/disable",
  "/api/auth/two-factor/verify-totp",
  "/api/auth/two-factor/generate-backup-codes",
  "/api/auth/passkey/verify-registration",
  "/api/auth/passkey/delete-passkey",
]);
function jsonRecord(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
function createBetterAuthRequest(request: FastifyRequest, body = request.body): Request {
  const url = new URL(request.url, `${request.protocol}://${request.hostname}`);
  const headers = fromNodeHeaders(request.headers);
  for (const name of [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
  ]) {
    headers.delete(name);
  }
  headers.set("x-forwarded-for", request.ip);
  headers.set("x-forwarded-host", request.hostname);
  headers.set("x-forwarded-proto", request.protocol);
  headers.delete("content-length");
  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD" && body !== undefined) {
    init.body = requestBodyForFetch(body);
  }
  return new Request(url, init);
}
function requestBodyForFetch(body: unknown): NonNullable<RequestInit["body"]> {
  if (typeof body === "string" || body instanceof Blob || body instanceof FormData) {
    return body;
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return body as NonNullable<RequestInit["body"]>;
  }
  return JSON.stringify(body);
}
type AgentLimitBudgetOverride = {
  requestsPerMinute?: number | null;
  requestsPerDay?: number | null;
  costPerDayUsdMicros?: number | null;
  costWarningThresholdRatio?: number;
};
function agentLimitBudgetOverrideFromEnv(
  env: NodeJS.ProcessEnv,
): Partial<AgentLimitBudget> | undefined {
  const override: AgentLimitBudgetOverride = {};
  assignLimitOverride(override, "requestsPerMinute", env.HELIX_AGENT_LIMIT_REQUESTS_PER_MINUTE);
  assignLimitOverride(override, "requestsPerDay", env.HELIX_AGENT_LIMIT_REQUESTS_PER_DAY);
  assignLimitOverride(
    override,
    "costPerDayUsdMicros",
    env.HELIX_AGENT_LIMIT_COST_PER_DAY_USD_MICROS,
  );
  if (env.HELIX_AGENT_LIMIT_COST_WARNING_RATIO !== undefined) {
    const ratio = Number(env.HELIX_AGENT_LIMIT_COST_WARNING_RATIO);
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
      throw new Error("HELIX_AGENT_LIMIT_COST_WARNING_RATIO must be greater than 0 and at most 1");
    }
    override.costWarningThresholdRatio = ratio;
  }
  return Object.keys(override).length === 0 ? undefined : override;
}
function assignLimitOverride(
  override: AgentLimitBudgetOverride,
  key: "requestsPerMinute" | "requestsPerDay" | "costPerDayUsdMicros",
  rawValue: string | undefined,
): void {
  if (rawValue === undefined) {
    return;
  }
  const value = rawValue.trim().toLowerCase();
  if (value === "null" || value === "none" || value === "unlimited") {
    override[key] = null;
    return;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw new Error(
      `HELIX_AGENT_LIMIT override for ${key} must be a non-negative integer or unlimited`,
    );
  }
  override[key] = parsed;
}
async function invokeTool(
  tools: RuntimeToolRegistry,
  principal: ToolInvocationPrincipal,
  toolId: string,
  input: unknown,
  request: FastifyRequest,
) {
  const result = await tools.invoke(toolId, input, {
    ...toolInvocationOptions(principal, createRequestContext(request)),
    enforceConfirmation: true,
    ...(requestHasCrownJewelApproval(request) ? { skipConfirmation: true } : {}),
  });
  return result;
}
function sendToolInvokeError(reply: FastifyReply, result: ToolInvokeErrorResult, traceId: string) {
  if (result.retryAfterSeconds !== undefined) {
    reply.header("retry-after", String(result.retryAfterSeconds));
  }
  // P1-10: single canonical error envelope with a traceId across every surface.
  return reply.code(result.statusCode).send(toolErrorEnvelope(result, traceId));
}
function createAssistantAIRouter(
  provenance: PostgresAIProvenanceStore,
  options: {
    readonly costLimiter: AICostLimiter;
    readonly metering?: MeteringClient;
    readonly onMeteringError?: (error: unknown) => void;
    readonly metrics: PlatformMetrics;
    readonly securityTier: SecurityTier;
    readonly onCostWarning?: (event: AICostWarningEvent) => void;
    readonly aiConfig?: AiConfig;
  },
): AIRouter {
  const defaultProviderId = env().ASSISTANT_AI_PROVIDER_ID ?? env().AI_DEFAULT_PROVIDER_ID;
  const configuredRouting = aiRoutingPolicyFromConfig(options.aiConfig);
  const featureRoutes =
    defaultProviderId === undefined
      ? configuredRouting.featureRoutes
      : {
          ...(configuredRouting.featureRoutes ?? {}),
          "assistant.chat": { primary: { providerId: defaultProviderId } },
        };
  return new AIRouter({
    providers: createAssistantProviders(options.aiConfig),
    costGuard: createAICostGuard({
      limiter: options.costLimiter,
      tier: options.securityTier,
      ...(options.onCostWarning === undefined ? {} : { onWarning: options.onCostWarning }),
    }),
    metrics: options.metrics,
    provenance,
    ...(options.metering === undefined
      ? {}
      : {
          metering: options.metering,
          ...(options.onMeteringError === undefined
            ? {}
            : { onMeteringError: options.onMeteringError }),
        }),
    policy: {
      tier: options.securityTier,
      localAiOnly: tierDefaults[options.securityTier].localAiOnly,
      ...(options.aiConfig?.privacy?.classificationGating === undefined
        ? {}
        : { classificationEnabled: options.aiConfig.privacy.classificationGating }),
      ...(defaultProviderId === undefined && configuredRouting.defaultProviderId === undefined
        ? {}
        : { defaultProviderId: defaultProviderId ?? configuredRouting.defaultProviderId }),
      featureProviders: {
        "assistant.chat": "assistant.local",
        ...(configuredRouting.featureProviders ?? {}),
        ...(defaultProviderId === undefined ? {} : { "assistant.chat": defaultProviderId }),
      },
      ...(featureRoutes === undefined ? {} : { featureRoutes }),
    },
  });
}
async function createSearchEngine(region: string): Promise<MeilisearchSearchEngine | undefined> {
  const searchEnv = env();
  const baseUrl = searchEnv.MEILI_URL ?? searchEnv.MEILISEARCH_URL ?? searchEnv.MEILI_HOST;
  if (baseUrl === undefined) {
    return undefined;
  }
  const apiKey =
    searchEnv.MEILI_MASTER_KEY ?? searchEnv.MEILI_API_KEY ?? searchEnv.MEILISEARCH_API_KEY;
  const engine = new MeilisearchSearchEngine(
    createMeilisearchHttpClient({
      baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
    }),
    {
      indexUid:
        searchEnv.MEILI_INDEX_UID ??
        searchEnv.MEILISEARCH_INDEX_UID ??
        regionalResourceName(region, "helix_search"),
    },
  );
  await engine.ensureIndex();
  return engine;
}
function parseS3ServerSideEncryption(value: string): "AES256" | "aws:kms" {
  if (value !== "AES256" && value !== "aws:kms") {
    throw new TypeError("RUSTFS_SERVER_SIDE_ENCRYPTION must be AES256 or aws:kms");
  }
  return value;
}
interface ImmutableAuditShippingConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  readonly prefix: string;
  readonly batchSize: number;
  readonly intervalMs: number;
  readonly retentionDays: number;
  readonly objectLockMode: ImmutableAuditObjectLockMode;
  readonly anchorKeyId: string;
  readonly anchorSecret: string;
}
interface BetterAuthServerConfig {
  readonly databaseUrl: string;
  readonly secret: string;
  readonly baseUrl: string;
  readonly secureCookies: boolean;
  readonly trustedOrigins?: readonly string[];
}
export function getBetterAuthRuntimeConfig(
  env: NodeJS.ProcessEnv,
): BetterAuthServerConfig | undefined {
  if (!envValueFlag(env.BETTER_AUTH_ENABLED ?? "true", true)) {
    if (env.NODE_ENV === "production") {
      throw new TypeError("Better Auth cannot be disabled in production");
    }
    return undefined;
  }
  const databaseUrl = env.BETTER_AUTH_DATABASE_URL ?? env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new TypeError("BETTER_AUTH_DATABASE_URL or DATABASE_URL is required");
  }
  const secret =
    env.BETTER_AUTH_SECRET ??
    (env.NODE_ENV === "production"
      ? undefined
      : "helix_local_better_auth_secret_change_me_32_chars");
  if (secret === undefined || secret.length < 32) {
    throw new TypeError("BETTER_AUTH_SECRET must be at least 32 characters");
  }
  const production = env.NODE_ENV === "production";
  const configuredBaseUrl = env.BETTER_AUTH_URL ?? env.HELIX_PUBLIC_URL ?? env.PUBLIC_BASE_URL;
  if (production && configuredBaseUrl === undefined) {
    throw new TypeError("A canonical HTTPS Better Auth origin is required in production");
  }
  const baseUrl = canonicalHttpOrigin(configuredBaseUrl ?? "http://localhost:3000");
  if (production && !baseUrl.startsWith("https://")) {
    throw new TypeError("Better Auth's production origin must use HTTPS");
  }
  const trustedOrigins = (env.BETTER_AUTH_TRUSTED_ORIGINS ?? env.CLIENT_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return {
    databaseUrl,
    secret,
    baseUrl,
    secureCookies: production,
    ...(trustedOrigins.length === 0 ? {} : { trustedOrigins }),
  };
}
function canonicalHttpOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Better Auth origin must be a valid HTTP(S) origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Better Auth origin must contain only an HTTP(S) scheme and authority");
  }
  return url.origin;
}
export function getImmutableAuditShippingConfig(
  env: NodeJS.ProcessEnv,
): ImmutableAuditShippingConfig | undefined {
  if (!envValueFlag(env.AUDIT_IMMUTABLE_S3_ENABLED ?? "", false)) {
    return undefined;
  }
  const endpoint = env.AUDIT_IMMUTABLE_S3_ENDPOINT ?? env.AUDIT_S3_ENDPOINT;
  const bucket = env.AUDIT_IMMUTABLE_S3_BUCKET ?? env.AUDIT_S3_BUCKET;
  const accessKeyId =
    env.AUDIT_IMMUTABLE_S3_ACCESS_KEY ?? env.AUDIT_S3_ACCESS_KEY ?? env.RUSTFS_ACCESS_KEY;
  const secretAccessKey =
    env.AUDIT_IMMUTABLE_S3_SECRET_KEY ?? env.AUDIT_S3_SECRET_KEY ?? env.RUSTFS_SECRET_KEY;
  const anchorKeyId = env.AUDIT_IMMUTABLE_S3_ANCHOR_KEY_ID;
  const anchorSecret = env.AUDIT_IMMUTABLE_S3_ANCHOR_SECRET;
  if (endpoint === undefined || endpoint.length === 0) {
    throw new TypeError("AUDIT_IMMUTABLE_S3_ENDPOINT or AUDIT_S3_ENDPOINT is required");
  }
  if (bucket === undefined || bucket.length === 0) {
    throw new TypeError("AUDIT_IMMUTABLE_S3_BUCKET or AUDIT_S3_BUCKET is required");
  }
  if (accessKeyId === undefined || accessKeyId.length === 0) {
    throw new TypeError("AUDIT_IMMUTABLE_S3_ACCESS_KEY or AUDIT_S3_ACCESS_KEY is required");
  }
  if (secretAccessKey === undefined || secretAccessKey.length === 0) {
    throw new TypeError("AUDIT_IMMUTABLE_S3_SECRET_KEY or AUDIT_S3_SECRET_KEY is required");
  }
  if (anchorKeyId === undefined || anchorKeyId.length === 0) {
    throw new TypeError("AUDIT_IMMUTABLE_S3_ANCHOR_KEY_ID is required");
  }
  if (anchorSecret === undefined || anchorSecret.length < 32) {
    throw new TypeError("AUDIT_IMMUTABLE_S3_ANCHOR_SECRET must be at least 32 characters");
  }
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env.AUDIT_IMMUTABLE_S3_REGION ?? env.AUDIT_S3_REGION ?? "us-east-1",
    forcePathStyle: envValueFlag(
      env.AUDIT_IMMUTABLE_S3_FORCE_PATH_STYLE ?? env.AUDIT_S3_FORCE_PATH_STYLE ?? "true",
      true,
    ),
    prefix: env.AUDIT_IMMUTABLE_S3_PREFIX ?? env.AUDIT_S3_PREFIX ?? "audit/activity",
    batchSize: Number.parseInt(env.AUDIT_IMMUTABLE_S3_BATCH_SIZE ?? "500", 10),
    intervalMs: Number.parseInt(env.AUDIT_IMMUTABLE_S3_INTERVAL_MS ?? "60000", 10),
    retentionDays: Number.parseInt(env.AUDIT_IMMUTABLE_S3_RETENTION_DAYS ?? "365", 10),
    objectLockMode: parseImmutableAuditObjectLockMode(
      env.AUDIT_IMMUTABLE_S3_OBJECT_LOCK_MODE ?? "COMPLIANCE",
    ),
    anchorKeyId,
    anchorSecret,
  };
}
function parseImmutableAuditObjectLockMode(value: string): ImmutableAuditObjectLockMode {
  if (value !== "COMPLIANCE" && value !== "GOVERNANCE") {
    throw new TypeError("AUDIT_IMMUTABLE_S3_OBJECT_LOCK_MODE must be COMPLIANCE or GOVERNANCE");
  }
  return value;
}
/**
 * Resolve every configured audit-shipping destination (Follow-up A).
 *
 * Destinations are selected by their per-destination enable flag and are
 * additive — Tier 3 ("immutable S3 + SIEM") simply enables both. The returned
 * configs are consumed by {@link createAuditDestinationShipper}:
 *
 *  - `immutable-s3`             — `AUDIT_IMMUTABLE_S3_ENABLED`
 *  - `siem-syslog`              — `AUDIT_SIEM_SYSLOG_ENABLED`
 *  - `audit-immutable-postgres` — `AUDIT_WORM_POSTGRES_ENABLED`
 */
export function getAuditDestinationConfigs(
  env: NodeJS.ProcessEnv,
): readonly AuditDestinationConfig[] {
  const configs: AuditDestinationConfig[] = [];
  const s3Config = getImmutableAuditShippingConfig(env);
  if (s3Config !== undefined) {
    const anchorAuthenticator = createHmacAuditAnchorAuthenticator(
      s3Config.anchorKeyId,
      s3Config.anchorSecret,
    );
    configs.push({
      destination: "immutable-s3",
      batchSize: s3Config.batchSize,
      intervalMs: s3Config.intervalMs,
      storage: createS3CompatibleStorage({
        endpoint: s3Config.endpoint,
        region: s3Config.region,
        bucket: s3Config.bucket,
        credentials: {
          accessKeyId: s3Config.accessKeyId,
          secretAccessKey: s3Config.secretAccessKey,
        },
        forcePathStyle: s3Config.forcePathStyle,
      }),
      prefix: s3Config.prefix,
      objectLockMode: s3Config.objectLockMode,
      retentionDays: s3Config.retentionDays,
      signer: anchorAuthenticator,
      verifier: anchorAuthenticator,
    });
  }
  if (envValueFlag(env.AUDIT_SIEM_SYSLOG_ENABLED ?? "", false)) {
    const host = env.AUDIT_SIEM_SYSLOG_HOST;
    if (host === undefined || host.length === 0) {
      throw new TypeError("AUDIT_SIEM_SYSLOG_HOST is required when AUDIT_SIEM_SYSLOG_ENABLED");
    }
    configs.push({
      destination: "siem-syslog",
      host,
      port: Number.parseInt(env.AUDIT_SIEM_SYSLOG_PORT ?? "514", 10),
      transport: parseSiemSyslogTransport(env.AUDIT_SIEM_SYSLOG_TRANSPORT ?? "tcp"),
      format: parseSiemAuditFormat(env.AUDIT_SIEM_SYSLOG_FORMAT ?? "cef"),
      ...(env.AUDIT_SIEM_SYSLOG_BATCH_SIZE === undefined
        ? {}
        : { batchSize: Number.parseInt(env.AUDIT_SIEM_SYSLOG_BATCH_SIZE, 10) }),
      ...(env.AUDIT_SIEM_SYSLOG_INTERVAL_MS === undefined
        ? {}
        : { intervalMs: Number.parseInt(env.AUDIT_SIEM_SYSLOG_INTERVAL_MS, 10) }),
      ...(env.AUDIT_SIEM_SYSLOG_FACILITY === undefined
        ? {}
        : { facility: Number.parseInt(env.AUDIT_SIEM_SYSLOG_FACILITY, 10) }),
      ...(env.AUDIT_SIEM_SYSLOG_SEVERITY === undefined
        ? {}
        : { severity: Number.parseInt(env.AUDIT_SIEM_SYSLOG_SEVERITY, 10) }),
      ...(env.AUDIT_SIEM_SYSLOG_APP_NAME === undefined
        ? {}
        : { appName: env.AUDIT_SIEM_SYSLOG_APP_NAME }),
      ...(env.AUDIT_SIEM_SYSLOG_TRANSPORT === "tls"
        ? {
            tls: {
              ...(env.AUDIT_SIEM_SYSLOG_TLS_REJECT_UNAUTHORIZED === undefined
                ? {}
                : {
                    rejectUnauthorized: envValueFlag(
                      env.AUDIT_SIEM_SYSLOG_TLS_REJECT_UNAUTHORIZED,
                      true,
                    ),
                  }),
              ...(env.AUDIT_SIEM_SYSLOG_TLS_CA === undefined
                ? {}
                : { ca: env.AUDIT_SIEM_SYSLOG_TLS_CA }),
            },
          }
        : {}),
    });
  }
  if (envValueFlag(env.AUDIT_WORM_POSTGRES_ENABLED ?? "", false)) {
    configs.push({
      destination: "audit-immutable-postgres",
      ...(env.AUDIT_WORM_POSTGRES_BATCH_SIZE === undefined
        ? {}
        : { batchSize: Number.parseInt(env.AUDIT_WORM_POSTGRES_BATCH_SIZE, 10) }),
      ...(env.AUDIT_WORM_POSTGRES_INTERVAL_MS === undefined
        ? {}
        : { intervalMs: Number.parseInt(env.AUDIT_WORM_POSTGRES_INTERVAL_MS, 10) }),
    });
  }
  return configs;
}
function parseSiemSyslogTransport(value: string): SiemSyslogTransport {
  if (value !== "tcp" && value !== "tls" && value !== "udp") {
    throw new TypeError("AUDIT_SIEM_SYSLOG_TRANSPORT must be tcp, tls, or udp");
  }
  return value;
}
function parseSiemAuditFormat(value: string): SiemAuditFormat {
  if (value !== "cef" && value !== "leef") {
    throw new TypeError("AUDIT_SIEM_SYSLOG_FORMAT must be cef or leef");
  }
  return value;
}
function tenantRootHostFromPublicUrl(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  try {
    return [new URL(value).hostname];
  } catch {
    return [];
  }
}
/** @deprecated Prefer mailConfig(loadEnv(...)).receiver — kept for server.test.ts. */
export function getSmtpMailReceiverConfig(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
):
  | {
      readonly port: number;
      readonly host?: string;
    }
  | undefined {
  if (!envValueFlag(source.MAIL_SMTP_RECEIVER_ENABLED ?? "", false)) {
    return undefined;
  }
  const host = source.MAIL_SMTP_RECEIVER_HOST;
  return {
    port: Number.parseInt(source.MAIL_SMTP_RECEIVER_PORT ?? "2525", 10),
    ...(host === undefined || host.length === 0 ? {} : { host }),
  };
}
function envFlag(name: string, defaultValue: boolean): boolean {
  // Dynamic flag lookup for keys not all present on Env (e.g. worker toggles).
  // Prefer env() field access for known operational keys; keep process.env only
  // for open-ended HELIX_* feature switches until they are added to the schema.
  // eslint-disable-next-line helix/no-raw-process-env -- dynamic feature-flag names
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }
  return envValueFlag(value, defaultValue);
}
function envValueFlag(value: string, defaultValue: boolean): boolean {
  if (value.length === 0) {
    return defaultValue;
  }
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}
/**
 * Resolves the per-tier confirmation timeout (PRD §9.9). The default window is
 * 10 minutes; higher-assurance tiers expire stale approvals faster so they do
 * not linger. `CONFIRMATION_TIMEOUT_MS` overrides the resolved value.
 */
function resolveConfirmationTimeoutMs(tier: SecurityTier, env: NodeJS.ProcessEnv): number {
  const override = env.CONFIRMATION_TIMEOUT_MS;
  if (override !== undefined && override.trim().length > 0) {
    const parsed = Number.parseInt(override, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const minute = 60000;
  switch (tier) {
    case "personal":
      return 10 * minute;
    case "business":
      return 10 * minute;
    case "enterprise":
      return 5 * minute;
    case "sovereign":
      return 3 * minute;
  }
}
export function createAssistantProviders(
  aiConfig: AiConfig | undefined,
): readonly LLMProviderCapability[] {
  if (aiConfig?.enabled === false) return [];
  const providers: LLMProviderCapability[] = [];
  // Admin platform-config overlay (operator LLM) wins over process env bootstrap.
  const aiEnv = resolveAiEnv(process.env);
  for (const provider of aiConfig?.providers ?? []) {
    if (provider.enabled === false) {
      continue;
    }
    const configured = createConfiguredAssistantProvider(provider, process.env);
    if (configured !== undefined) {
      providers.push(configured);
    }
  }
  if (aiEnv.OLLAMA_BASE_URL !== undefined) {
    pushProvider(
      providers,
      createOpenAICompatibleProvider({
        id: "ollama.local",
        baseUrl: aiEnv.OLLAMA_BASE_URL,
        fetch: configuredProviderFetch(aiEnv.OLLAMA_BASE_URL),
        models: [
          {
            id: aiEnv.OLLAMA_MODEL ?? "llama3.1",
            displayName: aiEnv.OLLAMA_MODEL ?? "Local Ollama",
            supportsTools: true,
          },
        ],
        defaultModel: aiEnv.OLLAMA_MODEL ?? "llama3.1",
      }),
    );
  }
  if (aiEnv.OPENAI_API_KEY !== undefined) {
    pushProvider(
      providers,
      createOpenAICompatibleProvider({
        id: "openai-compatible.default",
        apiKey: aiEnv.OPENAI_API_KEY,
        ...(aiEnv.OPENAI_BASE_URL === undefined ? {} : { baseUrl: aiEnv.OPENAI_BASE_URL }),
        ...(aiEnv.OPENAI_BASE_URL === undefined
          ? {}
          : { fetch: configuredProviderFetch(aiEnv.OPENAI_BASE_URL) }),
        models: [
          {
            id: aiEnv.OPENAI_MODEL ?? "gpt-4.1-mini",
            displayName: aiEnv.OPENAI_MODEL ?? "OpenAI compatible",
            supportsTools: true,
          },
        ],
        defaultModel: aiEnv.OPENAI_MODEL ?? "gpt-4.1-mini",
      }),
    );
  }
  pushProvider(providers, createLocalAssistantProvider());
  return providers;
}
export function createAssistantEmbeddingProvider(
  aiConfig: AiConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fetch?: typeof globalThis.fetch,
): MemoryEmbeddingProvider {
  if (aiConfig?.enabled === false) {
    return createDeterministicEmbeddingProvider();
  }
  const configured = createConfiguredAssistantEmbeddingProvider(aiConfig, env, fetch);
  return configured ?? createDeterministicEmbeddingProvider();
}
export function createSemanticSearchEmbeddingProvider(
  aiConfig: AiConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fetch?: typeof globalThis.fetch,
): MemoryEmbeddingProvider | undefined {
  if (aiConfig?.enabled === false || aiConfig?.embeddingProvider === undefined) {
    return undefined;
  }
  return createConfiguredAssistantEmbeddingProvider(aiConfig, env, fetch);
}
function createConfiguredAssistantEmbeddingProvider(
  aiConfig: AiConfig | undefined,
  env: NodeJS.ProcessEnv,
  fetch?: typeof globalThis.fetch,
): MemoryEmbeddingProvider | undefined {
  const embeddingProvider = aiConfig?.embeddingProvider;
  if (embeddingProvider === undefined) {
    return undefined;
  }
  const plugin = embeddingProvider.plugin.toLowerCase();
  if (!plugin.includes("openai-compat") && !plugin.includes("openai-compatible")) {
    return undefined;
  }
  const config = embeddingProvider.config ?? {};
  const defaultDimensions =
    positiveIntegerConfig(config, "defaultDimensions") ??
    positiveIntegerConfig(config, "dimensions");
  if (defaultDimensions === undefined) {
    return undefined;
  }
  if (defaultDimensions !== 768) {
    throw new TypeError("Assistant memory embedding provider must use 768 dimensions");
  }
  const defaultModel = stringConfig(config, "defaultModel") ?? stringConfig(config, "model");
  const models = modelListFromConfig(config);
  if (defaultModel === undefined && models.length === 0) {
    return undefined;
  }
  const providerId = stringConfig(config, "id") ?? embeddingProvider.plugin;
  const baseUrl = stringConfig(config, "baseUrl");
  const apiKey = secretConfig(config, env);
  const headers = headersConfig(config);
  const maxBatchSize = positiveIntegerConfig(config, "maxBatchSize");
  const modelDimensions = modelDimensionsConfig(config);
  return createOpenAICompatibleEmbeddingProvider({
    id: providerId,
    models,
    defaultDimensions,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    ...(baseUrl === undefined ? {} : { fetch: fetch ?? configuredProviderFetch(baseUrl) }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(headers === undefined ? {} : { headers }),
    ...(maxBatchSize === undefined ? {} : { maxBatchSize }),
    ...(modelDimensions === undefined ? {} : { modelDimensions }),
  });
}
function createConfiguredAssistantProvider(
  provider: AiProviderConfig,
  env: NodeJS.ProcessEnv,
): LLMProviderCapability | undefined {
  const plugin = provider.plugin.toLowerCase();
  const config = provider.config ?? {};
  const defaultModel = stringConfig(config, "defaultModel") ?? stringConfig(config, "model");
  const common = {
    id: provider.id,
    models: modelListFromConfig(config),
    ...(defaultModel === undefined ? {} : { defaultModel }),
  };
  const tags = provider.tags ?? tagsFromConfig(config);
  const withTags = (created: LLMProviderCapability): LLMProviderCapability =>
    tags.length === 0 ? created : Object.assign(created, { tags });
  if (plugin.includes("openai-compat") || plugin.includes("openai-compatible")) {
    const baseUrl = stringConfig(config, "baseUrl");
    const apiKey = secretConfig(config, env);
    const headers = headersConfig(config);
    return withTags(
      createOpenAICompatibleProvider({
        ...common,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(baseUrl === undefined ? {} : { fetch: configuredProviderFetch(baseUrl) }),
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(headers === undefined ? {} : { headers }),
      }),
    );
  }
  if (plugin.includes("anthropic-compat") || plugin.includes("anthropic-compatible")) {
    const baseUrl = stringConfig(config, "baseUrl");
    const apiKey = secretConfig(config, env);
    const anthropicVersion = stringConfig(config, "anthropicVersion");
    const maxTokens = numberConfig(config, "maxTokens");
    const headers = headersConfig(config);
    return withTags(
      createAnthropicCompatibleProvider({
        ...common,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(baseUrl === undefined ? {} : { fetch: configuredProviderFetch(baseUrl) }),
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(anthropicVersion === undefined ? {} : { anthropicVersion }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(headers === undefined ? {} : { headers }),
      }),
    );
  }
  if (plugin.includes("bedrock")) {
    const region = stringConfig(config, "region");
    if (region === undefined) {
      throw new TypeError(`AI provider ${provider.id} requires a Bedrock region`);
    }
    const endpoint = stringConfig(config, "endpoint");
    const maxTokens = numberConfig(config, "maxTokens");
    return withTags(
      createBedrockProvider({
        ...common,
        region,
        credentials: resolveBedrockCredentialSource(config, env),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      }),
    );
  }
  if (plugin.includes("vertex")) {
    const project = stringConfig(config, "project");
    const location = stringConfig(config, "location");
    if (project === undefined || location === undefined) {
      throw new TypeError(`AI provider ${provider.id} requires a Vertex project and location`);
    }
    const endpoint = stringConfig(config, "endpoint");
    const maxTokens = numberConfig(config, "maxTokens");
    return withTags(
      createVertexProvider({
        ...common,
        project,
        location,
        credentials: resolveVertexCredentials(provider.id, config, env),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      }),
    );
  }
  return undefined;
}
function configuredProviderFetch(baseUrl: string): typeof globalThis.fetch {
  const url = new URL(baseUrl);
  return createOutboundHttpClient({
    allowedHosts: [url.hostname],
    allowHttp: url.protocol === "http:",
    allowPrivateNetwork: true,
  });
}
/**
 * Resolves the Bedrock credential source from provider config.
 *
 * When explicit static keys are configured they are used directly; otherwise
 * a credential provider is returned that resolves IAM role / instance profile
 * (IMDSv2) / `AWS_PROFILE` / environment-variable credentials in standard
 * precedence order. Workload identity (instance profile) therefore requires
 * no configuration at all.
 */
function resolveBedrockCredentialSource(
  config: JsonObject,
  env: NodeJS.ProcessEnv,
): BedrockCredentialSource {
  const accessKeyId =
    stringConfig(config, "accessKeyId") ?? env[stringConfig(config, "accessKeyIdEnv") ?? ""];
  const secretAccessKey =
    stringConfig(config, "secretAccessKey") ??
    env[stringConfig(config, "secretAccessKeyEnv") ?? ""];
  const sessionToken =
    stringConfig(config, "sessionToken") ?? env[stringConfig(config, "sessionTokenEnv") ?? ""];
  const staticCredentials =
    accessKeyId !== undefined && secretAccessKey !== undefined
      ? {
          accessKeyId,
          secretAccessKey,
          ...(sessionToken === undefined ? {} : { sessionToken }),
        }
      : undefined;
  const profile = stringConfig(config, "profile");
  return createBedrockCredentialProvider({
    env: profile === undefined ? env : { ...env, AWS_PROFILE: profile },
    ...(staticCredentials === undefined ? {} : { static: staticCredentials }),
  });
}
/**
 * Resolves Vertex credentials from provider config.
 *
 * Supports both a pre-minted `accessToken` and the service-account
 * (`clientEmail` + `privateKey`) / workload-identity path. With a service
 * account, the provider signs a JWT and exchanges it at the GCP token
 * endpoint for an access token.
 */
function resolveVertexCredentials(
  providerId: string,
  config: JsonObject,
  env: NodeJS.ProcessEnv,
): VertexCredentials {
  const clientEmail =
    stringConfig(config, "clientEmail") ?? env[stringConfig(config, "clientEmailEnv") ?? ""];
  const privateKey = normalizePrivateKey(
    stringConfig(config, "privateKey") ?? env[stringConfig(config, "privateKeyEnv") ?? ""],
  );
  if (clientEmail !== undefined && privateKey !== undefined) {
    const tokenUri = stringConfig(config, "tokenUri");
    const scope = stringConfig(config, "scope");
    return {
      clientEmail,
      privateKey,
      ...(tokenUri === undefined ? {} : { tokenUri }),
      ...(scope === undefined ? {} : { scope }),
    };
  }
  const accessToken =
    stringConfig(config, "accessToken") ?? env[stringConfig(config, "accessTokenEnv") ?? ""];
  if (accessToken !== undefined) {
    return { accessToken };
  }
  throw new TypeError(
    `AI provider ${providerId} requires Vertex credentials: either a service account (clientEmail + privateKey) or an accessToken`,
  );
}
/**
 * Normalizes a PEM private key supplied via config or env. Environment
 * variables commonly encode newlines as the literal escape sequence `\n`.
 */
function normalizePrivateKey(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return value.includes("\\n") ? value.replace(/\\n/gu, "\n") : value;
}
export function aiRoutingPolicyFromConfig(
  aiConfig: AiConfig | undefined,
): Pick<
  NonNullable<ConstructorParameters<typeof AIRouter>[0]["policy"]>,
  "defaultProviderId" | "featureProviders" | "featureRoutes"
> {
  const featureProviders: Record<string, string> = {};
  const featureRoutes: Record<
    string,
    {
      primary: {
        providerId: string;
        model?: string;
      };
      fallback?: {
        providerId: string;
        model?: string;
      };
    }
  > = {};
  for (const rule of aiConfig?.routing?.rules ?? []) {
    featureProviders[rule.feature] = rule.primary.providerId;
    featureRoutes[rule.feature] = {
      primary: {
        providerId: rule.primary.providerId,
        ...(rule.primary.model === undefined ? {} : { model: rule.primary.model }),
      },
      ...(rule.fallback === undefined
        ? {}
        : {
            fallback: {
              providerId: rule.fallback.providerId,
              ...(rule.fallback.model === undefined ? {} : { model: rule.fallback.model }),
            },
          }),
    };
  }
  const defaultProviderId = Object.values(featureProviders)[0];
  return {
    ...(defaultProviderId === undefined ? {} : { defaultProviderId }),
    ...(Object.keys(featureProviders).length === 0 ? {} : { featureProviders }),
    ...(Object.keys(featureRoutes).length === 0 ? {} : { featureRoutes }),
  };
}
function pushProvider(providers: LLMProviderCapability[], provider: LLMProviderCapability): void {
  if (!providers.some((candidate) => candidate.id === provider.id)) {
    providers.push(provider);
  }
}
function modelListFromConfig(config: JsonObject): readonly ModelInfo[] {
  const models = config.models;
  if (Array.isArray(models) && models.length > 0) {
    return (models as readonly unknown[]).flatMap((model): ModelInfo[] => {
      if (typeof model === "string" && model.length > 0) {
        return [{ id: model }];
      }
      if (isJsonObjectValue(model) && typeof model.id === "string" && model.id.length > 0) {
        return [
          {
            id: model.id,
            ...(typeof model.displayName === "string" ? { displayName: model.displayName } : {}),
            ...(typeof model.contextWindow === "number"
              ? { contextWindow: model.contextWindow }
              : {}),
            ...(typeof model.inputCostPer1kTokensCents === "number"
              ? { inputCostPer1kTokensCents: model.inputCostPer1kTokensCents }
              : {}),
            ...(typeof model.outputCostPer1kTokensCents === "number"
              ? { outputCostPer1kTokensCents: model.outputCostPer1kTokensCents }
              : {}),
            ...(typeof model.supportsTools === "boolean"
              ? { supportsTools: model.supportsTools }
              : {}),
            ...(typeof model.supportsVision === "boolean"
              ? { supportsVision: model.supportsVision }
              : {}),
          },
        ];
      }
      return [];
    });
  }
  const model = stringConfig(config, "model") ?? stringConfig(config, "defaultModel");
  return model === undefined ? [] : [{ id: model, supportsTools: true }];
}
function secretConfig(config: JsonObject, env: NodeJS.ProcessEnv): string | undefined {
  const apiKey = stringConfig(config, "apiKey");
  if (apiKey !== undefined) {
    return apiKey;
  }
  const apiKeyEnv = stringConfig(config, "apiKeyEnv");
  return apiKeyEnv === undefined ? undefined : env[apiKeyEnv];
}
function headersConfig(config: JsonObject): Record<string, string> | undefined {
  const headers = config.headers;
  if (!isJsonObjectValue(headers)) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
function tagsFromConfig(config: JsonObject): readonly string[] {
  const tags = config.tags;
  return Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === "string") : [];
}
function stringConfig(config: JsonObject, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function numberConfig(config: JsonObject, key: string): number | undefined {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function positiveIntegerConfig(config: JsonObject, key: string): number | undefined {
  const value = numberConfig(config, key);
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}
function modelDimensionsConfig(config: JsonObject): Record<string, number> | undefined {
  const value = config.modelDimensions;
  if (!isJsonObjectValue(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isInteger(entry[1]) && entry[1] > 0,
  );
  return entries.length === 0 ? undefined : Object.fromEntries(entries);
}
function isJsonObjectValue(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function createLocalAssistantProvider(): LLMProviderCapability {
  return {
    id: "assistant.local",
    protocol: "openai-compatible",
    tags: ["local-only"],
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const latestUser =
        [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
      return {
        providerId: "assistant.local",
        model: "deterministic-assistant",
        message: localAssistantReply(latestUser),
        usage: {
          inputTokens: countApproximateTokens(
            request.messages.map((message) => message.content).join("\n"),
          ),
          outputTokens: countApproximateTokens(latestUser),
        },
        metadata: {
          mode: "deterministic-fallback",
          note: "Configure OLLAMA_BASE_URL or OPENAI_API_KEY for model-backed assistant replies.",
        },
      };
    },
    async models() {
      return [
        {
          id: "deterministic-assistant",
          displayName: "Deterministic Assistant Fallback",
          supportsTools: false,
        },
      ];
    },
    async countTokens(text: string) {
      return countApproximateTokens(text);
    },
  };
}
function localAssistantReply(message: string): string {
  const trimmed = message.trim();
  if (trimmed.startsWith("/draft")) {
    return "Draft ready. I used the current conversation and available workspace context to shape the response.";
  }
  if (trimmed.startsWith("/summarize")) {
    return "Summary ready. I checked the visible context supplied to this assistant turn.";
  }
  if (trimmed.startsWith("/find")) {
    return "I found the most relevant visible workspace context and included it in this reply.";
  }
  if (trimmed.startsWith("/schedule")) {
    return "I can help schedule this by using Calendar tools when a model-backed provider requests them.";
  }
  return trimmed.length === 0
    ? "How can I help with this workspace?"
    : `I captured your request and prepared an assistant response using the visible tools, search context, and opt-in memory available to your actor.`;
}
function createDeterministicEmbeddingProvider() {
  return {
    async embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
      return texts.map((text) => deterministicEmbedding(text));
    },
  };
}
function deterministicEmbedding(text: string): readonly number[] {
  const vector = Array.from({ length: 768 }, () => 0);
  for (let index = 0; index < text.length; index += 1) {
    const bucket = index % vector.length;
    vector[bucket] = (vector[bucket] ?? 0) + text.charCodeAt(index) / 255;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}
function countApproximateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
async function collectBoundedBytes(
  body: Uint8Array | AsyncIterable<Uint8Array>,
  limit: number,
): Promise<Buffer> {
  if (body instanceof Uint8Array) {
    if (body.byteLength > limit)
      throw new MailDeliveryError("Drive attachment exceeds the outbound mail limit.", false);
    return Buffer.from(body);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > limit) {
      throw new MailDeliveryError("Drive attachment exceeds the outbound mail limit.", false);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}
