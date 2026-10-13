import type { Actor } from "@helix/sdk-types";
import { createResourceClassifier } from "../api/classify-resource.js";
import { createHelixTRPCRouter } from "../api/trpc.js";
import { agentLimitBudgetOverrideFromEnv, resolveConfirmationTimeoutMs } from "../bootstrap/env.js";
import {
  PostgresAgentSecretStore,
  registerAgentSecretTools,
} from "../platform/agent-secrets/index.js";
import { registerMemoryTools } from "../platform/ai/memory/index.js";
import { registerAskUserTool } from "../platform/assistant/ask-user.js";
import { registerChatRecallTools } from "../platform/assistant/chats.js";
import { registerContextTools } from "../platform/assistant/context-tools.js";
import { registerTaskTools } from "../platform/assistant/tasks.js";
import { registerRoutineTools } from "../platform/assistant/routines.js";
import { PostgresRoutineStore } from "../platform/assistant/routines-postgres.js";
import { AssistantRoutineWorker } from "../platform/assistant/routines-worker.js";
import {
  PostgresAccountPreferencesStore,
  registerAccountPreferenceTools,
} from "../platform/auth/account-preferences.js";
import { registerAppPasswordTools } from "../platform/auth/app-passwords.js";
import {
  PostgresChatAdminRoomStore,
  registerChatAdminRoomTools,
} from "../platform/chat/admin-rooms.js";
import { PostgresChatInboxStore, registerChatInboxTools } from "../platform/chat/inbox.js";
import { PostgresUserAddressStore } from "../platform/auth/user-addresses.js";
import {
  tenantAwarePostgresSql,
  withTenantPostgresContext,
  withRequesterPostgresActor,
} from "../platform/tenancy/postgres-roles.js";
import {
  agentCredentialScopeCatalog,
  registerAgentCredentialTools,
} from "../platform/auth/tools.js";
import {
  CalendarInvitationDeliveryWorker,
  createMailCalendarInvitationSender,
  registerCalendarTools,
} from "../platform/calendar/index.js";
import { PostgresContactsStore, registerContactsTools } from "../platform/carddav/index.js";
import { registerChatTools } from "../platform/chat/index.js";
import { tierDefaults } from "../platform/config/tier.js";
import { createPersonLimitStore } from "./person-limits.js";
import {
  registerDriveCollaborationTools,
  registerDriveCopyTool,
  registerDriveS3KeyTools,
  registerDriveTools,
} from "../platform/drive/index.js";
import { createEventSchemaRegistry } from "../platform/events/schema-registry.js";
import { TenantConfigFeatureFlagProvider } from "../platform/feature-flags/provider.js";
import { type ReadinessProbe } from "../platform/health/readiness.js";
import { type SupervisedWorker } from "../platform/leader/election.js";
import {
  InMemoryAgentRateCostLimiter,
  RedisAgentRateCostLimiter,
} from "../platform/limits/index.js";
import {
  registerMailDeliveryEventRoutes,
  registerMailSourceRoutes,
  registerMailStreamRoutes,
  registerMailTools,
} from "../platform/mail/index.js";
import { PostgresAgentMailStore } from "../platform/mail/agent-mail/index.js";
import {
  createJibriRecorderHealthCheck,
  createMeetConferenceProvider,
  missingMeetSecrets,
  registerMeetStatusTool,
  registerMeetTools,
} from "../platform/meet/index.js";
import {
  PostgresNotificationStore,
  registerNotificationTools,
} from "../platform/notifications/index.js";
import {
  CerbosToolAccessPolicy,
  ObservedToolAccessPolicy,
  ScopeToolAccessPolicy,
} from "../platform/permissions/tool-access.js";
import { registerSearchTools } from "../platform/search/index.js";
import { registerWebSearchTool } from "../platform/search/web-tools.js";
import { signupEventSchemas } from "../platform/signup/event-schemas.js";
import { loadEffectiveTenantConfig } from "../platform/tenancy/index.js";
import { createToolRegistry } from "../platform/tool-registry.js";
import { createActionTools } from "../platform/tools/actions-tools.js";
import { createAgentOperationalControlTools } from "../platform/tools/agent-operational-controls-tools.js";
import { RuntimeAgentOperationalControlStore } from "../platform/tools/agent-operational-controls.js";
import { PendingActionExpiryWorker } from "../platform/tools/pending-action-expiry-worker.js";
import { PostgresPendingActionStore } from "../platform/tools/pending-actions-postgres-store.js";
import { InMemoryConfirmationGate } from "../platform/tools/registry.js";
import { registerWebhookTools } from "../platform/webhooks/index.js";
import { installAssistantRuntime } from "./assistant-runtime.js";
import type { installAuditWorkers } from "./audit-workers.js";
import { createPendingPrincipalResolver } from "./pending-principal.js";
import { registerCanonicalApi } from "./route-scope.js";

export async function installTools(context: Awaited<ReturnType<typeof installAuditWorkers>>) {
  const {
    bootEnv,
    app,
    metrics,
    sql,
    redis,
    agentCredentialStore,
    mailCfg,
    domainsStore,
    tenantStorageSecretReader,
    orgStore,
    securityPoliciesStore,
    appPasswordStore,
    driveS3AccessKeyStore,
    auditStore,
    webhookSecretResolver,
    webhookStore,
    calendarStore,
    calendarInvitationDeliveryStore,
    eventBus,
    chatStore,
    chatRoomBus,
    meetStore,
    platformConfig,
    actorFromAuthenticatedRequest,
    coreApps,
    configuredMeetSecrets,
    resourceClassificationService,
    dlp,
    assistantMemory,
    securityTier,
    mailStore,
    mailQuarantineStore,
    driveStore,
    driveWorkflowStore,
    runtimeSearchEngine,
    mailAppRegistered,
    outboundProviderStore,
    mailDeliveryEventStore,
    tenantSecretCipher,
  } = context;
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
    loadTenantConfig: ({ orgId }) => loadEffectiveTenantConfig({ orgs: orgStore }, orgId),
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
    resolvePendingPrincipal: createPendingPrincipalResolver(sql, agentCredentialStore),
    runAsRequester: (requester, work) => withRequesterPostgresActor(requester.id, work),
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
  for (const tool of createActionTools(tools)) {
    tools.register(tool);
  }

  registerWebhookTools(tools, { store: webhookStore, secretResolver: webhookSecretResolver });

  // Core-app agent tools are contributed per app, conditionally on enablement
  // + role: a disabled app contributes no tools to the registry, so it is
  // absent from REST, tRPC, MCP and the assistant.
  if (coreApps.shouldRegister("mail")) {
    registerMailTools(tools, {
      store: mailStore,
      agentMail: new PostgresAgentMailStore(sql),
      quarantineStore: mailQuarantineStore,
      sendLimit: createPersonLimitStore(sql, orgStore),
      draftsRunUnattended: async (orgId) =>
        (await loadEffectiveTenantConfig({ orgs: orgStore }, orgId))?.features
          .agent_mail_drafts_unattended !== false,
      defaultFromDomain: mailCfg.fromDomain,
      resolveInternalDomains: async (orgId) =>
        (await domainsStore.listDomains(orgId))
          .filter((domain) => domain.status === "verified" && domain.mailEnabled)
          .map((domain) => domain.domain),
      // Domain aliases reach the user too; reply-all must never address them.
      resolveOwnAddresses: (orgId, actorId) =>
        withTenantPostgresContext(sql, { orgId, actorId }, async () => {
          const store = new PostgresUserAddressStore(tenantAwarePostgresSql(sql));
          const addresses = await store.get(orgId, actorId);
          return addresses?.addresses.map((entry) => entry.address) ?? [];
        }),
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
        maxAttachmentBytes: bootEnv.MAIL_SMTP_MAX_MESSAGE_BYTES,
      });
    });
  }

  registerAgentSecretTools(tools, {
    store: new PostgresAgentSecretStore(sql, tenantSecretCipher),
    requestsRunUnattended: async (orgId) =>
      (await loadEffectiveTenantConfig({ orgs: orgStore }, orgId))?.features
        .agent_secrets_unattended !== false,
  });

  if (coreApps.shouldRegister("chat")) {
    registerChatTools(tools, {
      store: chatStore,
      bus: chatRoomBus,
      ...(resourceClassifier === undefined ? {} : { classifyResource: resourceClassifier }),
    });
    registerChatInboxTools(tools, { store: new PostgresChatInboxStore(sql) });
    registerChatAdminRoomTools(tools, {
      store: new PostgresChatAdminRoomStore(sql),
      adminsSeePrivateRooms: async (orgId) =>
        (await loadEffectiveTenantConfig({ orgs: orgStore }, orgId))?.features
          .chat_admin_private_rooms === true,
    });
  }

  if (coreApps.shouldRegister("drive")) {
    registerDriveS3KeyTools(tools, { store: driveS3AccessKeyStore });
    registerDriveCollaborationTools(tools, driveStore);
    registerDriveCopyTool(tools, { store: driveStore, dlp });
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
      // Same precedence as the auth and route origins; PUBLIC_BASE_URL alone left
      // RSVP links pointing at localhost when only HELIX_PUBLIC_URL was configured.
      rsvpBaseUrl: bootEnv.HELIX_PUBLIC_URL ?? bootEnv.PUBLIC_BASE_URL ?? "http://localhost:3000",
      ...(configuredMeetSecrets === null
        ? {}
        : {
            conference: createMeetConferenceProvider({
              store: meetStore,
              jwtSubject: bootEnv.MEET_JITSI_DOMAIN ?? "meet.localhost",
              jitsiPublicUrl: bootEnv.MEET_JITSI_PUBLIC_URL,
              publicBaseUrl:
                bootEnv.HELIX_PUBLIC_URL ?? bootEnv.PUBLIC_BASE_URL ?? "http://localhost:3000",
            }),
          }),
    });
  }

  if (coreApps.shouldRegister("meet")) {
    registerMeetStatusTool(tools, { missingSecrets: missingMeetSecrets(bootEnv) });
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

  const webSearchAllowed = () => {
    const security = context.runtimeConfiguration.current.security;
    return (
      security.tier !== "sovereign" &&
      !(security.overrides?.localAiOnly ?? tierDefaults[security.tier].localAiOnly)
    );
  };
  registerWebSearchTool(tools, () => context.runtimeConfiguration.current.ai, webSearchAllowed);
  registerMemoryTools(tools, assistantMemory);
  registerContextTools(tools);
  registerTaskTools(tools);
  registerChatRecallTools(tools);
  registerAskUserTool(tools);
  const routineStore = new PostgresRoutineStore(sql);
  registerRoutineTools(tools, routineStore);

  const assistantOrchestrator = installAssistantRuntime(context, {
    tools,
    confirmationGate,
    featureFlags,
    webSearchAllowed,
  });

  // Cross-surface notifications. The activity table is the audit chain;
  // notifications is a per-recipient inbox derived from that activity.
  registerNotificationTools(tools, {
    store: new PostgresNotificationStore(sql),
  });

  const leaderGatedWorkers: {
    readonly name: string;
    readonly worker: SupervisedWorker;
  }[] = [];
  leaderGatedWorkers.push({
    name: "assistant-routine-worker",
    worker: new AssistantRoutineWorker(
      routineStore,
      assistantOrchestrator,
      async (orgId, actorId) => {
        const rows = (await sql`
          select id, org_id, type, display_name, email, scopes
          from actors
          where id = ${actorId} and org_id = ${orgId} and disabled_at is null
          limit 1
        `) as unknown as readonly {
          readonly id: string;
          readonly org_id: string;
          readonly type: Actor["type"];
          readonly display_name: string;
          readonly email: string | null;
          readonly scopes: readonly string[];
        }[];
        const row = rows[0];
        if (row === undefined) return null;
        return {
          id: row.id,
          orgId: row.org_id,
          type: row.type,
          displayName: row.display_name,
          ...(row.email === null ? {} : { email: row.email }),
          scopes: row.scopes,
        };
      },
    ),
  });

  registerAgentCredentialTools(tools, {
    store: agentCredentialStore,
    scopeCatalog: agentCredentialScopeCatalog,
  });

  registerAppPasswordTools(tools, { store: appPasswordStore });
  registerAccountPreferenceTools(tools, { store: new PostgresAccountPreferencesStore(sql) });
  registerContactsTools(tools, { store: new PostgresContactsStore(sql) });

  const trpcRouter = createHelixTRPCRouter({ tools, metrics, platformConfig });

  const readinessProbes: ReadinessProbe[] = [];
  return {
    ...context,
    eventSchemas,
    pendingActionExpiryWorker,
    tools,
    calendarInvitationSender,
    calendarInvitationDeliveryWorker,
    assistantOrchestrator,
    leaderGatedWorkers,
    trpcRouter,
    readinessProbes,
  };
}
