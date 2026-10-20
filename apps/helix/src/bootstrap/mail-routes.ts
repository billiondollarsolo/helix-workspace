import { registerMailProviderAdminRoutes } from "../platform/mail/provider-admin-routes.js";
import { runtimeEnvironment } from "../config/env.js";
import { resolveTxt } from "node:dns/promises";
import {
  detachedFromTenantPostgresContext,
  withTenantPostgresContext,
} from "../platform/tenancy/index.js";
import type { installTools } from "./tools.js";
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
import { registerMailDecisionAdminRoutes } from "../platform/mail/decision/admin-routes.js";
import { buildDecisionModelReport } from "../platform/mail/decision/report.js";

export async function installMailRoutes(context: Awaited<ReturnType<typeof installTools>>) {
  const {
    app,
    coreApps,
    sql,
    actorFromAuthenticatedRequest,
    auditStore,
    mailStore,
    mailProviderCredentials,
    mailSecretProvider,
    domainsStore,
    mailDkimKeyStore,
    mailQuarantineStore,
    inboundMailScanners,
    mailDeliveryEventStore,
    mailDecisionStore,
    orgStore,
    spamdScanner,
    outboundProviderStore,
  } = context;
  if (coreApps.shouldRegister("mail")) {
    await registerMailAdminRoutes(app, {
      checkSystemRelay: async () =>
        (await context.identityMailTransport?.verifyConnection()) ?? false,
      auditSink: auditStore,
      service: new MailAdminStatusService({
        env: runtimeEnvironment(),
        deliveryHealthStore: mailStore,
      }),
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
    });
    await registerMailProviderAdminRoutes(app, {
      providers: new PostgresOutboundProviderStore(sql),
      credentials: mailProviderCredentials,
      secrets: mailSecretProvider,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      auditSink: auditStore,
    });
    await registerMailDeliveryAdminRoutes(app, {
      credentials: mailProviderCredentials,
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
      runForTenant: (orgId, operation) =>
        detachedFromTenantPostgresContext(() =>
          withTenantPostgresContext(sql, { orgId }, async () => operation()),
        ),
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      auditSink: auditStore,
    });
    registerOutboundMailAdminRoutes(app, {
      store: mailStore,
      deliveryStore: mailDeliveryEventStore,
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      auditSink: auditStore,
    });
    registerMailDecisionAdminRoutes(app, {
      store: mailDecisionStore,
      orgs: orgStore,
      buildReport: (input) => buildDecisionModelReport(sql, input),
      actorFromRequest: (request) => actorFromAuthenticatedRequest(request),
      auditSink: auditStore,
      spamd: spamdScanner,
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
}
