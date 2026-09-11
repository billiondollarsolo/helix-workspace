import { KMSClient } from "@aws-sdk/client-kms";
import { readFile } from "node:fs/promises";
import { tenantMailClaims } from "../platform/mail/outbound-claims.js";
import { LocalMailTransport } from "../platform/mail/local-delivery.js";
import { MailProviderConfigurationError } from "../platform/mail/errors.js";
import {
  DispatchTimeTransportResolver,
  KmsDkimPrivateKeyProtector,
  MailDeliveryError,
  NodemailerMailTransport,
  OutboundMailDispatcher,
  OutboundMailWorker,
  parseInboundAuthenticationPolicy,
  PostgresMailDeliveryEventStore,
  PostgresMailDkimKeyStore,
  PostgresOutboundProviderStore,
  SmtpMailReceiver,
  SmtpSubmissionServer,
} from "../platform/mail/index.js";
import { OutboxWorker } from "../platform/outbox/outbox.js";
import {
  SignupOnboardingInviteEmailWorker,
  SignupVerificationEmailWorker,
} from "../platform/signup/email-delivery.js";
import { withTenantPostgresContext } from "../platform/tenancy/index.js";
import { collectBoundedBytes } from "./mail-bytes.js";
import type { installSearch } from "./search-runtime.js";

export async function installMailWorkers(context: Awaited<ReturnType<typeof installSearch>>) {
  const {
    bootEnv,
    app,
    metrics,
    sql,
    mailCfg,
    identityMailTransport,
    tenantStorageSecretReader,
    orgStore,
    domainsStore,
    appPasswordStore,
    outboxStore,
    eventBus,
    coreApps,
    dlp,
    securityTier,
    inboundMailScanners,
    mailStore,
    mailQuarantineStore,
    driveStore,
  } = context;
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
        dkimResolver: (orgId) => (from) =>
          withTenantPostgresContext(sql, { orgId }, () =>
            mailDkimKeyStore.resolveSigningKey(orgId, from),
          ),
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
        store: tenantMailClaims(sql, mailStore),
        intervalMs: bootEnv.OUTBOX_POLL_INTERVAL_MS,
        batchSize: bootEnv.OUTBOX_BATCH_SIZE,
        dispatcher: new OutboundMailDispatcher(
          mailStore,
          async (outbound) =>
            new LocalMailTransport(sql, outbound, async () => {
              if (outboundTransportResolver === undefined)
                throw new MailDeliveryError("Outbound routing is unavailable.", false);
              const decision = await withTenantPostgresContext(sql, { orgId: outbound.orgId }, () =>
                outboundTransportResolver.transportFor(
                  outbound.orgId,
                  outbound.envelope.from.address.split("@").at(-1) ?? "",
                  outbound.providerId,
                ),
              );
              const bound = await withTenantPostgresContext(sql, { orgId: outbound.orgId }, () =>
                mailStore.bindOutboundProviderDecision({
                  id: outbound.id,
                  orgId: outbound.orgId,
                  providerId: decision.providerId,
                  providerKind: decision.providerKind,
                  source: decision.source,
                  leaseToken: outbound.leaseToken,
                }),
              );
              if (bound === null)
                throw new MailProviderConfigurationError(
                  "MAIL_PROVIDER_DECISION_CONFLICT",
                  "Outbound provider binding or lease changed before dispatch.",
                );
              return decision.source === "environment" && outboundMailConfig !== undefined
                ? new NodemailerMailTransport(outboundMailConfig, (from) =>
                    withTenantPostgresContext(sql, { orgId: outbound.orgId }, () =>
                      mailDkimKeyStore.resolveSigningKey(outbound.orgId, from),
                    ),
                  )
                : decision.transport;
            }),
          {
            metrics,
            runForTenant: (orgId, operation) =>
              withTenantPostgresContext(sql, { orgId }, operation),
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
  return {
    ...context,
    outboxWorker,
    mailAppRegistered,
    mailDkimKeyStore,
    outboundProviderStore,
    mailDeliveryEventStore,
    mailSecretProvider,
    outboundMailWorker,
    signupVerificationEmailWorker,
    signupOnboardingInviteEmailWorker,
    smtpMailReceiverConfig,
    smtpMailReceiver,
    smtpSubmissionConfig,
    smtpSubmissionServer,
  };
}
