import { fileURLToPath } from "node:url";
import type { IncomingMessage } from "node:http";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import websocket from "@fastify/websocket";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { fromNodeHeaders } from "better-auth/node";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { z } from "zod";
import {
  actorFromRequestWithAccessTokenAndSession,
  resolveCredentialAuthenticatedActor,
  systemActor,
  type SessionActorResolver,
} from "./api/actor.js";
import { buildAsyncApiDocument } from "./api/asyncapi.js";
import {
  formatSseEvent,
  handleMcpJsonRpcRequest,
  handleMcpStreamingRequest,
} from "./api/mcp.js";
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
  fingerprintRequestPayload,
  idempotencyStorageKey,
  resolveIdempotency,
  type IdempotencyStore,
} from "./api/idempotency.js";
import { projectToolListItem } from "./api/tool-projection.js";
import { createResourceClassifier } from "./api/classify-resource.js";
import { createHelixTRPCRouter } from "./api/trpc.js";
import { createSqlClient } from "./db/client.js";
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
import {
  PostgresScimUserStore,
  registerTenantScimRoutes,
} from "./platform/auth/scim-routes.js";
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
  PostgresAdminUsersStore,
  registerAdminUsersRoutes,
  registerPeopleDirectoryRoutes,
} from "./platform/auth/admin-users.js";
import {
  createBetterAuthPlatformModule,
  createBetterAuthRuntime,
  createBetterAuthSessionActorResolver,
  PostgresBetterAuthActorStore,
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
  PostgresChatStore,
  RedisChatPresenceStore,
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
  createLibreOfficePreviewClient,
  PostgresDriveStore,
  readInlineBodyFallback,
  registerDriveEnrichments,
  registerDriveIndexer,
  registerDriveRoutes,
  registerDriveTools,
} from "./platform/drive/index.js";
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
  getClamavScannerConfig,
  getSpamdScannerConfig,
  NodemailerMailTransport,
  OutboundMailDispatcher,
  OutboundMailWorker,
  PostgresMailStore,
  PostgresMailDkimKeyStore,
  PostgresMailDmarcReportStore,
  PostgresMailRoutingRuleStore,
  PostgresOutboundProviderStore,
  PostgresSendingDomainStore,
  MailAdminStatusService,
  registerMailAdminRoutes,
  registerMailDeliveryAdminRoutes,
  registerMailEnrichments,
  registerMailIndexer,
  registerMailTools,
  resolveOutboundTransport,
  SmtpMailReceiver,
  SpamdScanner,
  type SmtpReceiverOptions,
} from "./platform/mail/index.js";
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
  PostgresSheetsStore,
  registerSheets,
  registerSheetsRoutes,
} from "./platform/sheets/index.js";
import {
  PostgresSlidesStore,
  registerSlides,
  registerSlidesRoutes,
} from "./platform/slides/index.js";
import {
  PostgresGroupsStore,
  registerAdminGroupsRoutes,
} from "./platform/admin/groups.js";
import {
  PostgresSecurityPoliciesStore,
  registerAdminSecurityPoliciesRoutes,
} from "./platform/admin/security-policies.js";
import {
  PostgresOAuthAppsStore,
  registerAdminOAuthAppsRoutes,
} from "./platform/admin/oauth-apps.js";
import { registerTenantConfigAdminRoutes } from "./platform/admin/tenant-config.js";
import {
  PostgresBillingStore,
  registerAdminBillingRoutes,
} from "./platform/admin/billing.js";
import {
  PostgresDomainsStore,
  registerAdminDomainsRoutes,
} from "./platform/admin/domains.js";
import { OutboxWorker } from "./platform/outbox/outbox.js";
import { PostgresOutboxStore } from "./platform/outbox/postgres-store.js";
import { registerPluginAdminRoutes } from "./platform/plugins/admin-routes.js";
import { PostgresPluginLifecycleStore, registerPluginTools } from "./platform/plugins/tools.js";
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
import { CoreAppRegistrationPlan } from "./platform/apps/core-apps.js";
import { registerCoreAppsAdminRoutes } from "./platform/apps/admin-routes.js";
import {
  createPostgresTenantExportManifestPlanner,
  PostgresTenantExportJobStore,
  PostgresOrgStore,
  PostgresPlanStore,
  registerTenantExportRoutes,
  TenantExportMaterializationWorker,
} from "./platform/tenancy/index.js";
import { loadConnectors, registerConnectorsAdminRoute } from "./platform/connectors/index.js";
import {
  evaluateAdminMfa,
  headerMfaVerificationResolver,
  type MfaVerificationResolver,
} from "./platform/auth/mfa.js";
import {
  InMemoryAgentRateCostLimiter,
  RedisAgentRateCostLimiter,
  type AgentLimitBudget,
} from "./platform/limits/index.js";
import {
  CerbosToolAccessPolicy,
  ObservedToolAccessPolicy,
  ScopeToolAccessPolicy,
} from "./platform/permissions/tool-access.js";
import {
  createDefaultTenantStorageResolver,
  createS3CompatibleStorage,
  createTenantStorageMigrationPairResolver,
  createTenantStorageMigrationWriteCoordinator,
  createTenantStorageResolver,
  ByoStorageHealthWorker,
  PostgresTenantStorageMigrationJobStore,
  resolveTenantStorageSnapshot,
  TenantStorageMigrationWorker,
} from "./platform/storage/index.js";
import { createVaultTenantStorageSecretStoreFromEnv } from "./platform/secrets/index.js";
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
import type { AgentCredentialStore } from "./platform/auth/credentials.js";
import type {
  AiConfig,
  AiProviderConfig,
  ChatRequest,
  ChatResponse,
  JsonObject,
  LLMProviderCapability,
  ModelInfo,
  SecurityTier,
} from "@helix/sdk-types";

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
async function resolveRequestActor(
  request: FastifyRequest,
  tokenStore: AccessTokenStore,
  sessionResolver: SessionActorResolver | undefined,
  credentialStore: AgentCredentialStore | undefined,
) {
  if (credentialStore !== undefined) {
    const credentialResolution = await resolveCredentialAuthenticatedActor(
      request,
      credentialStore,
    );
    if (credentialResolution !== null) {
      if (!credentialResolution.ok) {
        throw new CredentialAuthError(
          credentialResolution.statusCode,
          credentialResolution.code,
          credentialResolution.message,
        );
      }
      return credentialResolution.actor;
    }
  }
  return actorFromRequestWithAccessTokenAndSession(request, tokenStore, sessionResolver);
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
              const actor = await resolveRequestActor(
                request,
                options.tokenStore,
                options.sessionResolver,
                options.credentialStore,
              );
              return {
                store: idempotencyStore,
                key: idempotencyStorageKey({
                  orgId: actor.orgId,
                  actorId: actor.id,
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
              message:
                "Idempotency-Key was already used with a different request payload.",
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
            return reply
              .code(202)
              .send({ status: replayed.status, pending: replayed.pending });
          }
          return reply.code(outcome.record.statusCode).send(replayed.output);
        }
      }

      const result = await invokeTool(
        options.tools,
        options.tokenStore,
        options.sessionResolver,
        options.credentialStore,
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
        options.tokenStore,
        options.sessionResolver,
        options.credentialStore,
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
    const result = await options.tools.getPendingAction(params.pendingId, {
      actor: await resolveRequestActor(
        request,
        options.tokenStore,
        options.sessionResolver,
        options.credentialStore,
      ),
    });
    if (!result.ok) {
      return sendToolInvokeError(reply, result, traceIdForRequest(request));
    }
    return { action: result.pending };
  };

  app.get("/actions/:pendingId", actionStatusHandler);
  app.get("/api/actions/:pendingId", actionStatusHandler);
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
        options.tokenStore,
        options.sessionResolver,
        options.credentialStore,
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
    const actor = await resolveRequestActor(
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
        actor,
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
  | { readonly type: "error"; readonly message: string };

/** Serializes an assistant SSE frame to the `text/event-stream` wire format. */
export function formatAssistantSseEvent(event: AssistantSseFrame): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function createHelixServer(): Promise<FastifyInstance> {
  const app = fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "password", "secret", "token"],
    },
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
    bodyLimit: Number.parseInt(process.env.HELIX_BODY_LIMIT_BYTES ?? "134217728", 10),
    // The OnlyOffice integration carries a signed JWT in the URL path
    // (`/api/onlyoffice/file/<token>`). JWTs routinely run 300-500 chars
    // and the Fastify default `maxParamLength` is 100 — anything longer
    // silently 404s instead of reaching the handler. 2 KB is the URL
    // segment ceiling most reverse proxies tolerate, well above any JWT
    // we'd realistically issue.
    maxParamLength: 2048,
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
  // envelope rather than a generic 500.
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof CredentialAuthError) {
      const traceId = traceIdForRequest(request);
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
  // P1-10: process-local idempotency store for mutating tool calls.
  const idempotencyStore: IdempotencyStore = new InMemoryIdempotencyStore();
  const sql = createSqlClient();
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
  const betterAuthPlatform = createBetterAuthPlatformModule({
    actorStore: new PostgresBetterAuthActorStore(sql),
    userLinkStore: new PostgresBetterAuthUserLinkStore(sql),
    defaultOrgId: process.env.HELIX_DEFAULT_ORG_ID ?? "00000000-0000-0000-0000-000000000000",
  });
  const sessionActorResolver: SessionActorResolver | undefined =
    betterAuthRuntime === undefined
      ? undefined
      : {
          resolve: createBetterAuthSessionActorResolver(
            betterAuthPlatform,
            betterAuthRuntime.sessionVerifier,
          ),
        };
  // PRD §9.2: resolve the request actor, trying API-key / mTLS credential
  // authentication first so the per-credential policy (IP allowlist,
  // allowed-hours, expiry, revocation) is enforced on every authenticated
  // surface. A presented-but-rejected credential raises `CredentialAuthError`,
  // which the error handler maps to the appropriate 401/403 response. When no
  // credential is presented, falls back to bearer access tokens and sessions.
  const actorFromAuthenticatedRequest = async (request: FastifyRequest) => {
    const credentialResolution = await resolveCredentialAuthenticatedActor(
      request,
      agentCredentialStore,
    );
    if (credentialResolution !== null) {
      if (!credentialResolution.ok) {
        throw new CredentialAuthError(
          credentialResolution.statusCode,
          credentialResolution.code,
          credentialResolution.message,
        );
      }
      return credentialResolution.actor;
    }
    return actorFromRequestWithAccessTokenAndSession(request, oauthStore, sessionActorResolver);
  };
  const appPasswordStore = new PostgresAppPasswordStore(sql);
  const adminUsersStore = new PostgresAdminUsersStore(sql);
  const scimUserStore = new PostgresScimUserStore(sql);
  const groupsStore = new PostgresGroupsStore(sql);
  const orgStore = new PostgresOrgStore(sql);
  const planStore = new PostgresPlanStore(sql);
  const tenantIdpConfigStore = new PostgresTenantIdpConfigStore(sql);
  const auditStore = new PostgresAuditStore(sql, {
    onAppend: (record) => {
      metrics.recordAuditActivity({ verb: record.verb, objectType: record.objectType });
    },
  });
  const webhookStore = new PostgresWebhookStore(sql);
  const chatStore = new PostgresChatStore(sql);
  const docsPdfRenderTimeoutMs = Number.parseInt(
    process.env.HELIX_DOCS_PDF_RENDER_TIMEOUT_MS ?? "15000",
    10,
  );
  const docsPdfRenderer =
    process.env.HELIX_DOCS_PDF_RENDERER === "deterministic"
      ? undefined
      : createHeadlessChromiumPdfRenderer({
          ...(process.env.HELIX_CHROMIUM_PATH === undefined
            ? {}
            : { executablePath: process.env.HELIX_CHROMIUM_PATH }),
          timeoutMs: Number.isFinite(docsPdfRenderTimeoutMs) ? docsPdfRenderTimeoutMs : 15_000,
        });
  const calendarStore = new PostgresCalendarStore(sql);
  const cardDavContactStore = new PostgresCardDavContactStore(sql);
  const meetStore = new PostgresMeetStore(sql);
  const assistantStore = new PostgresAssistantStore(sql);
  const outboxStore = new PostgresOutboxStore(sql);
  const pluginLifecycleStore = new PostgresPluginLifecycleStore(sql);
  const eventBus =
    process.env.NATS_URL === undefined
      ? new InMemoryEventBus({
          onError: (error) => {
            app.log.error({ error }, "In-memory event bus subscriber error");
          },
        })
      : await NatsEventBus.connect({ servers: process.env.NATS_URL }, { subjectPrefix: "helix" });
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
    ...(process.env.HELIX_ROLE === undefined ? {} : { role: process.env.HELIX_ROLE }),
    ...(process.env.HELIX_APPS === undefined ? {} : { apps: process.env.HELIX_APPS }),
  });
  app.log.info(
    {
      role: coreApps.role,
      registeredApps: coreApps.registeredAppIds(),
    },
    "Resolved core-app registration plan",
  );

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
  const mfaResolver: MfaVerificationResolver = headerMfaVerificationResolver;
  // P0-7: durable AI cost limiting. Backed by Redis when available so budgets
  // survive restarts and are shared across replicas; the in-memory limiter
  // remains the single-process fallback.
  const redis = process.env.REDIS_URL === undefined ? undefined : new Redis(process.env.REDIS_URL);
  const aiCostLimiter: AICostLimiter =
    redis === undefined
      ? new InMemoryAICostLimiter()
      : new RedisAICostLimiter(ioredisAICostClient(redis));
  // Per-user AI cost limit overrides (TASK-217 "limit" half). The admin API
  // and UI read/write these; tier defaults apply when no override exists.
  const aiCostLimitStore: AICostLimitStore = new PostgresAICostLimitStore(sql);
  const assistantAi = createAssistantAIRouter(aiProvenance, {
    costLimiter: aiCostLimiter,
    metrics,
    securityTier,
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
  const driveStorage =
    process.env.RUSTFS_ENDPOINT === undefined
      ? undefined
      : createS3CompatibleStorage({
          endpoint: process.env.RUSTFS_ENDPOINT,
          region: process.env.RUSTFS_REGION ?? "us-east-1",
          bucket: process.env.RUSTFS_BUCKET ?? "helix-objects",
          credentials: {
            accessKeyId: process.env.RUSTFS_ACCESS_KEY ?? "helixrustfs",
            secretAccessKey: process.env.RUSTFS_SECRET_KEY ?? "helix_rustfs_dev_secret",
          },
          ...(process.env.RUSTFS_SERVER_SIDE_ENCRYPTION === undefined
            ? {}
            : {
                serverSideEncryption: parseS3ServerSideEncryption(
                  process.env.RUSTFS_SERVER_SIDE_ENCRYPTION,
                ),
              }),
          forcePathStyle: true,
        });
  const tenantStorageSecretStore = createVaultTenantStorageSecretStoreFromEnv(process.env);
  const tenantStorageMigrationJobStore = new PostgresTenantStorageMigrationJobStore(sql);
  const tenantExportJobStore = new PostgresTenantExportJobStore(sql);
  const driveStorageResolver = createTenantStorageResolver({
    defaultClient: driveStorage,
    loadByoConfig: async (orgId: string) => (await orgStore.findById(orgId))?.byoConfig,
    ...(tenantStorageSecretStore === undefined ? {} : { secretReader: tenantStorageSecretStore }),
    migrationWriteCoordinator: createTenantStorageMigrationWriteCoordinator({
      store: tenantStorageMigrationJobStore,
      snapshotStorageResolver: ({ orgId, state }) =>
        resolveTenantStorageSnapshot({
          orgId,
          state,
          defaultClient: driveStorage,
          ...(tenantStorageSecretStore === undefined
            ? {}
            : { secretReader: tenantStorageSecretStore }),
        }),
    }),
  });
  const helixDefaultStorageResolver = createDefaultTenantStorageResolver(driveStorage);
  const tenantExportManifestPlanner = createPostgresTenantExportManifestPlanner(sql);
  const docsStore = new PostgresDocsStore(sql, {
    storageResolver: driveStorageResolver,
  });
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
              ...(tenantStorageSecretStore === undefined
                ? {}
                : { secretReader: tenantStorageSecretStore }),
            }),
        }),
        intervalMs: envPositiveInt("HELIX_TENANT_STORAGE_MIGRATION_INTERVAL_MS", 15_000),
        batchSize: envPositiveInt("HELIX_TENANT_STORAGE_MIGRATION_BATCH_SIZE", 2),
        stalledAfterMs: envPositiveInt(
          "HELIX_TENANT_STORAGE_MIGRATION_STALLED_AFTER_MS",
          30 * 60_000,
        ),
        metrics,
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
  const tenantExportWorker = envFlag("HELIX_TENANT_EXPORT_WORKER_ENABLED", false)
    ? new TenantExportMaterializationWorker({
        store: tenantExportJobStore,
        orgs: orgStore,
        exportPlanner: tenantExportManifestPlanner,
        storageResolver: driveStorageResolver,
        intervalMs: envPositiveInt("HELIX_TENANT_EXPORT_INTERVAL_MS", 15_000),
        batchSize: envPositiveInt("HELIX_TENANT_EXPORT_BATCH_SIZE", 2),
        onResult: (result) => {
          if (result.claimed > 0) {
            app.log.info(result, "Tenant export worker completed");
          }
        },
        onError: (error) => {
          app.log.error({ error }, "Tenant export worker error");
        },
      })
    : undefined;
  const byoStorageHealthWorker = envFlag("HELIX_BYO_STORAGE_HEALTH_WORKER_ENABLED", true)
    ? new ByoStorageHealthWorker({
        store: orgStore,
        storageResolver: driveStorageResolver,
        intervalMs: envPositiveInt("HELIX_BYO_STORAGE_HEALTH_INTERVAL_MS", 60 * 60_000),
        batchSize: envPositiveInt("HELIX_BYO_STORAGE_HEALTH_BATCH_SIZE", 100),
        onResult: (result) => {
          if (result.checkedCount > 0) {
            app.log.info(result, "BYO storage health worker completed");
          }
        },
        onError: (error) => {
          app.log.error({ error }, "BYO storage health worker error");
        },
      })
    : undefined;
  const mailStore = new PostgresMailStore(sql, {
    storageResolver: driveStorageResolver,
  });
  const officePreviewConverter =
    process.env.HELIX_DRIVE_OFFICE_PREVIEW_URL === undefined
      ? undefined
      : createLibreOfficePreviewClient({
          endpoint: process.env.HELIX_DRIVE_OFFICE_PREVIEW_URL,
        });
  const driveStore = new PostgresDriveStore(sql, driveStorage, {
    ...(officePreviewConverter === undefined ? {} : { officePreviewConverter }),
    storageResolver: driveStorageResolver,
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
          subject: process.env.SEARCH_EVENT_SUBJECT ?? ">",
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
    subject: process.env.ENRICHMENT_EVENT_SUBJECT ?? ">",
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
      autoTag: envFlag("DRIVE_AUTO_TAG_ENRICHMENT", true),
    });
  }
  const outboxWorker = new OutboxWorker({
    store: outboxStore,
    events: eventBus,
    batchSize: Number.parseInt(process.env.OUTBOX_BATCH_SIZE ?? "100", 10),
    intervalMs: Number.parseInt(process.env.OUTBOX_POLL_INTERVAL_MS ?? "1000", 10),
    onError: (error) => {
      app.log.error({ error }, "Outbox worker error");
    },
  });
  // Mail background workers run only when the mail app is registered in this
  // process (enabled org-wide AND in the booting role's app set).
  const mailAppRegistered = coreApps.shouldRegister("mail");
  const outboundMailConfig = mailAppRegistered ? getOutboundMailConfig(process.env) : undefined;
  // Resolve the org's configured outbound provider (SES/Mailgun/SMTP/Postmark)
  // when one is set; otherwise fall back to the env-configured SMTP relay.
  const outboundMailOrgId =
    process.env.HELIX_DEFAULT_ORG_ID ?? "00000000-0000-0000-0000-000000000000";
  const outboundMailTransport =
    outboundMailConfig === undefined
      ? undefined
      : await resolveOutboundTransport({
          orgId: outboundMailOrgId,
          providerStore: new PostgresOutboundProviderStore(sql),
          fallbackTransport: new NodemailerMailTransport(outboundMailConfig),
        });
  const outboundMailWorker =
    outboundMailTransport === undefined
      ? undefined
      : new OutboundMailWorker({
          events: eventBus,
          dispatcher: new OutboundMailDispatcher(mailStore, outboundMailTransport),
          onError: (error) => {
            app.log.error({ error }, "Outbound mail dispatch error");
          },
        });
  const smtpMailReceiverConfig = mailAppRegistered
    ? getSmtpMailReceiverConfig(process.env)
    : undefined;
  // Config-gated inbound content scanners: spamd (SpamAssassin) and ClamAV.
  const spamdScannerConfig = getSpamdScannerConfig(process.env);
  const clamavScannerConfig = getClamavScannerConfig(process.env);
  const smtpMailReceiver =
    smtpMailReceiverConfig === undefined
      ? undefined
      : new SmtpMailReceiver({
          store: mailStore,
          orgId: smtpMailReceiverConfig.orgId,
          logger: app.log,
          scanners: {
            ...(spamdScannerConfig
              ? { spam: new SpamdScanner(spamdScannerConfig) }
              : {}),
            ...(clamavScannerConfig
              ? { antivirus: new ClamavScanner(clamavScannerConfig) }
              : {}),
          },
        });
  const outboundWebhookWorker = new OutboundWebhookWorker({
    store: webhookStore,
    events: eventBus,
    subject: process.env.WEBHOOK_EVENT_SUBJECT ?? ">",
    retryBatchSize: Number.parseInt(process.env.WEBHOOK_RETRY_BATCH_SIZE ?? "100", 10),
    retryIntervalMs: Number.parseInt(process.env.WEBHOOK_RETRY_INTERVAL_MS ?? "1000", 10),
    onError: (error) => {
      app.log.error({ error }, "Outbound webhook worker error");
    },
  });
  const auditVerifierWorker = envFlag("AUDIT_VERIFIER_ENABLED", true)
    ? new AuditVerifierWorker({
        store: auditStore,
        intervalMs: Number.parseInt(process.env.AUDIT_VERIFIER_INTERVAL_MS ?? "86400000", 10),
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
      tenantStorageResolver: driveStorageResolver,
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
          app.log.error(
            { error, destination: config.destination },
            "Audit shipping worker error",
          );
        },
      }),
    };
  });
  const eventSchemas = createEventSchemaRegistry([
    {
      id: "platform.pending_action.created",
      subject: "platform.pending_action.created",
      title: "Pending action created",
      description: "A tool invocation is awaiting confirmation.",
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
  });
  // P0-4(b): leader-gated worker that transitions stale pending_confirmation
  // actions to `expired` once their per-tier timeout elapses.
  const pendingActionExpiryWorker = new PendingActionExpiryWorker({
    store: pendingActionStore,
    intervalMs: Number.parseInt(
      process.env.PENDING_ACTION_EXPIRY_INTERVAL_MS ?? "60000",
      10,
    ),
    batchSize: Number.parseInt(process.env.PENDING_ACTION_EXPIRY_BATCH_SIZE ?? "500", 10),
    onResult: (result) => {
      if (result.expiredCount > 0) {
        app.log.info(
          { expiredCount: result.expiredCount },
          "Expired stale pending tool actions",
        );
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
    process.env.CERBOS_HTTP_URL === undefined
      ? new ObservedToolAccessPolicy(new ScopeToolAccessPolicy(), {
          metrics,
          policyId: "scope",
        })
      : new ObservedToolAccessPolicy(
          new CerbosToolAccessPolicy({ endpoint: process.env.CERBOS_HTTP_URL }),
          {
            metrics,
            policyId: "cerbos",
          },
        );
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
  });
  // P0-6 / PRD §8.4: auto-classify newly created resources. The feature tool
  // create / send / upload handlers call this classifier so mail messages,
  // chat messages, documents, and Drive files are classified and persisted as
  // soon as they are created. The hook is best-effort and never fails the
  // underlying tool call.
  const resourceClassifier = createResourceClassifier(
    resourceClassificationService,
    (error) => {
      app.log.error({ error }, "Resource auto-classification failed");
    },
  );
  registerWebhookTools(tools, { store: webhookStore });
  // Core-app agent tools are contributed per app, conditionally on enablement
  // + role: a disabled app contributes no tools to the registry, so it is
  // absent from REST, tRPC, MCP and the assistant.
  if (coreApps.shouldRegister("mail")) {
    registerMailTools(tools, {
      store: mailStore,
      defaultFromDomain: process.env.MAIL_FROM_DOMAIN ?? "localhost",
      ...(resourceClassifier === undefined ? {} : { classifyResource: resourceClassifier }),
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
      ...(resourceClassifier === undefined ? {} : { classifyResource: resourceClassifier }),
      ...(docsPdfRenderer === undefined ? {} : { pdfRenderer: docsPdfRenderer }),
      onPdfRendererError: (error: unknown) => {
        app.log.warn({ error }, "Docs PDF Chromium renderer failed; using deterministic fallback");
      },
    });
  }
  // Wave-1 backend domains. Sheets and Slides stores are instantiated here so
  // they can be shared with the drive.create tool (unified "New" entry-point)
  // and their own domain tool registrations below.
  const sheetsStore = new PostgresSheetsStore(sql, {
    storageResolver: driveStorageResolver,
  });
  const slidesStore = new PostgresSlidesStore(sql, {
    storageResolver: driveStorageResolver,
  });
  if (coreApps.shouldRegister("drive")) {
    registerDriveTools(tools, {
      store: driveStore,
      ...(resourceClassifier === undefined ? {} : { classifyResource: resourceClassifier }),
      docsStore: docsStore,
      sheetsStore: sheetsStore,
      slidesStore: slidesStore,
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
    });
  }
  const calendarInvitationSender = createMailCalendarInvitationSender({
    store: mailStore,
    defaultFromDomain: process.env.MAIL_FROM_DOMAIN ?? "localhost",
  });
  if (coreApps.shouldRegister("calendar")) {
    registerCalendarTools(tools, {
      store: calendarStore,
      invitationSender: calendarInvitationSender,
      rsvpBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:3000",
    });
  }
  if (coreApps.shouldRegister("meet")) {
    registerMeetTools(tools, {
      store: meetStore,
      jwtSecret:
        process.env.MEET_JITSI_JWT_SECRET ??
        process.env.JITSI_JWT_SECRET ??
        "helix_jitsi_dev_secret",
      jwtAppId: process.env.MEET_JITSI_JWT_APP_ID ?? process.env.JITSI_JWT_APP_ID ?? "helix",
      jwtIssuer: process.env.MEET_JITSI_JWT_ISSUER ?? process.env.JITSI_JWT_ISSUER ?? "helix",
      jwtAudience: process.env.MEET_JITSI_JWT_AUDIENCE ?? "jitsi",
      jwtSubject: process.env.MEET_JITSI_DOMAIN,
      publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:3000",
      // Full Jitsi origin (with port). Without this, joinUrls drop the
      // port and break in dev (Jitsi runs on :28452 via docker compose
      // --profile meet, not on the default :443).
      jitsiPublicUrl: process.env.MEET_JITSI_PUBLIC_URL,
    });
    // Dev-only stand-in for Jibri on hosts where snd-aloop can't be
    // loaded (Docker-for-Mac). Same attachRecording flow.
    registerMockRecorderTools(tools, {
      meetStore,
      storageResolver: driveStorageResolver,
      ...(driveStorage === undefined ? {} : { storage: driveStorage }),
      bucket: process.env.RUSTFS_BUCKET ?? "helix-objects",
    });
  }
  if (runtimeSearchEngine !== undefined) {
    registerSearchTools(tools, { engine: runtimeSearchEngine });
  }
  // Register the Sheets and Slides domain tools using the stores instantiated above.
  registerSheets({
    registry: tools,
    store: sheetsStore,
    ...(resourceClassifier === undefined ? {} : { classifyResource: resourceClassifier }),
  });
  registerSlides(tools, { store: slidesStore, driveStore });
  const assistantOrchestrator = new AssistantOrchestrator({
    store: assistantStore,
    ai: assistantAi,
    tools,
    memory: assistantMemory,
    ...(runtimeSearchEngine === undefined ? {} : { search: runtimeSearchEngine }),
    confirmationGate,
    slashCommands: new AssistantSlashCommandHooks(),
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
      process.env.HELIX_PLUGINS_DIR ?? fileURLToPath(new URL("../../../plugins", import.meta.url)),
    discovery: {
      tierDefaults: tierDefaults[securityTier],
    },
    lifecycleStore: pluginLifecycleStore,
  });
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
    if (!url.startsWith("/api/admin/")) {
      return;
    }
    const actor = await actorFromAuthenticatedRequest(request);
    const decision = evaluateAdminMfa({
      tier: securityTier,
      actor,
      mfaVerified: await mfaResolver.isMfaVerified(request),
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

  await app.register(cors, { origin: true, credentials: true });
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
        actor: await actorFromAuthenticatedRequest(req),
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
    ...(sessionActorResolver === undefined
      ? {}
      : { actorResolver: sessionActorResolver }),
  });
  const publicBaseUrl =
    process.env.BETTER_AUTH_URL ??
    process.env.HELIX_PUBLIC_URL ??
    process.env.PUBLIC_BASE_URL ??
    "http://localhost:3000";
  await registerTenantSamlRoutes(app, {
    orgs: orgStore,
    idpConfigs: tenantIdpConfigStore,
    publicBaseUrl,
  });
  await registerTenantScimRoutes(app, {
    orgs: orgStore,
    users: scimUserStore,
    groups: groupsStore,
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    documentationUri: process.env.HELIX_SCIM_DOCS_URL ?? "https://docs.helix.example/scim",
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
      domainStore: new PostgresSendingDomainStore(sql),
      dkimStore: new PostgresMailDkimKeyStore(sql),
      dmarcStore: new PostgresMailDmarcReportStore(sql),
      routingStore: new PostgresMailRoutingRuleStore(sql),
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
  await registerAdminIdentityRoutes(app, {
    idpConfigs: tenantIdpConfigStore,
    orgs: orgStore,
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    auditSink: auditStore,
    publicBaseUrl,
  });
  // Wave-1 admin console: Groups & OUs, security policies, OAuth apps,
  // billing, and domain/DNS management. Each route group writes through the
  // immutable audit store so admin-console changes are tamper-evidently logged.
  await registerAdminGroupsRoutes(app, {
    store: groupsStore,
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
    storageCredentialWriter: tenantStorageSecretStore,
    storageMigrationJobs: tenantStorageMigrationJobStore,
    plans: planStore,
    featureFlagEvents: eventBus,
    onFeatureFlagEventError: (error) => {
      app.log.error({ error }, "Tenant feature flag change event emission failed");
    },
  });
  await registerTenantExportRoutes(app, {
    orgs: orgStore,
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    exportPlanner: tenantExportManifestPlanner,
    exportJobs: tenantExportJobStore,
    storageResolver: driveStorageResolver,
    auditSink: auditStore,
  });
  await registerAdminOAuthAppsRoutes(app, {
    store: new PostgresOAuthAppsStore(sql),
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    auditSink: auditStore,
  });
  await registerAdminBillingRoutes(app, {
    store: new PostgresBillingStore(sql),
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
  });
  await registerAdminDomainsRoutes(app, {
    store: new PostgresDomainsStore(sql),
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    auditSink: auditStore,
  });
  await registerBackupAdminRoutes(app, {
    service: new ScriptedBackupAdminService({
      ...(process.env.HELIX_BACKUP_DIR === undefined
        ? {}
        : { backupDir: process.env.HELIX_BACKUP_DIR }),
      ...(process.env.HELIX_SECURITY_TIER === undefined
        ? {}
        : { tier: process.env.HELIX_SECURITY_TIER }),
      ...(process.env.HELIX_BACKUP_SCRIPT === undefined
        ? {}
        : { backupScript: process.env.HELIX_BACKUP_SCRIPT }),
      ...(process.env.HELIX_RESTORE_SCRIPT === undefined
        ? {}
        : { restoreScript: process.env.HELIX_RESTORE_SCRIPT }),
    }),
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
  });
  if (runtimeSearchEngine !== undefined) {
    await registerSearchAdminRoutes(app, {
      service: new SearchReindexService({
        engine: runtimeSearchEngine,
        sources: createPostgresSearchReindexSources(sql),
        batchSize: Number.parseInt(process.env.SEARCH_REINDEX_BATCH_SIZE ?? "100", 10),
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
        bus: new EventBusChatRoomBus(eventBus, { subjectPrefix: "chat.room" }),
        metrics,
        ...(redis === undefined
          ? {}
          : {
              presence: new RedisChatPresenceStore(redis, {
                ttlSeconds: Number.parseInt(process.env.CHAT_PRESENCE_TTL_SECONDS ?? "45", 10),
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
        concurrentEditorLimit: ({ request }) => collabConcurrentEditorLimit(request),
        metrics,
        onError: (error) => {
          app.log.error({ error }, "Docs websocket error");
        },
      })
    : undefined;
  await registerSheetsRoutes(app, {
    store: sheetsStore,
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    concurrentEditorLimit: ({ request }) => collabConcurrentEditorLimit(request),
    events: eventBus,
    metrics,
    onError: (error) => {
      app.log.error({ error }, "Sheets websocket error");
    },
  });
  await registerSlidesRoutes(app, {
    store: slidesStore,
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    concurrentEditorLimit: ({ request }) => collabConcurrentEditorLimit(request),
    metrics,
    onError: (error) => {
      app.log.error({ error }, "Slides websocket error");
    },
  });
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
    });

    // OnlyOffice DocumentServer integration. Skipped when
    // HELIX_ONLYOFFICE_ENABLED=false so devs who don't want the ~1 GB
    // DS container running can opt out via env without touching code.
    if (process.env.HELIX_ONLYOFFICE_ENABLED !== "false") {
      const { registerOnlyOfficeRoutes } = await import("./platform/onlyoffice/index.js");
      await registerOnlyOfficeRoutes(app, {
        store: driveStore,
        sql,
        jwtSecret:
          process.env.ONLYOFFICE_JWT_SECRET ?? "helix_onlyoffice_dev_secret_change_me",
        helixInternalUrl:
          process.env.HELIX_ONLYOFFICE_HELIX_URL ?? "http://host.docker.internal:3000",
        resolveActor: actorFromAuthenticatedRequest,
      });
    }

    // Session-cookie-authenticated content stream for the Web UI. The /dav/*
    // routes registered above require app-password Basic Auth (the WebDAV
    // contract). The browser-driven "Open file" action in the Drive UI
    // needs a path it can hit with the existing helix_session cookie and
    // have the bytes streamed back. This route fills that gap.
    app.get<{ Params: { objectId: string } }>(
      "/api/drive/objects/:objectId/content",
      async (request, reply) => {
        const actor = await actorFromAuthenticatedRequest(request);
        if (actor.id === "anonymous") {
          return reply.code(401).send({ error: "Authentication required." });
        }
        const file = await driveStore.readFile({
          orgId: actor.orgId,
          actorId: actor.id,
          objectId: request.params.objectId,
        });
        if (file === null) {
          return reply.code(404).send({ error: "File not found." });
        }
        const inline = (request.query as { download?: string }).download !== "1";
        const filename = file.entry.name ?? request.params.objectId;
        // HTTP headers are ISO-8859-1; filenames carry em-dashes / non-ASCII
        // characters routinely. Send a 7-bit-safe `filename=` plus the
        // RFC 5987 `filename*=UTF-8''` form so browsers see the real name.
        const asciiFallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, '\\"');
        const utf8Encoded = encodeURIComponent(filename);
        const disposition =
          `${inline ? "inline" : "attachment"}; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`;

        // Primary: blob streamed from the storage layer (RustFS in prod).
        if (file.content !== null) {
          return reply
            .header("content-disposition", disposition)
            .header("content-length", String(file.content.byteLength))
            .type(file.entry.mimeType ?? "application/octet-stream")
            .send(Buffer.from(file.content));
        }

        // Dev/seed fallback only. Production data must have a backing blob in
        // tenant-resolved storage; arbitrary inlineBody metadata is ignored.
        const meta = (file.entry.metadata ?? {}) as Record<string, unknown>;
        const inlineFallback = readInlineBodyFallback(meta);
        if (inlineFallback !== null) {
          const bytes = inlineFallback.body;
          return reply
            .header("content-disposition", disposition)
            .header("content-length", String(bytes.byteLength))
            .type(inlineFallback.mime ?? file.entry.mimeType ?? "application/octet-stream")
            .send(bytes);
        }

        return reply.code(404).send({ error: "File content unavailable." });
      },
    );

    /* /api/drive/objects/:id/preview
     *
     * Returns a browser-renderable preview of the file:
     *  - PDF / images / txt / csv / md → forwards to the raw content endpoint
     *    inline; the browser renders these natively.
     *  - DOCX → converted to HTML on the fly via mammoth.
     *  - XLSX → rendered as a stack of HTML tables (one per sheet).
     *  - PPTX / unknown → wrapped in a small "preview not yet rendered"
     *    HTML shell with a Download link.
     *
     * The UI's "Open" action points here so clicking a file actually opens
     * something — even for office formats the browser can't display.
     */
    app.get<{ Params: { objectId: string } }>(
      "/api/drive/objects/:objectId/preview",
      async (request, reply) => {
        const actor = await actorFromAuthenticatedRequest(request);
        if (actor.id === "anonymous") {
          return reply.code(401).send({ error: "Authentication required." });
        }
        const file = await driveStore.readFile({
          orgId: actor.orgId,
          actorId: actor.id,
          objectId: request.params.objectId,
        });
        if (file === null) {
          return reply.code(404).send({ error: "File not found." });
        }
        const meta = (file.entry.metadata ?? {}) as Record<string, unknown>;
        const inlineFallback = readInlineBodyFallback(meta);
        const bytes =
          file.content !== null
            ? Buffer.from(file.content)
            : (inlineFallback?.body ?? null);
        if (bytes === null) {
          return reply.code(404).send({ error: "File content unavailable." });
        }
        const mime = file.entry.mimeType ?? inlineFallback?.mime ?? "";
        const filename = file.entry.name ?? request.params.objectId;
        const rawUrl = `/api/drive/objects/${request.params.objectId}/content`;

        // Browser-native formats: serve as-is, inline.
        if (
          mime.startsWith("application/pdf") ||
          mime.startsWith("image/") ||
          mime.startsWith("video/") ||
          mime.startsWith("audio/") ||
          mime.startsWith("text/plain") ||
          mime.startsWith("text/csv") ||
          mime.startsWith("text/markdown") ||
          mime.startsWith("text/html")
        ) {
          return reply
            .header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(filename)}`)
            .header("content-length", String(bytes.byteLength))
            .type(mime || "application/octet-stream")
            .send(bytes);
        }

        // DOCX → HTML via mammoth.
        if (mime.includes("wordprocessingml") || filename.toLowerCase().endsWith(".docx")) {
          const mammothModule: unknown = await import("mammoth");
          const mammoth = (mammothModule as { default?: { convertToHtml: typeof import("mammoth").convertToHtml } }).default ?? mammothModule;
          const { value: html, messages } = await (mammoth as typeof import("mammoth")).convertToHtml({ buffer: bytes });
          return reply
            .type("text/html; charset=utf-8")
            .send(wrapPreview(filename, html, messages.map((m) => m.message)));
        }

        // XLSX → HTML tables via exceljs.
        if (mime.includes("spreadsheetml") || filename.toLowerCase().endsWith(".xlsx")) {
          const ExcelJS = (await import("exceljs")).default;
          const wb = new ExcelJS.Workbook();
          // exceljs's types want a strict ArrayBuffer; our Buffer is backed
          // by one, so a narrow .buffer slice works at runtime.
          await wb.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
          const tables: string[] = [];
          wb.eachSheet((sheet) => {
            const rows: string[] = [];
            sheet.eachRow((row) => {
              const cells: string[] = [];
              row.eachCell({ includeEmpty: true }, (cell) => {
                const v = cell.value;
                const text =
                  v === null || v === undefined
                    ? ""
                    : typeof v === "object"
                      ? JSON.stringify(v)
                      : String(v);
                cells.push(`<td>${escapeHtml(text)}</td>`);
              });
              rows.push(`<tr>${cells.join("")}</tr>`);
            });
            tables.push(`<h2>${escapeHtml(sheet.name)}</h2><table>${rows.join("")}</table>`);
          });
          return reply
            .type("text/html; charset=utf-8")
            .send(wrapPreview(filename, tables.join("\n"), []));
        }

        // Unsupported (PPTX, ZIP, binary blobs): show a friendly placeholder
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
        process.env.MEET_JITSI_WEBHOOK_SHARED_SECRET ??
        process.env.JITSI_WEBHOOK_SECRET ??
        "helix_dev_jitsi_webhook_secret_change_me",
      defaultOrgId: process.env.HELIX_DEFAULT_ORG_ID ?? "00000000-0000-0000-0000-000000000000",
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
  // Every supervisor uses its own PostgresAdvisoryLockClient: session-level
  // advisory locks are connection-bound, so each long-lived lease needs its
  // own pinned (reserved) connection.
  const leaderGatedWorkers: { readonly name: string; readonly worker: SupervisedWorker }[] = [];
  if (searchEventIndexer !== undefined) {
    leaderGatedWorkers.push({ name: "search-event-indexer", worker: searchEventIndexer });
  }
  leaderGatedWorkers.push({ name: "ai-enrichment-worker", worker: enrichmentWorker });
  if (outboundMailWorker !== undefined) {
    leaderGatedWorkers.push({ name: "outbound-mail-worker", worker: outboundMailWorker });
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
  if (tenantStorageMigrationWorker !== undefined) {
    leaderGatedWorkers.push({
      name: "tenant-storage-migration-worker",
      worker: tenantStorageMigrationWorker,
    });
  }
  if (tenantExportWorker !== undefined) {
    leaderGatedWorkers.push({
      name: "tenant-export-worker",
      worker: tenantExportWorker,
    });
  }
  if (byoStorageHealthWorker !== undefined) {
    leaderGatedWorkers.push({
      name: "byo-storage-health-worker",
      worker: byoStorageHealthWorker,
    });
  }
  leaderGatedWorkers.push({ name: "pending-action-expiry-worker", worker: pendingActionExpiryWorker });

  const workerRetryIntervalMs = Number.parseInt(
    process.env.LEADER_ELECTION_RETRY_INTERVAL_MS ?? "15000",
    10,
  );
  const workerSupervisors = leaderGatedWorkers.map(
    ({ name, worker }) =>
      new SingletonWorkerSupervisor({
        name,
        worker,
        election: new LeaderElection(new PostgresAdvisoryLockClient(sql)),
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
      process.env.HELIX_PLUGINS_DIR ?? fileURLToPath(new URL("../../../plugins", import.meta.url)),
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
      app.log.info(
        { tier: config.security.tier },
        "Applied hot-reloaded platform configuration",
      );
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
    return {
      role: coreApps.role,
      apps: coreApps.statuses().map((status) => ({
        id: status.id,
        name: status.name,
        enabled: status.enabled,
        registered: status.registered,
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

  app.post("/api/tools/pending/:pendingId/approve", async (request, reply) => {
    const params = pendingActionParamsSchema.parse(request.params);
    const result = await tools.approvePending(params.pendingId, {
      actor: await actorFromAuthenticatedRequest(request),
      request: createRequestContext(request),
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
    const result = await tools.cancelPending(params.pendingId, {
      actor: await actorFromAuthenticatedRequest(request),
    });
    if (!result.ok) {
      return sendToolInvokeError(reply, result, traceIdForRequest(request));
    }
    return { status: result.status, pending: result.pending };
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
      docs: docsStore,
    });

  app.post("/mcp", async (request, reply) => {
    const actor = await actorFromAuthenticatedRequest(request);
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
        actor,
        body: request.body,
        resources: mcpResourceProvider(),
      })) {
        reply.raw.write(formatSseEvent(event));
      }
      reply.raw.end();
      return reply;
    }
    return handleMcpJsonRpcRequest({
      tools,
      actor,
      body: request.body,
      resources: mcpResourceProvider(),
    });
  });

  return app;
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

function collabConcurrentEditorLimit(request: FastifyRequest): number | null | undefined {
  return request.effectiveConfig?.quotas.collab_concurrent_editors_per_doc;
}

async function invokeTool(
  tools: RuntimeToolRegistry,
  tokenStore: AccessTokenStore,
  sessionResolver: SessionActorResolver | undefined,
  credentialStore: AgentCredentialStore | undefined,
  toolId: string,
  input: unknown,
  request: FastifyRequest,
) {
  const result = await tools.invoke(toolId, input, {
    request: createRequestContext(request),
    actor: await resolveRequestActor(
      request,
      tokenStore,
      sessionResolver,
      credentialStore,
    ),
    enforceConfirmation: true,
  });
  return result;
}

function sendToolInvokeError(
  reply: FastifyReply,
  result: ToolInvokeErrorResult,
  traceId: string,
) {
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
    readonly metrics: PlatformMetrics;
    readonly securityTier: SecurityTier;
    readonly onCostWarning?: (event: AICostWarningEvent) => void;
    readonly aiConfig?: AiConfig;
  },
): AIRouter {
  const defaultProviderId =
    process.env.ASSISTANT_AI_PROVIDER_ID ?? process.env.AI_DEFAULT_PROVIDER_ID;
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
  const baseUrl = process.env.MEILI_URL ?? process.env.MEILISEARCH_URL ?? process.env.MEILI_HOST;
  if (baseUrl === undefined) {
    return undefined;
  }
  const apiKey =
    process.env.MEILI_MASTER_KEY ?? process.env.MEILI_API_KEY ?? process.env.MEILISEARCH_API_KEY;
  const engine = new MeilisearchSearchEngine(
    createMeilisearchHttpClient({
      baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
    }),
    {
      indexUid: process.env.MEILI_INDEX_UID ?? process.env.MEILISEARCH_INDEX_UID ?? "helix_search",
    },
  );
  await engine.ensureIndex();
  return engine;
}

function parseS3ServerSideEncryption(value: string): "AES256" {
  if (value !== "AES256") {
    throw new TypeError("RUSTFS_SERVER_SIDE_ENCRYPTION must be AES256");
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

  const trustedOrigins = parseCsv(env.BETTER_AUTH_TRUSTED_ORIGINS ?? env.CLIENT_ORIGIN);
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

export function getOutboundMailConfig(env: NodeJS.ProcessEnv) {
  const host = env.MAIL_SMTP_HOST ?? env.SES_SMTP_HOST;
  if (host === undefined || host.length === 0) {
    return undefined;
  }

  const port = env.MAIL_SMTP_PORT ?? env.SES_SMTP_PORT;
  const secure = env.MAIL_SMTP_SECURE ?? env.SES_SMTP_SECURE;
  const user = env.MAIL_SMTP_USER ?? env.SES_SMTP_USER;
  const pass = env.MAIL_SMTP_PASS ?? env.SES_SMTP_PASS;

  return {
    host,
    ...(port === undefined ? {} : { port: Number.parseInt(port, 10) }),
    ...(secure === undefined ? {} : { secure: envValueFlag(secure, false) }),
    ...(user === undefined ? {} : { user }),
    ...(pass === undefined ? {} : { pass }),
  };
}

export function getSmtpMailReceiverConfig(
  env: NodeJS.ProcessEnv,
):
  | { readonly orgId: SmtpReceiverOptions["orgId"]; readonly port: number; readonly host?: string }
  | undefined {
  if (!envValueFlag(env.MAIL_SMTP_RECEIVER_ENABLED ?? "", false)) {
    return undefined;
  }

  const host = env.MAIL_SMTP_RECEIVER_HOST;
  return {
    orgId: env.HELIX_DEFAULT_ORG_ID ?? "00000000-0000-0000-0000-000000000000",
    port: Number.parseInt(env.MAIL_SMTP_RECEIVER_PORT ?? "2525", 10),
    ...(host === undefined || host.length === 0 ? {} : { host }),
  };
}

function envFlag(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) {
    return defaultValue;
  }
  return envValueFlag(value, defaultValue);
}

function envPositiveInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && String(parsed) === value.trim()
    ? parsed
    : defaultValue;
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
function resolveConfirmationTimeoutMs(
  tier: SecurityTier,
  env: NodeJS.ProcessEnv,
): number {
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

function parseCsv(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function createAssistantProviders(
  aiConfig: AiConfig | undefined,
): readonly LLMProviderCapability[] {
  const providers: LLMProviderCapability[] = [];
  if (aiConfig?.enabled !== false) {
    for (const provider of aiConfig?.providers ?? []) {
      if (provider.enabled === false) {
        continue;
      }
      const configured = createConfiguredAssistantProvider(provider, process.env);
      if (configured !== undefined) {
        providers.push(configured);
      }
    }
  }
  if (process.env.OLLAMA_BASE_URL !== undefined) {
    pushProvider(
      providers,
      createOpenAICompatibleProvider({
        id: "ollama.local",
        baseUrl: process.env.OLLAMA_BASE_URL,
        models: [
          {
            id: process.env.OLLAMA_MODEL ?? "llama3.1",
            displayName: process.env.OLLAMA_MODEL ?? "Local Ollama",
            supportsTools: true,
          },
        ],
        defaultModel: process.env.OLLAMA_MODEL ?? "llama3.1",
      }),
    );
  }
  if (process.env.OPENAI_API_KEY !== undefined) {
    pushProvider(
      providers,
      createOpenAICompatibleProvider({
        id: "openai-compatible.default",
        apiKey: process.env.OPENAI_API_KEY,
        ...(process.env.OPENAI_BASE_URL === undefined
          ? {}
          : { baseUrl: process.env.OPENAI_BASE_URL }),
        models: [
          {
            id: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
            displayName: process.env.OPENAI_MODEL ?? "OpenAI compatible",
            supportsTools: true,
          },
        ],
        defaultModel: process.env.OPENAI_MODEL ?? "gpt-4.1-mini",
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
