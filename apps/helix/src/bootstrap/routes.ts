import { installDriveRoutes } from "./drive-routes.js";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import websocket from "@fastify/websocket";
import type { CreateFastifyContextOptions } from "@trpc/server/adapters/fastify";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { resolveTxt } from "node:dns/promises";
import { join } from "node:path";
import { unauthenticatedActor } from "../api/actor.js";
import { buildErrorEnvelope } from "../api/error-envelope.js";
import { installHttpMetrics } from "../api/metrics.js";
import { WEBSOCKET_MAX_PAYLOAD_BYTES } from "../api/request-body.js";
import { createRequestContext } from "../api/trace.js";
import { HELIX_SERVER_VERSION } from "../api/version.js";
import { PostgresBillingStore, registerAdminBillingRoutes } from "../platform/admin/billing.js";
import { AuthoritativeDnsResolver } from "../platform/admin/dns-resolver.js";
import { readDomainsWithRecords, registerAdminDomainsRoutes } from "../platform/admin/domains.js";
import { PostgresGroupsStore, registerAdminGroupsRoutes } from "../platform/admin/groups.js";
import { registerAdminIdentityRoutes } from "../platform/admin/identity.js";
import {
  PostgresOAuthAppsStore,
  registerAdminOAuthAppsRoutes,
} from "../platform/admin/oauth-apps.js";
import { registerAdminOverviewRoutes } from "../platform/admin/overview.js";
import { registerAdminScimCredentialRoutes } from "../platform/admin/scim-credentials.js";
import {
  readSecurityPolicies,
  registerAdminSecurityPoliciesRoutes,
} from "../platform/admin/security-policies.js";
import { evaluateOrgAdminMfa } from "../platform/admin/security-policy-runtime.js";
import { PostgresAdminServiceStatusStore } from "../platform/admin/service-status.js";
import { AdminServicesCatalog, registerAdminServicesRoutes } from "../platform/admin/services.js";
import { registerTenantConfigAdminRoutes } from "../platform/admin/tenant-config.js";
import { registerAICostLimitAdminRoutes } from "../platform/ai/index.js";
import {
  buildCoreAppsAdminStatus,
  registerCoreAppsAdminRoutes,
} from "../platform/apps/admin-routes.js";
import { registerAuditLogAdminRoutes } from "../platform/audit/routes.js";
import {
  actorExistsInOrg,
  disableActorForOffboard,
  registerAdminUsersRoutes,
  revokeSessionsForActorSql,
} from "../platform/auth/admin-users.js";
import {
  createCsrfToken,
  csrfTokenFromCookie,
  isTrustedCookieMutation,
  isTrustedCorsOrigin,
  normalizeTrustedOrigins,
  serializeCsrfCookie,
} from "../platform/auth/browser-security.js";
import {
  installCrownJewelGate,
  PostgresCrownJewelApprovalStore,
} from "../platform/auth/crown-jewel.js";
import { registerDomainIdentityDiscoveryRoute } from "../platform/auth/domain-identity.js";
import { OAuthTokenService } from "../platform/auth/oauth.js";
import { registerOAuthRoutes } from "../platform/auth/routes.js";
import { PostgresProfileStore, registerProfileRoutes } from "../platform/auth/profile.js";
import { registerTenantScimRoutes } from "../platform/auth/scim-routes.js";
import {
  registerBackupAdminRoutes,
  ScriptedBackupAdminService,
} from "../platform/backup/admin-routes.js";
import { PostgresRestoreJobStore, RestoreJobWorker } from "../platform/backup/restore-jobs.js";
import {
  registerCalendarRoutes,
  registerCalendarSchedulingRoutes,
} from "../platform/calendar/index.js";
import {
  PostgresPeopleStore,
  registerCardDavRoutes,
  registerPeopleRoutes,
} from "../platform/carddav/index.js";
import {
  PostgresChatWebSocketTicketStore,
  registerChatModerationRoutes,
  registerChatRoutes,
} from "../platform/chat/index.js";
import { registerPlatformConfigAdminRoutes } from "../platform/config/admin.js";
import { registerDriveScanAdminRoutes } from "../platform/drive/index.js";
import { registerEventRoutes } from "../platform/events/routes.js";
import { EventStreamLimiter } from "../platform/events/stream-limit.js";
import { PostgresGovernanceStore, registerGovernanceRoutes } from "../platform/governance/index.js";
import {
  MailAdminStatusService,
  MailDeliveryAlertMonitor,
  PostgresMailDmarcReportStore,
  PostgresMailRoutingRuleStore,
  PostgresOutboundProviderStore,
  registerMailAdminRoutes,
  registerMailDeliveryAdminRoutes,
  registerMailDeliveryEventAdminRoutes,
  registerMailProviderWebhookRoutes,
  registerMailQuarantineAdminRoutes,
  registerOutboundMailAdminRoutes,
} from "../platform/mail/index.js";
import { registerMeetRoutes } from "../platform/meet/index.js";
import { isSaas } from "../platform/mode/index.js";
import { registerSearchAdminRoutes } from "../platform/search/index.js";
import { registerInviteRoutes } from "../platform/signup/routes.js";
import {
  buildEffectiveTenantConfig,
  createPostgresTenantExportManifestPlanner,
  registerTenantLifecycleRoutes,
} from "../platform/tenancy/index.js";
import {
  registerWebhookRoutes,
  registerWebhookVerificationDocsRoute,
} from "../platform/webhooks/index.js";
import { registerBetterAuthRoutes } from "./auth-routes.js";
import { traceIdForRequest } from "./request-principal.js";
import { isAdminMfaProtectedPath } from "./route-scope.js";
import type { installTools } from "./tools.js";

export async function installRoutes(context: Awaited<ReturnType<typeof installTools>>) {
  const {
    bootEnv,
    trustedOrigins,
    app,
    metrics,
    sql,
    tenantHourlyQuotaLimiter,
    oauthIssuer,
    oauthStore,
    agentCredentialStore,
    oauthAuthorizationStore,
    authorizationCodeService,
    betterAuthConfig,
    betterAuthRuntime,
    betterAuthSessionIssuer,
    orgStore,
    domainsStore,
    domainIdentityStore,
    tenantProvisioningStore,
    tenantIdpConfigStore,
    securityPoliciesStore,
    tenantScimCredentialStore,
    scimProvisioningStore,
    signupEmailVerificationTokenStore,
    signupVerifiedIdentityStore,
    signupOnboardingInviteTokenStore,
    planStore,
    appPasswordStore,
    adminUsersStore,
    adminDomainsStore,
    auditStore,
    webhookSecretResolver,
    webhookStore,
    chatModerationStore,
    calendarStore,
    calendarSchedulingStore,
    cardDavContactStore,
    outboxStore,
    eventBus,
    chatStore,
    chatRoomBus,
    chatPresence,
    meteringClient,
    meetStore,
    platformConfig,
    runtimeConfiguration,
    sessionActorResolver,
    principalFromAuthenticatedRequest,
    actorFromAuthenticatedRequest,
    coreApps,
    configuredMeetSecrets,
    dlp,
    securityTier,
    mfaAssurance,
    mfaResolver,
    recoveryCodes,
    aiCostLimitStore,
    clamavScanner,
    inboundMailScanners,
    driveStorageResolver,
    tenantStorageMigrationJobStore,
    mailStore,
    mailQuarantineStore,
    driveStore,
    chatAttachmentStore,
    searchReindexJobService,
    searchReindexService,
    mailDkimKeyStore,
    outboundProviderStore,
    mailDeliveryEventStore,
    mailSecretProvider,
    tools,
    calendarInvitationSender,
    leaderGatedWorkers,
    trpcRouter,
  } = context;
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
    sessionActorResolver,
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

  if (bootEnv.NODE_ENV !== "production") {
    const { default: swaggerUi } = await import("@fastify/swagger-ui");
    await app.register(swaggerUi, { routePrefix: "/docs" });
  }

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
  });

  registerProfileRoutes(app, {
    store: new PostgresProfileStore(sql),
    sessionActorResolver,
    actorFromRequest: actorFromAuthenticatedRequest,
    auditSink: auditStore,
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

  await registerInviteRoutes(app, {
    orgs: orgStore,
    provisioning: tenantProvisioningStore,
    verificationTokens: signupEmailVerificationTokenStore,
    identities: signupVerifiedIdentityStore,
    ...(betterAuthSessionIssuer === undefined ? {} : { sessionIssuer: betterAuthSessionIssuer }),
    outbox: outboxStore,
    actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
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

  if (isSaas(runtimeConfiguration.current)) {
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

  await installDriveRoutes(context);

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
      requireRecordingEncryption: bootEnv.NODE_ENV === "production" || securityTier !== "personal",
      metrics,
      onError: (error) => {
        app.log.error({ error }, "Meet webhook error");
      },
    });
  }
  return { ...context, chatRoutes };
}
