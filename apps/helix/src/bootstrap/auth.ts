import { createMeteringClient } from "@helix/sdk";
import { Redis } from "ioredis";
import {
  InMemoryIdempotencyStore,
  RedisIdempotencyStore,
  type IdempotencyStore,
} from "../api/idempotency.js";
import { envFlag } from "../bootstrap/env.js";
import { getBetterAuthRuntimeConfig } from "../config/auth.js";
import { resolveRedisConnection } from "../config/redis-connection.js";
import {
  assertTenantRlsCoverage,
  assertTenantSafeDatabaseRole,
  createSqlClient,
} from "../db/client.js";
import { PostgresDomainsStore } from "../platform/admin/domains.js";
import { PostgresSecurityPoliciesStore } from "../platform/admin/security-policies.js";
import { PostgresAssistantStore } from "../platform/assistant/index.js";
import { PostgresAuditStore } from "../platform/audit/store.js";
import { PostgresAdminUsersStore } from "../platform/auth/admin-users.js";
import { PostgresAppPasswordStore } from "../platform/auth/app-passwords.js";
import { AuthorizationCodeService } from "../platform/auth/authorization-code.js";
import { PostgresOAuthAuthorizationStore } from "../platform/auth/authorization-store.js";
import {
  createBetterAuthPlatformModule,
  createBetterAuthRuntime,
  PostgresBetterAuthActorStore,
  PostgresBetterAuthSessionIssuer,
  PostgresBetterAuthSessionPolicyAuthorizer,
} from "../platform/auth/better-auth.js";
import { PostgresDomainIdentityStore } from "../platform/auth/domain-identity.js";
import { recoveryCodeDigest } from "../platform/auth/mfa.js";
import {
  PostgresAgentCredentialStore,
  PostgresAuthorizationCodeStore,
  PostgresOAuthStore,
} from "../platform/auth/postgres-store.js";
import { PostgresTenantScimCredentialStore } from "../platform/auth/scim-credentials.js";
import { PostgresScimProvisioningStore } from "../platform/auth/scim-provisioning.js";
import {
  resolveTenantOidcPrivateKey,
  resolveTenantOidcUser,
} from "../platform/auth/sso-runtime.js";
import { PostgresTenantIdpConfigStore } from "../platform/auth/tenant-idp-configs.js";
import {
  PostgresCalendarInvitationDeliveryStore,
  PostgresCalendarSchedulingStore,
  PostgresCalendarStore,
} from "../platform/calendar/index.js";
import { PostgresCardDavContactStore } from "../platform/carddav/index.js";
import {
  createChatNatsSecurityPolicy,
  EventBusChatRoomBus,
  InMemoryChatPresenceStore,
  PostgresChatModerationStore,
  PostgresChatRoomEventLog,
  PostgresChatStore,
  RedisChatPresenceStore,
} from "../platform/chat/index.js";
import { InMemoryEventBus } from "../platform/events/in-memory-event-bus.js";
import { NatsEventBus } from "../platform/events/nats-event-bus.js";
import {
  InMemoryTenantApiRpsLimiter,
  InMemoryTenantHourlyQuotaLimiter,
  RedisTenantApiRpsLimiter,
  RedisTenantHourlyQuotaLimiter,
  type TenantApiRpsLimiter,
  type TenantHourlyQuotaLimiter,
} from "../platform/limits/index.js";
import { mailConfig } from "../platform/mail/config.js";
import { NodemailerMailTransport } from "../platform/mail/index.js";
import { MeetLifecycleWorker, PostgresMeetStore } from "../platform/meet/index.js";
import {
  MeteringIngestWorker,
  MeteringRollupWorker,
  PostgresMeteringEventStore,
  PostgresMeteringRollupStore,
} from "../platform/metering/index.js";
import { PostgresOutboxStore } from "../platform/outbox/postgres-store.js";
import {
  createVaultTenantSecretReaderFromEnv,
  TenantEnvelopeCipher,
} from "../platform/secrets/index.js";
import { PostgresSignupOnboardingInviteTokenStore } from "../platform/signup/invites.js";
import {
  PostgresSignupEmailVerificationTokenStore,
  PostgresSignupVerifiedIdentityStore,
} from "../platform/signup/verification.js";
import {
  initialOwnerActorStepName,
  objectStorePrefixStepName,
  PostgresOrgStore,
  PostgresPlanStore,
  PostgresTenantBootstrapSeedStore,
  PostgresTenantOwnerActorStore,
  PostgresTenantProvisioningStore,
  PostgresTenantStorageNamespaceStore,
  resolveDefaultOrgInput,
  tenantBootstrapSeedStepName,
  TenantProvisioningWorker,
  type TenantProvisioningStep,
} from "../platform/tenancy/index.js";
import {
  PostgresWebhookStore,
  TenantEnvelopeWebhookSecretResolver,
} from "../platform/webhooks/index.js";
import type { installHttp } from "./http.js";

export async function installAuth(context: Awaited<ReturnType<typeof installHttp>>) {
  const { bootEnv, app, metrics } = context;
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

  const signupOnboardingInviteTokenStore = new PostgresSignupOnboardingInviteTokenStore(sql);

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
  return {
    ...context,
    sql,
    redis,
    idempotencyStore,
    tenantApiRpsLimiter,
    tenantHourlyQuotaLimiter,
    oauthIssuer,
    oauthStore,
    agentCredentialStore,
    oauthAuthorizationStore,
    authorizationCodeService,
    mailCfg,
    identityMailTransport,
    tenantStorageSecretReader,
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
    tenantProvisioningWorker,
    planStore,
    defaultOrg,
    appPasswordStore,
    adminUsersStore,
    adminDomainsStore,
    auditStore,
    webhookSecretResolver,
    webhookStore,
    chatModerationStore,
    calendarStore,
    calendarSchedulingStore,
    calendarInvitationDeliveryStore,
    cardDavContactStore,
    assistantStore,
    outboxStore,
    eventBus,
    chatStore,
    chatRoomBus,
    chatPresence,
    meteringClient,
    meetStore,
    meetLifecycleWorker,
    betterAuthPlatform,
    sessionPolicyAuthorizer,
    meteringIngestWorker,
    meteringRollupWorker,
  };
}
