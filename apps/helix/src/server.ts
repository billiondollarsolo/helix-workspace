import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { convertToHtml as mammothConvertToHtml } from "mammoth";
import type { Browser } from "playwright";
import { Redis } from "ioredis";
import { fromNodeHeaders } from "better-auth/node";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { ZodError, z } from "zod3";
import { ContractValidationError } from "@helix/contracts";
import { createMeteringClient } from "@helix/sdk";
import {
  systemActor,
  toolInvocationPrincipalFromRequest,
  type SessionActorResolver,
} from "./api/actor.js";
import { ApiError, NotFoundError } from "./api/api-error.js";
import { requireActorScope } from "./api/scopes.js";
import { buildAsyncApiDocument } from "./api/asyncapi.js";
import { formatSseEvent, handleMcpJsonRpcRequest, handleMcpStreamingRequest } from "./api/mcp.js";
import { createStoreBackedMcpResourceProvider } from "./api/mcp-resources.js";
import { createPlatformMetrics, installHttpMetrics } from "./api/metrics.js";
import { buildOpenApiDocument, openApiDocumentToYaml } from "./api/openapi.js";
import { createRequestContext } from "./api/trace.js";
import {
  HELIX_API_VERSION_HEADER_VALUE,
  HELIX_API_VERSION_PREFIX,
  HELIX_SERVER_VERSION,
} from "./api/version.js";
import { buildErrorEnvelope, toolErrorEnvelope } from "./api/error-envelope.js";
import {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
  fingerprintRequestPayload,
  idempotencyStorageKey,
  resolveIdempotency,
  type IdempotencyStore,
} from "./api/idempotency.js";
import { projectToolListItem } from "./api/tool-projection.js";
import { createResourceClassifier } from "./api/classify-resource.js";
import { createHelixTRPCRouter } from "./api/trpc.js";
import { createSqlClient } from "./db/client.js";
import { env } from "./config/env.js";
import { resolveRedisConnection } from "./config/redis-connection.js";
import { helixLoggerOptions } from "./platform/security/logger-redaction.js";
import {
  installTrustedOriginPolicy,
  parseTrustedOrigins,
} from "./platform/security/origin-policy.js";
import { OAuthClientManager, OAuthTokenService } from "./platform/auth/oauth.js";
import { PostgresAdminServiceStatusStore } from "./platform/admin/service-status.js";
import { AdminServicesCatalog, registerAdminServicesRoutes } from "./platform/admin/services.js";
import { registerAdminIdentityRoutes } from "./platform/admin/identity.js";
import {
  PostgresAgentCredentialStore,
  PostgresAuthorizationCodeStore,
  PostgresOAuthStore,
} from "./platform/auth/postgres-store.js";
import { AuthorizationCodeService } from "./platform/auth/authorization-code.js";
import { registerOAuthRoutes } from "./platform/auth/routes.js";
import { registerTenantSamlRoutes } from "./platform/auth/saml-routes.js";
import { registerTenantScimRoutes } from "./platform/auth/scim-routes.js";
import { PostgresTenantScimCredentialStore } from "./platform/auth/scim-credentials.js";
import { PostgresTenantIdpConfigStore } from "./platform/auth/tenant-idp-configs.js";
import {
  appPasswordScopeCatalog,
  PostgresAppPasswordStore,
  registerAppPasswordTools,
} from "./platform/auth/app-passwords.js";
import {
  agentCredentialScopeCatalog,
  registerAgentCredentialTools,
} from "./platform/auth/tools.js";
import {
  toolInvocationOptions,
  type ToolInvocationPrincipal,
} from "./platform/auth/tool-invocation-principal.js";
import {
  PostgresAdminUsersStore,
  registerAdminUsersRoutes,
  registerPeopleDirectoryRoutes,
} from "./platform/auth/admin-users.js";
import {
  createBetterAuthPlatformModule,
  createBetterAuthRuntime,
  createBetterAuthSessionActorResolver,
  PostgresBetterAuthActorStore,
  PostgresBetterAuthSessionIssuer,
  PostgresBetterAuthUserLinkStore,
  type BetterAuthInstance,
} from "./platform/auth/better-auth.js";
import {
  AssistantOrchestrator,
  AssistantSlashCommandHooks,
  PostgresAssistantStore,
  registerAssistantTools,
  type AssistantSendMessageInput,
  type AssistantStreamEvent,
} from "./platform/assistant/index.js";
import {
  registerBackupAdminRoutes,
  ScriptedBackupAdminService,
} from "./platform/backup/admin-routes.js";
import {
  AIRouter,
  EnrichmentWorker,
  InMemoryAICostLimiter,
  createAICostGuard,
  createAnthropicCompatibleProvider,
  createBedrockCredentialProvider,
  createBedrockProvider,
  createConfiguredVectorStore,
  createOpenAICompatibleEmbeddingProvider,
  createOpenAICompatibleProvider,
  createVertexProvider,
  deriveClassification,
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
  createMailCalendarInvitationSender,
  PostgresCalendarStore,
  registerCalendarIndexer,
  registerCalendarRoutes,
  registerCalendarTools,
} from "./platform/calendar/index.js";
import { PostgresCardDavContactStore, registerCardDavRoutes } from "./platform/carddav/index.js";
import {
  EventBusChatRoomBus,
  ChatRetentionWorker,
  PostgresChatStore,
  PostgresChatRetentionOrganizationSource,
  RedisChatPresenceStore,
  createChatNatsSecurityPolicy,
  registerChatEnrichments,
  registerChatIndexer,
  registerChatRoutes,
  registerChatTools,
} from "./platform/chat/index.js";
import {
  createHeadlessChromiumPdfRenderer,
  PostgresDocsStore,
  registerDocsEnrichments,
  registerDocsIndexer,
  registerDocsRoutes,
  registerDocsTools,
} from "./platform/docs/index.js";
import {
  assertDriveMalwareScannerReady,
  createClamAvVirusScanner,
  createDriveUploadScanWorker,
  DriveLifecycleGcWorker,
  driveStorageEncryptionPolicyForTenant,
  createLocalOfficePreviewConverter,
  createLibreOfficePreviewClient,
  type DrivePreview,
  PostgresDriveStore,
  readInlineBodyFallback,
  registerDriveEnrichments,
  registerDriveIndexer,
  registerDriveRoutes,
  registerDriveShareLinkRoute,
  registerDriveTools,
  sendBytesWithRangeSupport,
} from "./platform/drive/index.js";
import { loadDriveConfig } from "./platform/drive/config.js";
import { InMemoryEventBus } from "./platform/events/in-memory-event-bus.js";
import { NatsEventBus } from "./platform/events/nats-event-bus.js";
import { registerEventRoutes } from "./platform/events/routes.js";
import { createEventSchemaRegistry } from "./platform/events/schema-registry.js";
import { PostgresAuditStore } from "./platform/audit/store.js";
import { registerAuditLogAdminRoutes } from "./platform/audit/routes.js";
import { AuditVerifierWorker, PostgresAuditVerifierLease } from "./platform/audit/worker.js";
import {
  LeaderElection,
  PostgresAdvisoryLockClient,
  SingletonWorkerSupervisor,
  type SupervisedWorker,
} from "./platform/leader/election.js";
import { PendingActionExpiryWorker } from "./platform/tools/pending-action-expiry-worker.js";
import { type ImmutableAuditObjectLockMode } from "./platform/audit/immutable-s3.js";
import { AuditShippingWorker } from "./platform/audit/shipping-worker.js";
import {
  createAuditDestinationShipper,
  type AuditDestinationConfig,
} from "./platform/audit/destinations.js";
import type { SiemAuditFormat } from "./platform/audit/siem-format.js";
import type { SiemSyslogTransport } from "./platform/audit/siem-syslog.js";
import {
  ClamavScanner,
  createDispatchAuthorizedAttachmentResolver,
  DispatchTimeTransportResolver,
  ingestResolvedRawMail,
  MailQuarantineService,
  MailDeliveryAlertMonitor,
  NodemailerMailTransport,
  OutboundMailDispatcher,
  OutboundMailWorker,
  PostgresMailDeliveryEventStore,
  PostgresMailQuarantineStore,
  PostgresMailStore,
  PostgresMailDkimKeyStore,
  PostgresMailDmarcReportStore,
  PostgresMailRoutingRuleStore,
  PostgresOutboundProviderStore,
  PostgresReceivingDomainStore,
  PostgresSendingDomainStore,
  MailAdminStatusService,
  registerMailAdminRoutes,
  registerMailDeliveryAdminRoutes,
  registerMailDeliveryEventAdminRoutes,
  registerMailEnrichments,
  registerMailIndexer,
  registerMailProviderWebhookRoutes,
  registerMailQuarantineAdminRoutes,
  registerMailStreamRoutes,
  registerMailTools,
  createSmtpRecipientResolver,
  SmtpMailReceiver,
  SpamdScanner,
  quarantineReleaseScannerFromAntivirus,
  withOutboundRoutingInvalidation,
} from "./platform/mail/index.js";
import { isAllowedMailSecretReference } from "./platform/mail/secret-policy.js";
import { mailConfig } from "./platform/mail/config.js";
import {
  PostgresMeetStore,
  registerMeetRoutes,
  registerMeetTools,
  registerMockRecorderTools,
} from "./platform/meet/index.js";
import {
  PostgresNotificationStore,
  registerNotificationTools,
} from "./platform/notifications/index.js";
import {
  MeteringIngestWorker,
  MeteringRollupWorker,
  PostgresMeteringEventStore,
  PostgresMeteringRollupStore,
} from "./platform/metering/index.js";
import {
  PostgresSheetsStore,
  registerSheets,
  registerSheetsRoutes,
} from "./platform/sheets/index.js";
import {
  PostgresSlidesStore,
  registerSlides,
  registerSlidesRoutes,
} from "./platform/slides/index.js";
import { PostgresGroupsStore, registerAdminGroupsRoutes } from "./platform/admin/groups.js";
import {
  PostgresSecurityPoliciesStore,
  registerAdminSecurityPoliciesRoutes,
} from "./platform/admin/security-policies.js";
import { registerTenantConfigAdminRoutes } from "./platform/admin/tenant-config.js";
import {
  PostgresOAuthAppsStore,
  registerAdminOAuthAppsRoutes,
} from "./platform/admin/oauth-apps.js";
import { PostgresBillingStore, registerAdminBillingRoutes } from "./platform/admin/billing.js";
import { PostgresDomainsStore, registerAdminDomainsRoutes } from "./platform/admin/domains.js";
import { NodeDnsResolver } from "./platform/admin/dns-resolver.js";
import { DnsTxtDomainOwnershipVerifier } from "./platform/admin/domain-identity.js";
import { registerReceivingDomainAdminRoutes } from "./platform/mail/receiving-domains-routes.js";
import { DnsTxtReceivingDomainOwnershipVerifier } from "./platform/mail/receiving-domain-ownership.js";
import { signupEventSchemas } from "./platform/signup/event-schemas.js";
import { registerSignupRoutesForMode } from "./platform/signup/routes.js";
import {
  SignupOnboardingInviteEmailWorker,
  SignupVerificationEmailWorker,
} from "./platform/signup/email-delivery.js";
import {
  InMemorySignupAbuseProtector,
  RedisSignupAbuseProtector,
  ioredisSignupRateLimitClient,
  parseBlockedSignupEmailDomains,
} from "./platform/signup/abuse.js";
import {
  ConfiguredCountrySignupRiskReviewer,
  parseSignupManualReviewCountries,
} from "./platform/signup/risk-review.js";
import {
  PostgresSignupEmailVerificationTokenStore,
  PostgresSignupOwnerEmailLookup,
  PostgresSignupVerifiedIdentityStore,
} from "./platform/signup/verification.js";
import {
  DefaultSignupPasswordScreener,
  HaveIBeenPwnedPasswordChecker,
} from "./platform/signup/password-screening.js";
import { GoogleRecaptchaVerifier } from "./platform/signup/recaptcha.js";
import { PostgresSignupOnboardingStore } from "./platform/signup/onboarding.js";
import { PostgresSignupOnboardingInviteTokenStore } from "./platform/signup/invites.js";
import { OutboxWorker } from "./platform/outbox/outbox.js";
import { PostgresOutboxStore } from "./platform/outbox/postgres-store.js";
import { registerPluginAdminRoutes } from "./platform/plugins/admin-routes.js";
import { PostgresPluginLifecycleStore, registerPluginTools } from "./platform/plugins/tools.js";
import { TenantConfigFeatureFlagProvider } from "./platform/feature-flags/provider.js";
import {
  createMeilisearchHttpClient,
  MeilisearchSearchEngine,
  SemanticSearchEngine,
  SearchEventIndexer,
  SearchReindexService,
  createPostgresSearchReindexSources,
  registerSearchAdminRoutes,
  registerSearchTools,
} from "./platform/search/index.js";
import type { GlobalSearchType } from "./platform/search/scope.js";
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
import { tierDefaults } from "./platform/config/tier.js";
import { evaluateTierReadiness } from "./platform/config/tier-readiness.js";
import { isSaas } from "./platform/mode/index.js";
import { CoreAppRegistrationPlan, resolveCoreAppStatuses } from "./platform/apps/core-apps.js";
import {
  installTenantContextHook,
  PostgresOrgStore,
  PostgresPlanStore,
  TenantActorMismatchError,
  TenantResolutionError,
  PostgresTenantRoleProvisioner,
  PostgresTenantProvisioningStore,
  PostgresTenantOwnerActorStore,
  PostgresTenantStorageNamespaceStore,
  PostgresTenantBootstrapSeedStore,
  TenantProvisioningWorker,
  TenantHardDeleteWorker,
  buildEffectiveTenantConfig,
  createPostgresTenantExportManifestPlanner,
  initialOwnerActorStepName,
  objectStorePrefixStepName,
  registerTenantLifecycleRoutes,
  tenantBootstrapSeedStepName,
  type TenantContext,
  type DefaultOrgInput,
  type OrgRecord,
  type OrgStore,
  type TenantProvisioningRecord,
  type TenantProvisioningStep,
  assertActorMatchesRequestTenant,
  ensureDefaultOrgForMode,
  resolveDefaultOrgInput,
  resolveTenantContext,
} from "./platform/tenancy/index.js";
import { registerEditorsCoreApp } from "./platform/editors/index.js";
import { createEditorsRuntimeHost } from "./platform/editors/core-app.js";
import { registerCoreAppsAdminRoutes } from "./platform/apps/admin-routes.js";
import { loadConnectors, registerConnectorsAdminRoute } from "./platform/connectors/index.js";
import {
  createMfaAssertionVerificationResolver,
  evaluateAdminMfa,
  type MfaVerificationResolver,
} from "./platform/auth/mfa.js";
import {
  InMemoryAgentRateCostLimiter,
  InMemoryTenantHourlyQuotaLimiter,
  InMemoryTenantApiRpsLimiter,
  RedisAgentRateCostLimiter,
  RedisTenantHourlyQuotaLimiter,
  RedisTenantApiRpsLimiter,
  type AgentLimitBudget,
  type TenantHourlyQuotaLimiter,
  type TenantApiRpsLimiter,
} from "./platform/limits/index.js";
import {
  CerbosToolAccessPolicy,
  ObservedToolAccessPolicy,
  ScopeToolAccessPolicy,
} from "./platform/permissions/tool-access.js";
import {
  ByoStorageHealthWorker,
  PostgresTenantStorageMigrationJobStore,
  TenantStorageMigrationWorker,
  createDefaultTenantStorageResolver,
  createS3CompatibleStorage,
  createTenantStorageMigrationPairResolver,
  createTenantStorageResolver,
  resolveTenantStorageSnapshot,
} from "./platform/storage/index.js";
import { createVaultTenantStorageSecretReaderFromEnv } from "./platform/secrets/index.js";
import {
  createToolRegistry,
  type RuntimeToolRegistry,
  type ToolInvokeErrorResult,
} from "./platform/tool-registry.js";
import { PostgresPendingActionStore } from "./platform/tools/pending-actions-postgres-store.js";
import { InMemoryConfirmationGate } from "./platform/tools/registry.js";
import {
  OutboundWebhookWorker,
  PostgresWebhookStore,
  registerWebhookVerificationDocsRoute,
  registerWebhookRoutes,
  registerWebhookTools,
} from "./platform/webhooks/index.js";
import type { PlatformMetrics } from "./api/metrics.js";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import type { AccessTokenStore } from "./platform/auth/oauth.js";
import { enforceCredentialPolicy, type AgentCredentialStore } from "./platform/auth/credentials.js";
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
  ModelInfo,
  MeteringClient,
  SecurityTier,
} from "@helix/sdk-types";

const execFileAsync = promisify(execFile);
const EDITORS_NATIVE_FEATURE_FLAGS = new Set([
  "editors_native_document",
  "editors_native_spreadsheet",
  "editors_native_presentation",
  "editors_native_pdf",
]);

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

export function installTenantApiRpsLimitHook(
  app: FastifyInstance,
  options: TenantApiRpsLimitHookOptions,
): void {
  app.addHook("preHandler", async (request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (path === "/api/auth" || path.startsWith("/api/auth/")) {
      return;
    }

    const tenant = (request as unknown as { readonly tenant?: TenantContext | null }).tenant;
    if (tenant === null || tenant === undefined) {
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
        | { readonly store: IdempotencyStore; readonly key: string; readonly hash: string }
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
  app.get("/api/actions/:pendingId", actionStatusHandler);
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
  message: z.string().min(1).max(100_000),
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
  AssistantStreamEvent | { readonly type: "error"; readonly message: string };

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

export async function createHelixServer(): Promise<FastifyInstance> {
  const bootEnv = env();
  const trustedOrigins = parseTrustedOrigins(bootEnv.BETTER_AUTH_TRUSTED_ORIGINS);
  const app = fastify({
    logger: helixLoggerOptions(bootEnv.LOG_LEVEL),
    // P1-10: API versioning. `/v1/...` requests are rewritten to the canonical
    // unprefixed path before routing, so a single handler set serves both the
    // versioned surface and the legacy unprefixed aliases.
    rewriteUrl: (request: IncomingMessage) => rewriteVersionedApiUrl(request.url ?? "/"),
    // Fastify defaults to ~1 MB request bodies. Drive uploads ride a JSON
    // tool envelope that base64-encodes the file payload, so the JSON
    // body is ~1.33× the file size. Bump to 128 MB for the API tier so
    // typical office docs (a few MB), PDFs (tens of MB), and small ZIPs
    // upload without hitting the default ceiling. Override via
    // `HELIX_BODY_LIMIT_BYTES` for production hosts that need different
    // ingress sizing.
    bodyLimit: bootEnv.HELIX_BODY_LIMIT_BYTES,
    // Tool routes carry signed pending-action ids and other long path
    // segments; Fastify's default `maxParamLength` of 100 silently 404s
    // anything longer. 2 KB matches the URL-segment ceiling most reverse
    // proxies tolerate without rejecting the request outright.
    routerOptions: {
      maxParamLength: 2048,
    },
  });

  const metrics = createPlatformMetrics();
  // P1-10: advertise the API version on every response so clients can detect
  // the contract they are talking to without parsing the OpenAPI document.
  app.addHook("onSend", async (_request, reply) => {
    if (!reply.hasHeader("api-version")) {
      reply.header("api-version", HELIX_API_VERSION_HEADER_VALUE);
    }
  });
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
  const redisConnection = resolveRedisConnection(bootEnv);
  const redis =
    redisConnection === undefined
      ? undefined
      : new Redis(redisConnection.url, redisConnection.options);
  const idempotencyStore: IdempotencyStore =
    redis === undefined ? new InMemoryIdempotencyStore() : new RedisIdempotencyStore(redis);
  const tenantApiRpsLimiter: TenantApiRpsLimiter =
    redis === undefined ? new InMemoryTenantApiRpsLimiter() : new RedisTenantApiRpsLimiter(redis);
  const tenantHourlyQuotaLimiter: TenantHourlyQuotaLimiter =
    redis === undefined
      ? new InMemoryTenantHourlyQuotaLimiter()
      : new RedisTenantHourlyQuotaLimiter(redis);
  const oauthStore = new PostgresOAuthStore(sql);
  // PRD §9.2: expanded agent credential model. The credential store resolves
  // `api_key` / `mtls_cert` credentials together with their per-credential
  // policy (IP allowlist, allowed-hours, expiry, revocation) for request-path
  // enforcement. The authorization-code store backs the OAuth 2.1
  // Authorization Code flow with PKCE (PRD §13.6).
  const agentCredentialStore = new PostgresAgentCredentialStore(sql);
  const authorizationCodeStore = new PostgresAuthorizationCodeStore(sql);
  const authorizationCodeService = new AuthorizationCodeService({
    codeStore: authorizationCodeStore,
  });
  const betterAuthConfig = getBetterAuthRuntimeConfig(process.env);
  const betterAuthRuntime =
    betterAuthConfig === undefined ? undefined : createBetterAuthRuntime(betterAuthConfig);
  const betterAuthSessionIssuer =
    betterAuthConfig === undefined
      ? undefined
      : new PostgresBetterAuthSessionIssuer(sql, {
          secret: betterAuthConfig.secret,
          baseUrl: betterAuthConfig.baseUrl,
        });
  const tenantRoleProvisioner = envFlag("HELIX_TENANT_POSTGRES_ROLES_ENABLED", false)
    ? new PostgresTenantRoleProvisioner(sql, {
        appRole: bootEnv.HELIX_POSTGRES_APP_ROLE,
      })
    : undefined;
  const orgStore = new PostgresOrgStore(sql, {
    ...(tenantRoleProvisioner === undefined ? {} : { tenantRoleProvisioner }),
  });
  const tenantProvisioningStore = new PostgresTenantProvisioningStore(sql);
  const tenantOwnerActorStore = new PostgresTenantOwnerActorStore(sql);
  const tenantStorageNamespaceStore = new PostgresTenantStorageNamespaceStore(sql);
  const tenantBootstrapSeedStore = new PostgresTenantBootstrapSeedStore(sql);
  const tenantIdpConfigStore = new PostgresTenantIdpConfigStore(sql);
  const tenantScimCredentialStore = new PostgresTenantScimCredentialStore(sql);
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
    ...(tenantRoleProvisioner === undefined
      ? []
      : [
          {
            name: "postgres_role_provisioned",
            run: async (record: TenantProvisioningRecord) => {
              await tenantRoleProvisioner.ensureRoleForOrg(record.orgId);
            },
          },
        ]),
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
  const auditStore = new PostgresAuditStore(sql, {
    onAppend: (record) => {
      metrics.recordAuditActivity({ verb: record.verb, objectType: record.objectType });
    },
  });
  const tenantHardDeleteWorker = envFlag("HELIX_TENANT_HARD_DELETE_WORKER_ENABLED", false)
    ? new TenantHardDeleteWorker({
        store: orgStore,
        steps: [],
        gracePeriodDays: bootEnv.TENANT_HARD_DELETE_RETENTION_DAYS,
        batchSize: bootEnv.TENANT_HARD_DELETE_BATCH_SIZE,
        intervalMs: bootEnv.TENANT_HARD_DELETE_INTERVAL_MS,
        onHardDeleted: async ({ previous, updated }) => {
          await auditStore.append({
            orgId: updated.id,
            actorId: "system",
            verb: "tenant.lifecycle.hard_deleted",
            objectType: "tenant",
            objectId: updated.id,
            metadata: {
              slug: updated.slug,
              previousStatus: previous.status,
              nextStatus: updated.status,
              softDeletedAt: previous.softDeletedAt?.toISOString() ?? null,
              hardDeletedAt: updated.hardDeletedAt?.toISOString() ?? null,
            },
          });
        },
        onResult: (result) => {
          if (result.checked > 0) {
            app.log.info(result, "Tenant hard-delete worker run completed");
          }
        },
        onError: (error) => {
          app.log.error({ error }, "Tenant hard-delete worker error");
        },
      })
    : undefined;
  const webhookStore = new PostgresWebhookStore(sql);
  const chatStore = new PostgresChatStore(sql);
  const calendarStore = new PostgresCalendarStore(sql);
  const cardDavContactStore = new PostgresCardDavContactStore(sql);
  const assistantStore = new PostgresAssistantStore(sql);
  const outboxStore = new PostgresOutboxStore(sql);
  const pluginLifecycleStore = new PostgresPluginLifecycleStore(sql);
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
      : await NatsEventBus.connect(natsSecurityPolicy.connection, { subjectPrefix: "helix" });
  const meteringEventStore = new PostgresMeteringEventStore(sql);
  const meteringRollupStore = new PostgresMeteringRollupStore(sql);
  const meteringClient = createMeteringClient(eventBus);
  const meetStore = new PostgresMeetStore(sql, {
    metering: meteringClient,
    onMeteringError: (error: unknown) => {
      app.log.error({ error }, "Meet recording storage metering emission failed");
    },
  });
  const betterAuthPlatform = createBetterAuthPlatformModule({
    actorStore: new PostgresBetterAuthActorStore(sql),
    userLinkStore: new PostgresBetterAuthUserLinkStore(sql),
    defaultOrgId: defaultOrg.id,
    metering: meteringClient,
    onMeteringError: (error: unknown) => {
      app.log.error({ error }, "BetterAuth seat metering emission failed");
    },
  });
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
  await verifyDefaultOrgAtBoot({
    config: runtimeConfig,
    orgs: orgStore,
    defaultOrg,
    logger: app.log,
  });
  const resolveTenantForRequest = (request: Pick<FastifyRequest, "headers" | "url" | "method">) =>
    resolveTenantContext({
      config: runtimeConfig,
      orgs: orgStore,
      plans: planStore,
      request,
      defaultOrg,
    });
  installTenantContextHook(app, {
    resolveTenantContext: (request) => resolveTenantForRequest(request),
  });
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
  const assistantMemory = new PostgresMemoryStore(sql, {
    embeddingProvider: createAssistantEmbeddingProvider(runtimeConfig.ai),
    defaultSource: "assistant.conversation",
  });
  const securityTier = runtimeConfig.security.tier;
  // P2-1: startup tier-hardening readiness check. For the configured tier,
  // verify the required controls are satisfiable; fail closed when a required
  // in-app-enforceable control (Tier 2+ audit shipping, Tier 3 Vault/SIEM) is
  // missing, and emit explicit warnings for controls that genuinely cannot be
  // verified in-app (internal mTLS, encryption at rest). Tier 1 never blocks.
  // `HELIX_TIER_READINESS_ENFORCE=false` downgrades a fail-closed boot to a
  // warning for staged rollouts.
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
    if (envFlag("HELIX_TIER_READINESS_ENFORCE", true)) {
      throw new Error(
        `Tier '${tierReadiness.tier}' readiness check failed: ${tierReadiness.failures
          .map((failure) => failure.control)
          .join(", ")}. Resolve the controls above or set HELIX_TIER_READINESS_ENFORCE=false.`,
      );
    }
    app.log.warn(
      { tier: tierReadiness.tier },
      "Tier readiness check failed but HELIX_TIER_READINESS_ENFORCE=false; continuing",
    );
  }
  // P2-1: MFA-required-for-admins enforcement. On tiers that require admin MFA
  // (Tier 2+), admin-scoped requests from an actor without a verified MFA
  // factor are rejected before the route handler runs.
  const mfaResolver: MfaVerificationResolver = createMfaAssertionVerificationResolver({
    secret: bootEnv.HELIX_MFA_ASSERTION_SECRET,
    issuer: bootEnv.HELIX_MFA_ASSERTION_ISSUER,
    audience: bootEnv.HELIX_MFA_ASSERTION_AUDIENCE,
  });
  // P0-7: durable AI cost limiting. Backed by Redis when available so budgets
  // survive restarts and are shared across replicas; the in-memory limiter
  // remains the single-process fallback.
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
          forcePathStyle: driveConfig.storage.forcePathStyle,
        });
  const tenantStorageSecretReader = createVaultTenantStorageSecretReaderFromEnv(process.env);
  const driveStorageResolver = createTenantStorageResolver({
    defaultClient: driveStorage,
    loadByoConfig: async (orgId: string) => (await orgStore.findById(orgId))?.byoConfig,
    metrics,
    secretReader: tenantStorageSecretReader,
  });
  const helixDefaultStorageResolver = createDefaultTenantStorageResolver(driveStorage);
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
  const docsStore = new PostgresDocsStore(sql, {
    storageResolver: driveStorageResolver,
  });
  const docsPdfRenderer =
    bootEnv.HELIX_DOCS_PDF_RENDERER === "deterministic"
      ? undefined
      : createHeadlessChromiumPdfRenderer({
          ...(bootEnv.HELIX_CHROMIUM_PATH === undefined
            ? {}
            : { executablePath: bootEnv.HELIX_CHROMIUM_PATH }),
          timeoutMs: bootEnv.HELIX_DOCS_PDF_RENDER_TIMEOUT_MS,
        });
  const mailStore = new PostgresMailStore(sql, {
    storageResolver: driveStorageResolver,
  });
  const mailQuarantineStore = new PostgresMailQuarantineStore(sql);
  const officePreviewConverter =
    driveConfig.officePreview.url === undefined
      ? driveConfig.officePreview.localFallback
        ? createLocalOfficePreviewConverter({
            ...(driveConfig.chromiumPath === undefined
              ? {}
              : { executablePath: driveConfig.chromiumPath }),
            timeoutMs: driveConfig.officePreview.timeoutMs,
          })
        : undefined
      : createLibreOfficePreviewClient({
          endpoint: driveConfig.officePreview.url,
          timeoutMs: driveConfig.officePreview.timeoutMs,
          allowedHosts: driveConfig.officePreview.allowedHosts,
        });
  const driveStore = new PostgresDriveStore(sql, driveStorage, {
    ...(officePreviewConverter === undefined ? {} : { officePreviewConverter }),
    storageResolver: driveStorageResolver,
    metering: meteringClient,
    events: eventBus,
    contentAddressedDedup: driveConfig.contentAddressedDedup,
    multipartThresholdBytes: driveConfig.multipartThresholdBytes,
    multipartPartSizeBytes: driveConfig.multipartPartSizeBytes,
    storageEncryptionPolicy: async (orgId) =>
      driveStorageEncryptionPolicyForTenant({
        byoConfig: (await orgStore.findById(orgId))?.byoConfig,
        defaultPolicy:
          driveConfig.storage.serverSideEncryption === undefined
            ? undefined
            : {
                mode: driveConfig.storage.serverSideEncryption,
                ...(driveConfig.storage.serverSideEncryptionAwsKmsKeyId === undefined
                  ? {}
                  : { kmsKeyId: driveConfig.storage.serverSideEncryptionAwsKmsKeyId }),
              },
      }),
    onMeteringError: (error: unknown) => {
      app.log.error({ error }, "Drive storage metering emission failed");
    },
    onQuotaEventError: (error: unknown) => {
      app.log.error({ error }, "Drive storage quota event emission failed");
    },
  });
  const driveLifecycleGcWorker = driveConfig.gc.enabled
    ? new DriveLifecycleGcWorker({
        store: driveStore,
        intervalMs: driveConfig.gc.intervalMs,
        orphanGraceHours: driveConfig.gc.orphanGraceHours,
        batchSize: driveConfig.gc.batchSize,
        onResult: (result) => {
          if (result.candidates > 0) {
            app.log.info(result, "Drive lifecycle garbage collection completed");
          }
        },
        onError: (error) => {
          app.log.error({ error }, "Drive lifecycle garbage collection error");
        },
      })
    : undefined;
  const driveVirusScanner =
    driveConfig.malwareScanner === undefined
      ? undefined
      : createClamAvVirusScanner({
          ...driveConfig.malwareScanner,
          tier: securityTier,
          metrics,
        });
  if (driveConfig.isProduction) {
    assertDriveMalwareScannerReady(securityTier, driveVirusScanner);
  }
  const driveUploadScanWorker =
    driveVirusScanner === undefined || !coreApps.shouldRegister("drive")
      ? undefined
      : createDriveUploadScanWorker({
          sql,
          scanner: driveVirusScanner,
          tier: securityTier,
          ...(driveStorage === undefined ? {} : { storage: driveStorage }),
          storageResolver: driveStorageResolver,
          metrics,
          onError: (error) => {
            app.log.error({ error }, "Drive upload scan worker error");
          },
        });
  const searchEngine = await createSearchEngine();
  const semanticEmbeddingProvider = createSemanticSearchEmbeddingProvider(runtimeConfig.ai);
  const vectorStore = createConfiguredVectorStore(runtimeConfig.ai, { sql });
  const runtimeSearchEngine =
    searchEngine !== undefined &&
    semanticEmbeddingProvider !== undefined &&
    vectorStore !== undefined
      ? new SemanticSearchEngine({
          keyword: searchEngine,
          embeddings: semanticEmbeddingProvider,
          vectorStore,
        })
      : searchEngine;
  const searchEventIndexer =
    runtimeSearchEngine === undefined
      ? undefined
      : new SearchEventIndexer({
          events: eventBus,
          engine: runtimeSearchEngine,
          subject: bootEnv.SEARCH_EVENT_SUBJECT,
          onError: (error) => {
            app.log.error({ error }, "Search event indexer error");
          },
        });
  if (searchEventIndexer !== undefined) {
    // Indexers are registered per core app, conditionally on enablement +
    // role. A disabled app contributes no search indexer.
    if (coreApps.shouldRegister("mail")) {
      registerMailIndexer(searchEventIndexer, mailStore);
    }
    if (coreApps.shouldRegister("chat")) {
      registerChatIndexer(searchEventIndexer, chatStore);
    }
    if (coreApps.shouldRegister("docs")) {
      registerDocsIndexer(searchEventIndexer, docsStore);
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
  if (coreApps.shouldRegister("docs")) {
    registerDocsEnrichments(enrichmentWorker, {
      store: docsStore,
      ai: assistantAi,
      outline: envFlag("DOCS_OUTLINE_ENRICHMENT", true),
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
  const mailCfg = mailConfig(bootEnv, securityTier);
  const outboundMailConfig = mailAppRegistered ? mailCfg.outbound : undefined;
  const outboundProviderStore = new PostgresOutboundProviderStore(sql);
  const sendingDomainStore = new PostgresSendingDomainStore(sql);
  const mailDeliveryEventStore = new PostgresMailDeliveryEventStore(sql);
  const validatedMailSecrets = bootEnv as unknown as Readonly<Record<string, string | undefined>>;
  const mailSecretProvider = {
    resolveSecret: async (reference: string): Promise<string | undefined> =>
      isAllowedMailSecretReference(reference) ? validatedMailSecrets[reference] : undefined,
  };
  const environmentOutboundTransport =
    outboundMailConfig === undefined ? undefined : new NodemailerMailTransport(outboundMailConfig);
  const outboundTransportResolver = !mailAppRegistered
    ? undefined
    : new DispatchTimeTransportResolver({
        providerStore: outboundProviderStore,
        domainStore: sendingDomainStore,
        secrets: mailSecretProvider,
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
  const mailAdminRoutingStores =
    outboundTransportResolver === undefined
      ? { providerStore: outboundProviderStore, domainStore: sendingDomainStore }
      : withOutboundRoutingInvalidation(outboundProviderStore, sendingDomainStore, (orgId) => {
          outboundTransportResolver.invalidateOrg(orgId);
        });
  const outboundMailWorker =
    outboundTransportResolver === undefined
      ? undefined
      : new OutboundMailWorker({
          events: eventBus,
          dispatcher: new OutboundMailDispatcher(
            mailStore,
            outboundTransportResolver.transportFor,
            {
              // Stream/large attachments referenced by Drive objectId (G8 / Mail A2.5).
              resolveAttachment: createDispatchAuthorizedAttachmentResolver({
                readFile: (input) => driveStore.readFile(input),
              }),
              suppressionStore: mailDeliveryEventStore,
            },
          ),
          onError: (error) => {
            app.log.error({ error }, "Outbound mail dispatch error");
          },
        });
  const signupFromAddress = {
    address: mailCfg.signupFrom.address,
    name: mailCfg.signupFrom.name,
  };
  const signupVerificationEmailWorker =
    environmentOutboundTransport === undefined
      ? undefined
      : new SignupVerificationEmailWorker({
          events: eventBus,
          transport: environmentOutboundTransport,
          from: signupFromAddress,
          onError: (error) => {
            app.log.error({ error }, "Signup verification email delivery error");
          },
        });
  const signupOnboardingInviteEmailWorker =
    environmentOutboundTransport === undefined
      ? undefined
      : new SignupOnboardingInviteEmailWorker({
          events: eventBus,
          transport: environmentOutboundTransport,
          from: signupFromAddress,
          onError: (error) => {
            app.log.error({ error }, "Signup onboarding invite email delivery error");
          },
        });
  const smtpMailReceiverConfig = mailAppRegistered ? mailCfg.receiver : undefined;
  // Config-gated inbound content scanners: spamd (SpamAssassin) and ClamAV.
  const spamdScannerConfig = mailCfg.spamd;
  const clamavScannerConfig = mailCfg.clamav;
  const smtpRecipientResolver = createSmtpRecipientResolver({
    receivingDomains: new PostgresReceivingDomainStore(sql),
  });
  const mailAntivirusScanner =
    clamavScannerConfig === undefined
      ? undefined
      : new ClamavScanner({
          ...clamavScannerConfig,
          tier: securityTier,
          metrics,
        });
  const smtpMailReceiver =
    smtpMailReceiverConfig === undefined
      ? undefined
      : new SmtpMailReceiver({
          store: mailStore,
          recipientResolver: smtpRecipientResolver,
          transportSecurity: smtpMailReceiverConfig.transportSecurity,
          limits: smtpMailReceiverConfig.limits,
          logger: app.log,
          scanners: {
            ...(spamdScannerConfig ? { spam: new SpamdScanner(spamdScannerConfig) } : {}),
            ...(mailAntivirusScanner === undefined ? {} : { antivirus: mailAntivirusScanner }),
            tier: securityTier,
          },
          quarantineStore: mailQuarantineStore,
        });
  const mailQuarantineService =
    mailAntivirusScanner === undefined
      ? undefined
      : new MailQuarantineService({
          store: mailQuarantineStore,
          scanner: quarantineReleaseScannerFromAntivirus(mailAntivirusScanner),
          deliver: async (record, rawMessage) => {
            const recipients = await Promise.all(
              record.envelopeTo.map((address) => smtpRecipientResolver.resolveRecipient(address)),
            );
            if (
              recipients.some((recipient) => recipient === null || recipient.orgId !== record.orgId)
            ) {
              throw new Error(
                "One or more quarantined recipients are no longer active in the organization.",
              );
            }
            await ingestResolvedRawMail({
              store: mailStore,
              input: {
                raw: rawMessage,
                recipients: recipients.filter((recipient) => recipient !== null),
                ...(record.envelopeFrom === null ? {} : { envelopeFrom: record.envelopeFrom }),
              },
            });
          },
          auditSink: auditStore,
        });
  const outboundWebhookWorker = new OutboundWebhookWorker({
    store: webhookStore,
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
  const auditShippingWorkers = auditDestinationConfigs.map((config) => {
    const shipper = createAuditDestinationShipper(config, {
      sql,
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
      if (EDITORS_NATIVE_FEATURE_FLAGS.has(key)) {
        const status = await platformConfig.getStatus();
        if (status.config.modules?.editors?.enabled === false) {
          return false as T;
        }
      }
      return featureFlags.getAsync(key, defaultValue, context);
    },
  };
  const tools = createToolRegistry({
    accessPolicy: toolAccessPolicy,
    confirmationGate,
    confirmationDefaults: tierDefaults[securityTier],
    auditSink: auditStore,
    agentRateCostLimiter,
    agentLimitTier: securityTier,
    ...(agentLimitBudgetOverride === undefined
      ? {}
      : { agentLimitBudget: agentLimitBudgetOverride }),
    metrics,
    featureFlags: runtimeFeatureFlags,
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
  registerWebhookTools(tools, { store: webhookStore });
  // Core-app agent tools are contributed per app, conditionally on enablement
  // + role: a disabled app contributes no tools to the registry, so it is
  // absent from REST, tRPC, MCP and the assistant.
  if (coreApps.shouldRegister("mail")) {
    registerMailTools(tools, {
      store: mailStore,
      defaultFromDomain: mailCfg.fromDomain,
      ...(resourceClassifier === undefined ? {} : { classifyResource: resourceClassifier }),
    });
    registerMailStreamRoutes(app, {
      events: eventBus,
      resolveActor: async (request) => {
        const actor = await actorFromAuthenticatedRequest(request);
        return { id: actor.id, orgId: actor.orgId };
      },
    });
  }
  if (coreApps.shouldRegister("chat")) {
    registerChatTools(tools, {
      store: chatStore,
      ...(resourceClassifier === undefined ? {} : { classifyResource: resourceClassifier }),
    });
  }
  if (coreApps.shouldRegister("docs")) {
    registerDocsTools(tools, {
      store: docsStore,
      ai: assistantAi,
      ...(docsPdfRenderer === undefined ? {} : { pdfRenderer: docsPdfRenderer }),
      onPdfRendererError: (error: unknown) => {
        app.log.warn({ error }, "Docs PDF Chromium renderer failed; using deterministic fallback");
      },
      ...(resourceClassifier === undefined ? {} : { classifyResource: resourceClassifier }),
      exportJobLimiter: tenantHourlyQuotaLimiter,
      exportJobLimit: async (input) => {
        const org = await orgStore.findById(input.orgId);
        if (org === null) {
          return null;
        }
        const plan = await planStore.findById(org.planId);
        return buildEffectiveTenantConfig({ org, plan }).quotas.export_jobs_per_hour;
      },
      quotaEvents: eventBus,
      onQuotaEventError: (error: unknown) => {
        app.log.error({ error }, "Docs export quota event emission failed");
      },
      metering: meteringClient,
      onMeteringError: (error: unknown) => {
        app.log.error({ error }, "Docs export metering emission failed");
      },
    });
  }
  // Wave-1 backend domains. Sheets and Slides stores are instantiated here so
  // they can be shared with the drive.create tool (unified "New" entry-point)
  // and their own domain tool registrations below.
  const sheetsStore = new PostgresSheetsStore(sql, { storageResolver: driveStorageResolver });
  const slidesStore = new PostgresSlidesStore(sql, { storageResolver: driveStorageResolver });
  if (coreApps.shouldRegister("drive")) {
    registerDriveTools(tools, {
      store: driveStore,
      enablePdfEditing: coreApps.shouldRegister("editors"),
      ...(resourceClassifier === undefined ? {} : { classifyResource: resourceClassifier }),
      ...(coreApps.shouldRegister("docs") ? { docsStore } : {}),
      ...(coreApps.shouldRegister("editors") ? { sheetsStore, slidesStore } : {}),
      // Owner-display resolver for drive.list responses. Batches actor
      // id → display_name + email lookups against the actors table so
      // the UI shows "Avery Park" / "leo@helix.local" instead of raw
      // UUIDs in the owner column.
      resolveActorNames: async (ids) => {
        if (ids.length === 0) return new Map();
        const rows = (await sql`
          select id, display_name, email
          from actors
          where id in ${sql(ids as string[])}
        `) as unknown as readonly {
          readonly id: string;
          readonly display_name: string | null;
          readonly email: string | null;
        }[];
        const result = new Map<string, { displayName: string; email?: string }>();
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
        const rows = (await sql`
          select id, display_name, email
          from actors
          where org_id = ${orgId}
            and disabled_at is null
            and (
              lower(email) in ${sql(normalizedRefs)}
              or lower(display_name) in ${sql(normalizedRefs)}
            )
        `) as unknown as readonly {
          readonly id: string;
          readonly display_name: string | null;
          readonly email: string | null;
        }[];
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
    });
  }
  const calendarInvitationSender = createMailCalendarInvitationSender({
    store: mailStore,
    defaultFromDomain: bootEnv.MAIL_FROM_DOMAIN,
  });
  if (coreApps.shouldRegister("calendar")) {
    registerCalendarTools(tools, {
      store: calendarStore,
      invitationSender: calendarInvitationSender,
      rsvpBaseUrl: bootEnv.PUBLIC_BASE_URL ?? "http://localhost:3000",
    });
  }
  if (coreApps.shouldRegister("meet")) {
    registerMeetTools(tools, {
      store: meetStore,
      jwtSecret:
        bootEnv.MEET_JITSI_JWT_SECRET ?? bootEnv.JITSI_JWT_SECRET ?? "helix_jitsi_dev_secret",
      jwtAppId: bootEnv.MEET_JITSI_JWT_APP_ID ?? bootEnv.JITSI_JWT_APP_ID ?? "helix",
      jwtIssuer: bootEnv.MEET_JITSI_JWT_ISSUER ?? bootEnv.JITSI_JWT_ISSUER ?? "helix",
      jwtAudience: bootEnv.MEET_JITSI_JWT_AUDIENCE ?? "jitsi",
      jwtSubject: bootEnv.MEET_JITSI_DOMAIN,
      publicBaseUrl: bootEnv.PUBLIC_BASE_URL ?? "http://localhost:3000",
      // Full Jitsi origin (with port). Without this, joinUrls drop the
      // port and break in dev (Jitsi runs on :28452 via docker compose
      // --profile meet, not on the default :443).
      jitsiPublicUrl: bootEnv.MEET_JITSI_PUBLIC_URL,
    });
    // Dev-only stand-in for Jibri on hosts where snd-aloop can't be
    // loaded (Docker-for-Mac). Same attachRecording flow.
    registerMockRecorderTools(tools, {
      meetStore,
      storageResolver: driveStorageResolver,
      ...(driveStorage === undefined ? {} : { storage: driveStorage }),
      bucket: bootEnv.RUSTFS_BUCKET,
    });
  }
  if (runtimeSearchEngine !== undefined) {
    registerSearchTools(tools, { engine: runtimeSearchEngine });
  }
  if (coreApps.shouldRegister("editors")) {
    registerSheets({
      registry: tools,
      store: sheetsStore,
      ...(resourceClassifier === undefined ? {} : { classifyResource: resourceClassifier }),
    });
    registerSlides(tools, { store: slidesStore, driveStore });
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
    ...(coreApps.shouldRegister("docs") ? (["docs"] as const) : []),
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
  registerPluginTools(tools, {
    pluginsDir:
      bootEnv.HELIX_PLUGINS_DIR ?? fileURLToPath(new URL("../../../plugins", import.meta.url)),
    discovery: {
      tierDefaults: tierDefaults[securityTier],
    },
    lifecycleStore: pluginLifecycleStore,
  });
  const leaderGatedWorkers: { readonly name: string; readonly worker: SupervisedWorker }[] = [];
  if (coreApps.shouldRegister("editors")) {
    const editorsRuntime = createEditorsRuntimeHost({
      logger: app.log,
      env: process.env,
      app,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      tools,
      workers: {
        register: (name, worker) => {
          leaderGatedWorkers.push({ name, worker });
        },
      },
      documents: {
        async getSession(input) {
          const document = await docsStore.getDocumentForActor({
            orgId: input.orgId,
            actorId: input.actor.id,
            documentId: input.documentId,
          });
          if (document === null) {
            return null;
          }
          return {
            id: document.id,
            orgId: document.orgId,
            title: document.title,
            ownerActorId: document.ownerActorId,
            editorEngine: document.editorEngine,
            formatVersion: document.formatVersion,
            updateSeq: document.updateSeq,
            stateBase64: document.ydocState?.toString("base64") ?? null,
            stateVectorBase64: document.ydocStateVector?.toString("base64") ?? null,
            layoutSettings: nativeDocumentLayoutSettingsFromMetadata(document.metadata),
            updatedAt: document.updatedAt.toISOString(),
          };
        },
      },
      metrics,
      events: eventBus,
    });
    const result = await registerEditorsCoreApp({
      config: runtimeConfig,
      env: process.env,
      logger: app.log,
      host: editorsRuntime.host,
    });
    if (result.status === "registered") {
      app.log.info(
        {
          routes: editorsRuntime.registrations.routes.length,
          tools: editorsRuntime.registrations.tools.length,
          workers: editorsRuntime.registrations.workers.length,
          previewRenderers: editorsRuntime.registrations.previewRenderers.length,
          aiSlots: editorsRuntime.registrations.aiSlots.length,
          collabGateways: editorsRuntime.registrations.collabGateways.length,
        },
        "Editors runtime host registrations applied",
      );
    }
  }
  registerAgentCredentialTools(tools, {
    clientStore: oauthStore,
    clientManager: new OAuthClientManager({ clientStore: oauthStore }),
    scopeCatalog: [
      ...new Set([...agentCredentialScopeCatalog, ...tools.list().map((tool) => tool.permission)]),
    ],
  });
  registerAppPasswordTools(tools, {
    store: appPasswordStore,
    scopeCatalog: [
      ...new Set([...appPasswordScopeCatalog, ...tools.list().map((tool) => tool.permission)]),
    ],
  });
  const trpcRouter = createHelixTRPCRouter({ tools, metrics, platformConfig });
  installHttpMetrics(app, metrics);

  // P2-1: enforce MFA-required-for-admins. Every `/api/admin/*` route shares
  // this prefix, so a single preHandler hook gates all admin surfaces. The
  // hook resolves the request actor and, on tiers that require admin MFA,
  // rejects admin-scoped actors that have not presented a verified MFA factor.
  app.addHook("preHandler", async (request, reply) => {
    const url = request.url.split("?")[0] ?? "";
    if (!isAdminMfaProtectedPath(url)) {
      return;
    }
    const actor = await actorFromAuthenticatedRequest(request);
    const decision = evaluateAdminMfa({
      tier: securityTier,
      actor,
      mfaVerified: await mfaResolver.isMfaVerified(request, actor),
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

  await installTrustedOriginPolicy(app, trustedOrigins);
  await app.register(cookie);
  registerBetterAuthRoutes(app, betterAuthRuntime?.auth);
  await app.register(websocket);
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
    tokenService: new OAuthTokenService({
      clientStore: oauthStore,
      tokenStore: oauthStore,
      // PRD §13.6: enables the `authorization_code` token grant (PKCE).
      authorizationCodeService,
    }),
    authorizationCodeService,
    // The consent screen needs a logged-in end user; the BetterAuth session
    // resolver supplies that actor. When sessions are disabled the
    // Authorization Code endpoints stay disabled.
    ...(sessionActorResolver === undefined ? {} : { actorResolver: sessionActorResolver }),
  });
  await registerTenantSamlRoutes(app, {
    orgs: orgStore,
    idpConfigs: tenantIdpConfigStore,
    publicBaseUrl:
      bootEnv.BETTER_AUTH_URL ??
      bootEnv.HELIX_PUBLIC_URL ??
      bootEnv.PUBLIC_BASE_URL ??
      "http://localhost:3000",
  });
  await registerTenantScimRoutes(app, {
    orgs: orgStore,
    credentials: tenantScimCredentialStore,
    auditSink: auditStore,
    documentationUri: bootEnv.HELIX_SCIM_DOCS_URL ?? "https://docs.helix.example/scim",
  });
  await registerAdminIdentityRoutes(app, {
    idpConfigs: tenantIdpConfigStore,
    orgs: orgStore,
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    auditSink: auditStore,
    publicBaseUrl:
      bootEnv.BETTER_AUTH_URL ??
      bootEnv.HELIX_PUBLIC_URL ??
      bootEnv.PUBLIC_BASE_URL ??
      "http://localhost:3000",
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
      providerStore: mailAdminRoutingStores.providerStore,
      domainStore: mailAdminRoutingStores.domainStore,
      dkimStore: new PostgresMailDkimKeyStore(sql),
      dmarcStore: new PostgresMailDmarcReportStore(sql),
      routingStore: new PostgresMailRoutingRuleStore(sql),
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      auditSink: auditStore,
    });
    /* Inbound domain control plane. The SMTP receiver already reads this store
       to decide which recipients it will accept (`smtpRecipientResolver`), but
       the routes that let an operator register, prove ownership of, and enable
       a domain were never mounted — so a workspace could receive mail only for
       domains put in the table out of band. */
    /* One domains store instance for both: the receiving routes issue and read
       the ownership challenge on the admin_domains parent (migration 0087). */
    const domainIdentityStore = new PostgresDomainsStore(sql);
    await registerReceivingDomainAdminRoutes(app, {
      store: new PostgresReceivingDomainStore(sql),
      ownershipVerifier: new DnsTxtReceivingDomainOwnershipVerifier(domainIdentityStore),
      ownershipStore: domainIdentityStore,
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
      providerStore: mailAdminRoutingStores.providerStore,
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
    if (mailQuarantineService !== undefined) {
      await registerMailQuarantineAdminRoutes(app, {
        service: mailQuarantineService,
        actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      });
    }
  }
  // Core-app enablement admin API: org admins view/toggle which core apps are
  // enabled org-wide. Toggling writes `config.modules[appId].enabled` through
  // the same platform-config store + hot-reload path as other config.
  await registerCoreAppsAdminRoutes(app, {
    service: platformConfig,
    role: coreApps.role,
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
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
  });
  await registerPeopleDirectoryRoutes(app, {
    store: adminUsersStore,
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
  });
  // Wave-1 admin console: Groups & OUs, security policies, OAuth apps,
  // billing, and domain/DNS management. Each route group writes through the
  // immutable audit store so admin-console changes are tamper-evidently logged.
  await registerAdminGroupsRoutes(app, {
    store: new PostgresGroupsStore(sql),
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    auditSink: auditStore,
  });
  await registerAdminSecurityPoliciesRoutes(app, {
    store: new PostgresSecurityPoliciesStore(sql),
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
  /* Domain verification needs outbound DNS. It is on by default because an
     unverified domain cannot send or receive mail, so a deployment that cannot
     verify is a deployment whose first-run setup dead-ends. Air-gapped
     installs set HELIX_ADMIN_DNS_VERIFICATION_ENABLED=false; the route then
     answers 503 and the console says verification is disabled rather than
     reporting every record as failed. */
  const adminDnsVerificationEnabled = envValueFlag(
    bootEnv.HELIX_ADMIN_DNS_VERIFICATION_ENABLED ?? "",
    true,
  );
  await registerAdminDomainsRoutes(app, {
    store: new PostgresDomainsStore(sql),
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    auditSink: auditStore,
    ...(adminDnsVerificationEnabled ? { dnsResolver: new NodeDnsResolver() } : {}),
    ...(adminDnsVerificationEnabled
      ? { ownershipVerifier: new DnsTxtDomainOwnershipVerifier() }
      : {}),
    ...(bootEnv.HELIX_MAIL_PUBLIC_HOSTNAME === undefined
      ? {}
      : { mailHostname: bootEnv.HELIX_MAIL_PUBLIC_HOSTNAME }),
  });
  await registerBackupAdminRoutes(app, {
    service: new ScriptedBackupAdminService({
      ...(bootEnv.HELIX_BACKUP_DIR === undefined ? {} : { backupDir: bootEnv.HELIX_BACKUP_DIR }),
      ...(bootEnv.HELIX_SECURITY_TIER === undefined ? {} : { tier: bootEnv.HELIX_SECURITY_TIER }),
      ...(bootEnv.HELIX_BACKUP_SCRIPT === undefined
        ? {}
        : { backupScript: bootEnv.HELIX_BACKUP_SCRIPT }),
      ...(bootEnv.HELIX_RESTORE_SCRIPT === undefined
        ? {}
        : { restoreScript: bootEnv.HELIX_RESTORE_SCRIPT }),
    }),
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
  });
  if (runtimeSearchEngine !== undefined) {
    await registerSearchAdminRoutes(app, {
      service: new SearchReindexService({
        engine: runtimeSearchEngine,
        sources: createPostgresSearchReindexSources(sql),
        batchSize: bootEnv.SEARCH_REINDEX_BATCH_SIZE,
      }),
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    });
  }
  await registerEventRoutes(app, {
    bus: eventBus,
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    // Follow-up B: feed the helix_websocket_connections_active gauge.
    metrics,
    onError: (error) => {
      app.log.error({ error }, "Events websocket error");
    },
  });
  await registerWebhookRoutes(app, { store: webhookStore, tools });
  // Core-app HTTP/WS routes are mounted per app, conditionally on enablement +
  // role. A disabled app's routes are never mounted (the web shell renders an
  // "app disabled" state for it instead).
  const chatRoutes = coreApps.shouldRegister("chat")
    ? await registerChatRoutes(app, {
        store: chatStore,
        actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
        trustedOrigins,
        bus: new EventBusChatRoomBus(eventBus, { subjectPrefix: "chat" }),
        metrics,
        rateLimit: {
          capacity: bootEnv.CHAT_WS_RATE_LIMIT_CAPACITY,
          refillPerSecond: bootEnv.CHAT_WS_RATE_LIMIT_REFILL_PER_SECOND,
        },
        ...(redis === undefined
          ? {}
          : {
              presence: new RedisChatPresenceStore(redis, {
                ttlSeconds: bootEnv.CHAT_PRESENCE_TTL_SECONDS,
              }),
            }),
        onError: (error) => {
          app.log.error({ error }, "Chat websocket error");
        },
      })
    : undefined;
  const docsRoutes = coreApps.shouldRegister("docs")
    ? await registerDocsRoutes(app, {
        store: docsStore,
        actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
        concurrentEditorLimit: (input) =>
          input.request.effectiveConfig?.quotas.collab_concurrent_editors_per_doc ?? null,
        metrics,
        metering: meteringClient,
        onMeteringError: (error: unknown) => {
          app.log.error({ error }, "Docs collab session metering emission failed");
        },
        onError: (error) => {
          app.log.error({ error }, "Docs websocket error");
        },
      })
    : undefined;
  if (coreApps.shouldRegister("editors")) {
    await registerSheetsRoutes(app, {
      store: sheetsStore,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      events: eventBus,
      metrics,
      onError: (error) => {
        app.log.error({ error }, "Sheets websocket error");
      },
    });
    await registerSlidesRoutes(app, {
      store: slidesStore,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      metrics,
      onError: (error) => {
        app.log.error({ error }, "Slides websocket error");
      },
    });
  }
  if (coreApps.shouldRegister("calendar")) {
    await registerCalendarRoutes(app, {
      store: calendarStore,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      invitationSender: calendarInvitationSender,
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
    });
    await registerDriveShareLinkRoute(app, { store: driveStore });

    // Session-cookie-authenticated content stream for the Web UI. The /dav/*
    // routes registered above require app-password Basic Auth (the WebDAV
    // contract). The browser-driven "Open file" action in the Drive UI
    // needs a path it can hit with the existing helix_session cookie and
    // have the bytes streamed back. This route fills that gap.
    app.get<{ Params: { objectId: string } }>(
      "/api/drive/objects/:objectId/content",
      async (request, reply) => {
        const actor = await actorFromAuthenticatedRequest(request);
        // G6: defense-in-depth scope gate on top of per-object ACL.
        requireActorScope(actor, "drive.read");
        const file = await driveStore.readFile({
          orgId: actor.orgId,
          actorId: actor.id,
          objectId: request.params.objectId,
        });
        if (file === null) {
          throw new NotFoundError("File not found.");
        }
        const inline = (request.query as { download?: string }).download !== "1";
        const filename = file.entry.name;
        // HTTP headers are ISO-8859-1; filenames carry em-dashes / non-ASCII
        // characters routinely. Send a 7-bit-safe `filename=` plus the
        // RFC 5987 `filename*=UTF-8''` form so browsers see the real name.
        const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, '\\"');
        const utf8Encoded = encodeURIComponent(filename);
        const disposition = `${inline ? "inline" : "attachment"}; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;

        // Primary: blob streamed from the storage layer (RustFS in prod).
        if (file.content !== null) {
          return sendBytesWithRangeSupport({
            reply,
            request,
            bytes: Buffer.from(file.content),
            mimeType: file.entry.mimeType ?? "application/octet-stream",
            disposition,
          });
        }

        // Dev/seed fallback only. Production data must have a backing blob in
        // tenant-resolved storage; arbitrary inlineBody metadata is ignored.
        const meta = file.entry.metadata as Record<string, unknown>;
        const inlineFallback = readInlineBodyFallback(meta);
        if (inlineFallback !== null) {
          return sendBytesWithRangeSupport({
            reply,
            request,
            bytes: Buffer.from(inlineFallback.body),
            mimeType: inlineFallback.mime ?? file.entry.mimeType ?? "application/octet-stream",
            disposition,
          });
        }

        throw new NotFoundError("File content unavailable.");
      },
    );

    /* /api/drive/objects/:id/preview
     *
     * Returns a browser-renderable preview of the file:
     *  - PDF / browser-safe raster images / txt / csv / md → forwards to the
     *    raw content endpoint inline; the browser renders these natively.
     *  - SVG → rasterized to PNG so list thumbnails never embed active SVG.
     *  - AVIF / BMP / HEIC / HEIF / TIFF / PSD / JPEG 2000 / JPEG XL /
     *    unknown image/* → converted
     *    to a bounded PNG thumbnail instead of passing unsafe or unsupported
     *    image bytes through to the browser.
     *  - DOCX → converted to HTML on the fly via mammoth.
     *  - XLSX → rendered as a stack of HTML tables (one per sheet).
     *  - PPTX / OOXML presentation → rendered as first-pass slide cards.
     *  - unknown → wrapped in a small "preview not yet rendered"
     *    HTML shell with a Download link.
     *
     * The UI's "Open" action points here so clicking a file actually opens
     * something — even for office formats the browser can't display.
     */
    app.get<{ Params: { objectId: string } }>(
      "/api/drive/objects/:objectId/preview",
      async (request, reply) => {
        const actor = await actorFromAuthenticatedRequest(request);
        // G6: defense-in-depth scope gate on top of per-object ACL.
        requireActorScope(actor, "drive.read");
        const file = await driveStore.readFile({
          orgId: actor.orgId,
          actorId: actor.id,
          objectId: request.params.objectId,
        });
        if (file === null) {
          throw new NotFoundError("File not found.");
        }
        if (isAvailablePdfPreview(file.entry.preview) && file.previewContent != null) {
          return sendBytesWithRangeSupport({
            reply,
            request,
            bytes: Buffer.from(file.previewContent),
            mimeType: "application/pdf",
            disposition: `inline; filename="${previewPdfAsciiFilename(file.entry.name)}"; filename*=UTF-8''${encodeURIComponent(previewPdfFilename(file.entry.name))}`,
          });
        }
        const meta = file.entry.metadata as Record<string, unknown>;
        const inlineFallback = readInlineBodyFallback(meta);
        const bytes =
          file.content !== null ? Buffer.from(file.content) : (inlineFallback?.body ?? null);
        if (bytes === null) {
          throw new NotFoundError("File content unavailable.");
        }
        const mime = file.entry.mimeType ?? inlineFallback?.mime ?? "";
        const filename = file.entry.name;
        const rawUrl = `/api/drive/objects/${request.params.objectId}/content`;

        // SVG is browser-renderable, but Drive/list thumbnails should never
        // embed raw active SVG bytes. Rasterize to PNG before the generic
        // image/* pass-through branch.
        if (isSvgPreviewFormat(mime, filename)) {
          const png = await rasterizeSvgPreviewToPng(bytes);
          if (png !== null) {
            return sendPngPreview(reply, filename.replace(/\.svg$/iu, ".png"), png);
          }
        }

        if (isGeneratedRasterImagePreviewFormat(mime, filename)) {
          const png = await rasterizeImagePreviewToPng(bytes, mime, filename);
          if (png !== null) {
            return sendPngPreview(reply, imagePreviewFilename(filename), png);
          }
          return reply
            .type("text/html; charset=utf-8")
            .send(
              wrapPreview(
                filename,
                `<div class="placeholder"><p>This image preview could not be rendered safely.</p><p><a class="dl" href="${rawUrl}?download=1">Download to open in a native app</a></p></div>`,
                [],
              ),
            );
        }

        // Browser-native formats: serve as-is, inline.
        if (
          mime.startsWith("application/pdf") ||
          isBrowserSafeRasterImagePreviewFormat(mime, filename) ||
          mime.startsWith("video/") ||
          mime.startsWith("audio/") ||
          mime.startsWith("text/plain") ||
          mime.startsWith("text/csv") ||
          mime.startsWith("text/markdown") ||
          mime.startsWith("text/html")
        ) {
          return reply
            .header(
              "content-disposition",
              `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
            )
            .header("content-length", String(bytes.byteLength))
            .type(mime || "application/octet-stream")
            .send(bytes);
        }

        // DOCX → HTML via mammoth.
        if (mime.includes("wordprocessingml") || filename.toLowerCase().endsWith(".docx")) {
          const mammothModule = (await import("mammoth")) as unknown as {
            readonly default?: { readonly convertToHtml: typeof mammothConvertToHtml };
            readonly convertToHtml: typeof mammothConvertToHtml;
          };
          const mammoth = mammothModule.default ?? mammothModule;
          const { value: html, messages } = await mammoth.convertToHtml({ buffer: bytes });
          return reply.type("text/html; charset=utf-8").send(
            wrapPreview(
              filename,
              html,
              messages.map((m) => m.message),
            ),
          );
        }

        // Spreadsheet family → HTML tables via SheetJS.
        if (isSpreadsheetPreviewFormat(mime, filename)) {
          const XLSX = await import("xlsx");
          const wb = XLSX.read(bytes, {
            type: "buffer",
            cellDates: true,
            cellFormula: true,
            cellNF: true,
            sheetStubs: true,
          });
          const tables: string[] = [];
          for (const sheetName of wb.SheetNames) {
            const sheet = wb.Sheets[sheetName];
            const rows: string[] = [];
            const range = typeof sheet?.["!ref"] === "string" ? sheet["!ref"] : undefined;
            if (sheet !== undefined && range !== undefined) {
              const decoded = XLSX.utils.decode_range(range);
              for (let rowIndex = decoded.s.r; rowIndex <= decoded.e.r; rowIndex += 1) {
                const cells: string[] = [];
                for (let colIndex = decoded.s.c; colIndex <= decoded.e.c; colIndex += 1) {
                  const address = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
                  const cell = sheet[address] as SheetJsPreviewCell | undefined;
                  cells.push(`<td>${escapeHtml(sheetJsPreviewCellText(cell))}</td>`);
                }
                rows.push(`<tr>${cells.join("")}</tr>`);
              }
            }
            tables.push(`<h2>${escapeHtml(sheetName)}</h2><table>${rows.join("")}</table>`);
          }
          return reply
            .type("text/html; charset=utf-8")
            .send(wrapPreview(filename, tables.join("\n"), []));
        }

        // PPTX / OOXML presentation family → first-pass text slide cards.
        if (isPresentationPreviewFormat(mime, filename)) {
          try {
            const { importPptxDeck } = await import("./platform/slides/import-pptx.js");
            const deck = await importPptxDeck({ filename, content: bytes });
            return await reply
              .type("text/html; charset=utf-8")
              .send(wrapPreview(filename, renderPptxPreviewSlides(deck.slides), []));
          } catch (error) {
            return reply
              .type("text/html; charset=utf-8")
              .send(
                wrapPreview(
                  filename,
                  `<div class="placeholder"><p>This presentation preview could not be rendered.</p><p>${escapeHtml(error instanceof Error ? error.message : "Unknown preview error.")}</p><p><a class="dl" href="${rawUrl}?download=1">Download to open in a native app</a></p></div>`,
                  [],
                ),
              );
          }
        }

        // Unsupported (legacy PPT/ODS/ZIP/binary blobs): show a friendly placeholder
        // with a Download link so the user can open it in a native app.
        return reply
          .type("text/html; charset=utf-8")
          .send(
            wrapPreview(
              filename,
              `<div class="placeholder"><p>This file (${escapeHtml(mime || "binary")}) doesn't have an in-browser preview yet.</p><p><a class="dl" href="${rawUrl}?download=1">Download to open in a native app</a></p></div>`,
              [],
            ),
          );
      },
    );
  }
  if (coreApps.shouldRegister("meet")) {
    await registerMeetRoutes(app, {
      store: meetStore,
      webhookSecret:
        bootEnv.MEET_JITSI_WEBHOOK_SHARED_SECRET ??
        bootEnv.JITSI_WEBHOOK_SECRET ??
        "helix_dev_jitsi_webhook_secret_change_me",
      defaultOrgId: bootEnv.HELIX_DEFAULT_ORG_ID,
      storageResolver: driveStorageResolver,
      requirePreparedRecordingUpload:
        envFlag("HELIX_JITSI_PREPARE_REQUIRED", false) ||
        envFlag("MEET_JITSI_PREPARE_REQUIRED", false),
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
  leaderGatedWorkers.push({ name: "ai-enrichment-worker", worker: enrichmentWorker });
  if (outboundMailWorker !== undefined) {
    leaderGatedWorkers.push({ name: "outbound-mail-worker", worker: outboundMailWorker });
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
  if (driveUploadScanWorker !== undefined) {
    leaderGatedWorkers.push({
      name: "drive-upload-scan-worker",
      worker: driveUploadScanWorker,
    });
  }
  if (driveLifecycleGcWorker !== undefined) {
    leaderGatedWorkers.push({
      name: "drive-lifecycle-gc-worker",
      worker: driveLifecycleGcWorker,
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
  leaderGatedWorkers.push({ name: "outbox-worker", worker: outboxWorker });
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

  // Connector model: actually load external-connector plugins at startup.
  // The plugin loader / lifecycle machinery was previously built but never
  // invoked against a real plugin. The connector runtime closes that gap: it
  // discovers `/plugins`, keeps `category: "connector"` in-process plugins,
  // imports each, and runs its `register` hook. Core apps are NOT loaded here
  // — they are platform modules wired directly above. Connector load failures
  // are logged and skipped; one bad connector never blocks startup.
  const connectorResult = await loadConnectors({
    pluginsDir:
      bootEnv.HELIX_PLUGINS_DIR ?? fileURLToPath(new URL("../../../plugins", import.meta.url)),
    tierDefaults: tierDefaults[securityTier],
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
      app.log.info({ tier: config.security.tier }, "Applied hot-reloaded platform configuration");
    },
  });

  app.addHook("onClose", async () => {
    // PRD §16.3 steps 4-5: now that the HTTP server has stopped accepting new
    // connections, tell still-connected realtime clients to reconnect to a
    // surviving replica before workers/DB are torn down. Docs (Yjs) sockets
    // get a "host shutting down" frame; chat sockets get "reconnect required".
    try {
      docsRoutes?.broadcastShutdown();
    } catch (error) {
      app.log.error({ error }, "Failed to broadcast docs shutdown");
    }
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

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async () => ({ ok: true }));
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

  const mcpResourceProvider = (request: FastifyRequest) =>
    createStoreBackedMcpResourceProvider({
      chat: chatStore,
      calendar: calendarStore,
      mail: mailStore,
      drive: driveStore,
      docs: docsStore,
      docsExportJobLimiter: tenantHourlyQuotaLimiter,
      docsExportJobLimit: () => request.effectiveConfig?.quotas.export_jobs_per_hour ?? null,
      quotaEvents: eventBus,
      onQuotaEventError: (error: unknown) => {
        app.log.error({ error }, "MCP Docs export quota event emission failed");
      },
      metering: meteringClient,
      onMeteringError: (error: unknown) => {
        app.log.error({ error }, "MCP Docs export metering emission failed");
      },
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
        resources: mcpResourceProvider(request),
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
      resources: mcpResourceProvider(request),
      idempotencyStore,
    });
  });

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

function nativeDocumentLayoutSettingsFromMetadata(metadata: JsonObject):
  | {
      readonly layoutMode: "page" | "pageless";
      readonly columnCount: 1 | 2;
      readonly sections?: readonly {
        readonly id: string;
        readonly title?: string | undefined;
        readonly layoutMode?: "page" | "pageless" | undefined;
        readonly columnCount?: 1 | 2 | undefined;
        readonly pageSize?: "letter" | "a4" | undefined;
        readonly orientation?: "portrait" | "landscape" | undefined;
      }[];
    }
  | undefined {
  const layout = metadata.nativeDocumentLayout;
  if (typeof layout !== "object" || layout === null || Array.isArray(layout)) {
    return undefined;
  }
  const record = layout as Record<string, unknown>;
  const sections = nativeDocumentLayoutSectionsFromMetadata(record.sections);
  return {
    layoutMode: record.layoutMode === "pageless" ? "pageless" : "page",
    columnCount: record.columnCount === 2 ? 2 : 1,
    ...(sections.length === 0 ? {} : { sections }),
  };
}

function nativeDocumentLayoutSectionsFromMetadata(value: unknown): readonly {
  readonly id: string;
  readonly title?: string | undefined;
  readonly layoutMode?: "page" | "pageless" | undefined;
  readonly columnCount?: 1 | 2 | undefined;
  readonly pageSize?: "letter" | "a4" | undefined;
  readonly orientation?: "portrait" | "landscape" | undefined;
}[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const sections: {
    readonly id: string;
    readonly title?: string | undefined;
    readonly layoutMode?: "page" | "pageless" | undefined;
    readonly columnCount?: 1 | 2 | undefined;
    readonly pageSize?: "letter" | "a4" | undefined;
    readonly orientation?: "portrait" | "landscape" | undefined;
  }[] = [];
  for (const item of value.slice(0, 24)) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!/^[A-Za-z0-9_-]{1,120}$/u.test(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const title = typeof record.title === "string" ? record.title.trim().slice(0, 120) : "";
    sections.push({
      id,
      ...(title.length === 0 ? {} : { title }),
      ...(record.layoutMode === "page" || record.layoutMode === "pageless"
        ? { layoutMode: record.layoutMode }
        : {}),
      ...(record.columnCount === 1 || record.columnCount === 2
        ? { columnCount: record.columnCount }
        : {}),
      ...(record.pageSize === "letter" || record.pageSize === "a4"
        ? { pageSize: record.pageSize }
        : {}),
      ...(record.orientation === "portrait" || record.orientation === "landscape"
        ? { orientation: record.orientation }
        : {}),
    });
  }
  return sections;
}

/** True when the client accepts an SSE stream for the MCP transport. */
function acceptsEventStream(request: FastifyRequest): boolean {
  const accept = request.headers.accept;
  const value = Array.isArray(accept) ? accept.join(",") : accept;
  return typeof value === "string" && value.includes("text/event-stream");
}

/**
 * Rewrites a `/v1/...` request URL onto its canonical unprefixed path (P1-10).
 * Returns the URL unchanged when it carries no version prefix.
 */
export function rewriteVersionedApiUrl(rawUrl: string): string {
  const prefix = HELIX_API_VERSION_PREFIX;
  if (rawUrl === prefix) {
    return "/";
  }
  if (rawUrl.startsWith(`${prefix}/`)) {
    return rawUrl.slice(prefix.length) || "/";
  }
  if (rawUrl.startsWith(`${prefix}?`)) {
    return `/${rawUrl.slice(prefix.length)}`;
  }
  return rawUrl;
}

function registerBetterAuthRoutes(
  app: FastifyInstance,
  auth: BetterAuthInstance | undefined,
): void {
  if (auth === undefined) {
    return;
  }

  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    async handler(request, reply) {
      const response = await auth.handler(createBetterAuthRequest(request));
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        reply.header(key, value);
      });
      const body = response.body === null ? null : await response.text();
      return reply.send(body);
    },
  });
}

function createBetterAuthRequest(request: FastifyRequest): Request {
  const host = firstHeader(request.headers.host) ?? "localhost";
  const url = new URL(request.url, `http://${host}`);
  const init: RequestInit = {
    method: request.method,
    headers: fromNodeHeaders(request.headers),
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body !== undefined) {
    init.body = requestBodyForFetch(request.body);
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

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
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

async function createSearchEngine(): Promise<MeilisearchSearchEngine | undefined> {
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
      indexUid: searchEnv.MEILI_INDEX_UID ?? searchEnv.MEILISEARCH_INDEX_UID ?? "helix_search",
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
}

interface BetterAuthServerConfig {
  readonly databaseUrl: string;
  readonly secret: string;
  readonly baseUrl: string;
  readonly trustedOrigins?: readonly string[];
}

export function getBetterAuthRuntimeConfig(
  env: NodeJS.ProcessEnv,
): BetterAuthServerConfig | undefined {
  if (!envValueFlag(env.BETTER_AUTH_ENABLED ?? "true", true)) {
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

  const trustedOrigins = parseTrustedOrigins(env.BETTER_AUTH_TRUSTED_ORIGINS);
  return {
    databaseUrl,
    secret,
    baseUrl:
      env.BETTER_AUTH_URL ?? env.HELIX_PUBLIC_URL ?? env.PUBLIC_BASE_URL ?? "http://localhost:3000",
    ...(trustedOrigins.length === 0 ? {} : { trustedOrigins }),
  };
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

/** @deprecated Prefer mailConfig(loadEnv(...)).outbound — kept for server.test.ts. */
export function getOutboundMailConfig(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  // Delegate through loadEnv-compatible mailConfig when keys match Env;
  // fall back to the historical open-record reader for partial test stubs.
  const host = source.MAIL_SMTP_HOST ?? source.SES_SMTP_HOST;
  if (host === undefined || host.length === 0) {
    return undefined;
  }

  const port = source.MAIL_SMTP_PORT ?? source.SES_SMTP_PORT;
  const secure = source.MAIL_SMTP_SECURE ?? source.SES_SMTP_SECURE;
  const user = source.MAIL_SMTP_USER ?? source.SES_SMTP_USER;
  const pass = source.MAIL_SMTP_PASS ?? source.SES_SMTP_PASS;

  return {
    host,
    ...(port === undefined ? {} : { port: Number.parseInt(port, 10) }),
    ...(secure === undefined ? {} : { secure: envValueFlag(secure, false) }),
    ...(user === undefined ? {} : { user }),
    ...(pass === undefined ? {} : { pass }),
  };
}

/** @deprecated Prefer mailConfig(loadEnv(...)).receiver — kept for server.test.ts. */
export function getSmtpMailReceiverConfig(
  source: NodeJS.ProcessEnv | Record<string, string | undefined>,
): { readonly port: number; readonly host?: string } | undefined {
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
  const minute = 60_000;
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
  const providers: LLMProviderCapability[] = [];
  const aiEnv = env();
  if (aiConfig?.enabled !== false) {
    for (const provider of aiConfig?.providers ?? []) {
      if (provider.enabled === false) {
        continue;
      }
      // Injectable ProcessEnv readers stay on process.env (legacy provider config adapters).
      const configured = createConfiguredAssistantProvider(provider, process.env);
      if (configured !== undefined) {
        providers.push(configured);
      }
    }
  }
  if (aiEnv.OLLAMA_BASE_URL !== undefined) {
    pushProvider(
      providers,
      createOpenAICompatibleProvider({
        id: "ollama.local",
        baseUrl: aiEnv.OLLAMA_BASE_URL,
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
): MemoryEmbeddingProvider {
  if (aiConfig?.enabled === false) {
    return createDeterministicEmbeddingProvider();
  }

  const configured = createConfiguredAssistantEmbeddingProvider(aiConfig, env);
  return configured ?? createDeterministicEmbeddingProvider();
}

export function createSemanticSearchEmbeddingProvider(
  aiConfig: AiConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MemoryEmbeddingProvider | undefined {
  if (aiConfig?.enabled === false || aiConfig?.embeddingProvider === undefined) {
    return undefined;
  }
  return createConfiguredAssistantEmbeddingProvider(aiConfig, env);
}

function createConfiguredAssistantEmbeddingProvider(
  aiConfig: AiConfig | undefined,
  env: NodeJS.ProcessEnv,
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
      primary: { providerId: string; model?: string };
      fallback?: { providerId: string; model?: string };
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

const PREVIEW_CSS = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f6f7f9; color: #111; }
  @media (prefers-color-scheme: dark) {
    body { background: #16171a; color: #e6e7e8; }
    .doc { background: #1f2024; box-shadow: 0 1px 4px rgba(0,0,0,.6); }
    a { color: #8ab4f8; }
    table { border-color: #2a2c30; }
    th, td { border-color: #2a2c30; }
  }
  header { padding: 12px 20px; border-bottom: 1px solid #e0e2e6; background: #fff; position: sticky; top: 0; }
  @media (prefers-color-scheme: dark) { header { background: #1f2024; border-color: #2a2c30; } }
  header h1 { margin: 0; font-size: 14px; font-weight: 600; }
  header small { color: #6b7280; font-size: 12px; }
  main { max-width: 880px; margin: 24px auto; padding: 0 16px 64px; }
  .doc { background: #fff; padding: 48px 56px; border-radius: 6px; line-height: 1.55; font-size: 15px; }
  .doc h1, .doc h2, .doc h3 { line-height: 1.2; }
  .doc h1 { font-size: 26px; margin-top: 0; }
  .doc h2 { font-size: 20px; margin-top: 32px; }
  .doc h3 { font-size: 16px; margin-top: 24px; }
  .doc p { margin: 0 0 12px; }
  .slide-preview { display: grid; gap: 16px; }
  .slide-card { aspect-ratio: 16 / 9; border: 1px solid #dadce0; border-radius: 8px; padding: 24px; background: linear-gradient(135deg, #fff, #f8fafc); overflow: hidden; }
  .slide-card h2 { margin: 0 0 12px; font-size: 22px; line-height: 1.15; }
  .slide-card ul { margin: 0; padding-left: 18px; font-size: 14px; }
  .slide-card li { margin: 0 0 6px; }
  .slide-meta { margin-bottom: 8px; color: #6b7280; font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; margin: 12px 0 24px; }
  th, td { border: 1px solid #dadce0; padding: 4px 8px; vertical-align: top; text-align: left; }
  th { background: #f1f3f4; font-weight: 600; }
  @media (prefers-color-scheme: dark) { th { background: #2a2c30; } }
  .placeholder { text-align: center; padding: 64px 24px; color: #6b7280; }
  .dl { display: inline-block; margin-top: 12px; padding: 8px 16px; border-radius: 4px; background: #1a73e8; color: #fff; text-decoration: none; font-weight: 500; }
  .dl:hover { background: #1762c4; }
  .warnings { font-size: 12px; color: #9ca3af; margin-top: 8px; padding-left: 20px; }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wrap a converted document fragment in the standard preview HTML shell:
 *  sticky header with the filename, scrollable body with the doc, a tiny
 *  list of conversion warnings (if any). Used by all in-browser preview
 *  paths so DOCX/XLSX/PPTX/placeholder previews share consistent chrome. */
function wrapPreview(filename: string, body: string, warnings: readonly string[]): string {
  const safeName = escapeHtml(filename);
  const warningList =
    warnings.length === 0
      ? ""
      : `<ul class="warnings">${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeName}</title>
<style>${PREVIEW_CSS}</style>
</head>
<body>
  <header><h1>${safeName}</h1><small>Helix Drive preview</small></header>
  <main><div class="doc">${body}</div>${warningList}</main>
</body>
</html>`;
}

interface SheetJsPreviewCell {
  readonly t?: string;
  readonly v?: unknown;
  readonly f?: string;
  readonly w?: string;
}

function isSpreadsheetPreviewFormat(mime: string, filename: string): boolean {
  const normalizedMime = mime.toLowerCase();
  const normalizedName = filename.toLowerCase();
  return (
    normalizedMime.includes("spreadsheetml") ||
    normalizedMime === "application/vnd.ms-excel" ||
    normalizedMime === "application/vnd.oasis.opendocument.spreadsheet" ||
    /\.(xlsx|xlsm|xltx|xltm|xls|xlsb|ods)$/iu.test(normalizedName)
  );
}

function isPresentationPreviewFormat(mime: string, filename: string): boolean {
  const normalizedMime = mime.toLowerCase();
  const normalizedName = filename.toLowerCase();
  return (
    normalizedMime.includes("presentationml") ||
    /\.(pptx|pptm|ppsx|ppsm|potx|potm)$/iu.test(normalizedName)
  );
}

function isSvgPreviewFormat(mime: string, filename: string): boolean {
  return mime.toLowerCase() === "image/svg+xml" || filename.toLowerCase().endsWith(".svg");
}

function isAvailablePdfPreview(preview: DrivePreview | undefined): boolean {
  return preview?.kind === "pdf" && preview.status === "available";
}

function previewPdfFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/u, "") + ".pdf";
}

function previewPdfAsciiFilename(filename: string): string {
  return previewPdfFilename(filename)
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/"/g, '\\"');
}

const maxSvgPreviewBytes = 2_000_000;
const maxRasterPreviewBytes = 25_000_000;
let svgRasterizerBrowserPromise: Promise<Browser> | null = null;
let avifDecoderInitPromise: Promise<void> | null = null;

interface AvifDecodeModule {
  readonly default: (data: ArrayBuffer) => Promise<DecodedAvifPreview>;
  readonly init: (module?: object) => Promise<void> | void;
}

interface DecodedAvifPreview {
  readonly data: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

interface WasmCompiler {
  readonly compile: (bytes: Uint8Array | ArrayBuffer) => Promise<object>;
}

function sendPngPreview(reply: FastifyReply, filename: string, png: Buffer): FastifyReply {
  return reply
    .header(
      "content-disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(imagePreviewFilename(filename))}`,
    )
    .header("content-length", String(png.byteLength))
    .type("image/png")
    .send(png);
}

function imagePreviewFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/u, "") + ".png";
}

function isBrowserSafeRasterImagePreviewFormat(mime: string, filename: string): boolean {
  const normalizedMime = mime.toLowerCase();
  const normalizedName = filename.toLowerCase();
  return (
    normalizedMime === "image/png" ||
    normalizedMime === "image/jpeg" ||
    normalizedMime === "image/gif" ||
    normalizedMime === "image/webp" ||
    /\.(png|jpe?g|gif|webp)$/iu.test(normalizedName)
  );
}

function isGeneratedRasterImagePreviewFormat(mime: string, filename: string): boolean {
  const normalizedMime = mime.toLowerCase();
  const normalizedName = filename.toLowerCase();
  if (
    normalizedMime.startsWith("image/") &&
    !isBrowserSafeRasterImagePreviewFormat(mime, filename)
  ) {
    return true;
  }
  return /\.(avif|bmp|dib|heic|heif|tif|tiff|psd|jp2|j2k|jpf|jpx|jpm|jxl)$/iu.test(normalizedName);
}

async function rasterizeImagePreviewToPng(
  imageBytes: Buffer,
  mime: string,
  filename: string,
): Promise<Buffer | null> {
  if (imageBytes.byteLength === 0 || imageBytes.byteLength > maxRasterPreviewBytes) {
    return null;
  }
  if (isAvifPreviewFormat(mime, filename)) {
    const avifPreview = await rasterizeAvifPreviewToPng(imageBytes);
    if (avifPreview !== null) {
      return avifPreview;
    }
  }
  const sharpPreview = await rasterizeImagePreviewWithSharp(imageBytes);
  if (sharpPreview !== null) {
    return sharpPreview;
  }
  const browserPreview = await rasterizeBrowserImagePreviewToPng(imageBytes, mime);
  if (browserPreview !== null) {
    return browserPreview;
  }
  return rasterizeImagePreviewWithSips(imageBytes, filename);
}

function isAvifPreviewFormat(mime: string, filename: string): boolean {
  return mime.toLowerCase() === "image/avif" || filename.toLowerCase().endsWith(".avif");
}

async function rasterizeAvifPreviewToPng(imageBytes: Buffer): Promise<Buffer | null> {
  try {
    const [avifModule, sharp] = await Promise.all([
      import("@jsquash/avif/decode.js").then(async (module): Promise<AvifDecodeModule> => {
        const typedModule = module as unknown as AvifDecodeModule;
        await initAvifDecoder(typedModule.init);
        return typedModule;
      }),
      import("sharp").then((module) => module.default),
    ]);
    const input = imageBytes.buffer.slice(
      imageBytes.byteOffset,
      imageBytes.byteOffset + imageBytes.byteLength,
    ) as ArrayBuffer;
    const decoded = await avifModule.default(input);
    return await sharp(
      Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.byteLength),
      {
        raw: { width: decoded.width, height: decoded.height, channels: 4 },
        failOn: "none",
        limitInputPixels: 50_000_000,
      },
    )
      .resize({
        width: 512,
        height: 512,
        fit: "inside",
        withoutEnlargement: true,
        background: { r: 255, g: 255, b: 255, alpha: 1 },
      })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

async function initAvifDecoder(init: (module?: object) => Promise<void> | void): Promise<void> {
  avifDecoderInitPromise ??= (async () => {
    const wasmPath = fileURLToPath(import.meta.resolve("@jsquash/avif/codec/dec/avif_dec.wasm"));
    const wasmRuntime = (globalThis as typeof globalThis & { readonly WebAssembly: WasmCompiler })
      .WebAssembly;
    const module = await wasmRuntime.compile(await readFile(wasmPath));
    await init(module);
  })().catch((error: unknown) => {
    avifDecoderInitPromise = null;
    throw error;
  });
  await avifDecoderInitPromise;
}

async function rasterizeImagePreviewWithSharp(imageBytes: Buffer): Promise<Buffer | null> {
  try {
    const sharp = (await import("sharp")).default;
    return await normalizePngPreview(
      await sharp(imageBytes, {
        animated: false,
        failOn: "none",
        limitInputPixels: 50_000_000,
      })
        .png()
        .toBuffer(),
    );
  } catch {
    return null;
  }
}

async function normalizePngPreview(imageBytes: Buffer): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  return sharp(imageBytes, {
    animated: false,
    failOn: "none",
    limitInputPixels: 50_000_000,
  })
    .rotate()
    .resize({
      width: 512,
      height: 512,
      fit: "inside",
      withoutEnlargement: true,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .png()
    .toBuffer();
}

async function rasterizeBrowserImagePreviewToPng(
  imageBytes: Buffer,
  mime: string,
): Promise<Buffer | null> {
  let browser: Browser;
  try {
    browser = await svgRasterizerBrowser();
  } catch {
    return null;
  }

  const page = await browser.newPage({
    viewport: { width: 512, height: 512 },
    deviceScaleFactor: 1,
  });
  try {
    const source = `data:${mime || "image/*"};base64,${imageBytes.toString("base64")}`;
    await page.setContent(
      `<!doctype html><html><head><style>
        html, body { width: 512px; height: 512px; margin: 0; background: #fff; }
        body { display: grid; place-items: center; overflow: hidden; }
        img { max-width: 512px; max-height: 512px; width: auto; height: auto; display: block; }
      </style></head><body><img id="preview" alt="" src="${source}"></body></html>`,
      { waitUntil: "load" },
    );
    await page.waitForFunction("document.getElementById('preview')?.naturalWidth > 0", null, {
      timeout: 3_000,
    });
    return await page.locator("#preview").screenshot({ type: "png" });
  } catch {
    return null;
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function rasterizeImagePreviewWithSips(
  imageBytes: Buffer,
  filename: string,
): Promise<Buffer | null> {
  const directory = await mkdtemp(join(tmpdir(), "helix-image-preview-"));
  try {
    const sourcePath = join(directory, `source${previewSourceExtension(filename)}`);
    const outputPath = join(directory, "preview.png");
    await writeFile(sourcePath, imageBytes);
    await execFileAsync("sips", ["-s", "format", "png", sourcePath, "--out", outputPath], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return await normalizePngPreview(await readFile(outputPath));
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

function previewSourceExtension(filename: string): string {
  const match = /\.[a-z0-9]{1,12}$/iu.exec(filename);
  return match?.[0] ?? ".image";
}

async function rasterizeSvgPreviewToPng(svgBytes: Buffer): Promise<Buffer | null> {
  if (svgBytes.byteLength === 0 || svgBytes.byteLength > maxSvgPreviewBytes) {
    return null;
  }
  let browser: Browser;
  try {
    browser = await svgRasterizerBrowser();
  } catch {
    return null;
  }

  const page = await browser.newPage({
    viewport: { width: 512, height: 512 },
    deviceScaleFactor: 1,
  });
  try {
    const source = `data:image/svg+xml;base64,${svgBytes.toString("base64")}`;
    await page.setContent(
      `<!doctype html><html><head><style>
        html, body { width: 512px; height: 512px; margin: 0; background: #fff; }
        body { display: grid; place-items: center; overflow: hidden; }
        img { max-width: 512px; max-height: 512px; width: auto; height: auto; display: block; }
      </style></head><body><img id="preview" alt="" src="${source}"></body></html>`,
      { waitUntil: "load" },
    );
    await page.waitForFunction("document.getElementById('preview')?.complete === true");
    return await page.locator("#preview").screenshot({ type: "png" });
  } catch {
    return null;
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function svgRasterizerBrowser(): Promise<Browser> {
  svgRasterizerBrowserPromise ??= import("playwright")
    .then(({ chromium }) =>
      chromium.launch({
        headless: true,
        args: ["--disable-web-security", "--no-sandbox"],
      }),
    )
    .catch((error: unknown) => {
      svgRasterizerBrowserPromise = null;
      throw error;
    });
  return svgRasterizerBrowserPromise;
}

function renderPptxPreviewSlides(
  slides: readonly { readonly content: SlidePreviewContent }[],
): string {
  const cards = slides
    .slice(0, 12)
    .map((slide, index) => {
      const body = slidePreviewBody(slide.content);
      return `<section class="slide-card"><div class="slide-meta">Slide ${String(index + 1)}</div><h2>${escapeHtml(slide.content.title)}</h2>${body}</section>`;
    })
    .join("");
  return `<div class="slide-preview">${cards}</div>`;
}

interface SlidePreviewContent {
  readonly layout: string;
  readonly title: string;
  readonly items?: readonly string[];
  readonly subtitle?: string;
  readonly note?: string;
}

function slidePreviewBody(content: SlidePreviewContent): string {
  const items = content.items ?? [];
  if (items.length > 0) {
    return `<ul>${items
      .slice(0, 12)
      .map((item) => `<li>${escapeHtml(item)}</li>`)
      .join("")}</ul>`;
  }
  const subtitle = typeof content.subtitle === "string" ? content.subtitle.trim() : "";
  if (subtitle.length > 0) {
    return `<p>${escapeHtml(subtitle)}</p>`;
  }
  const note = typeof content.note === "string" ? content.note.trim() : "";
  if (note.length > 0) {
    return `<p>${escapeHtml(note)}</p>`;
  }
  return "";
}

function sheetJsPreviewCellText(cell: SheetJsPreviewCell | undefined): string {
  if (cell === undefined) {
    return "";
  }
  if (typeof cell.f === "string" && cell.f.length > 0) {
    return `=${cell.f}`;
  }
  if (cell.v instanceof Date) {
    return cell.v.toISOString();
  }
  if (
    typeof cell.v === "string" ||
    typeof cell.v === "number" ||
    typeof cell.v === "boolean" ||
    typeof cell.v === "bigint"
  ) {
    return String(cell.v);
  }
  if (cell.t === "e" && typeof cell.w === "string") {
    return cell.w;
  }
  return "";
}
