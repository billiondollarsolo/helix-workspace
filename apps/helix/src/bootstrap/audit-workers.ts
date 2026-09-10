import { envFlag } from "../bootstrap/env.js";
import { getAuditDestinationConfigs } from "../config/audit.js";
import { createAuditDestinationShipper } from "../platform/audit/destinations.js";
import { createStorageClientImmutableAuditStore } from "../platform/audit/immutable-s3.js";
import { AuditShippingWorker } from "../platform/audit/shipping-worker.js";
import { AuditVerifierWorker, PostgresAuditVerifierLease } from "../platform/audit/worker.js";
import {
  createRedisTenantDeletionCachePurger,
  PostgresTenantDeletionStore,
  TenantDeletionWorkflow,
  TenantHardDeleteWorker,
} from "../platform/tenancy/index.js";
import { OutboundWebhookWorker } from "../platform/webhooks/index.js";
import type { installMailWorkers } from "./mail-workers.js";

export async function installAuditWorkers(context: Awaited<ReturnType<typeof installMailWorkers>>) {
  const {
    bootEnv,
    app,
    metrics,
    sql,
    redis,
    tenantStorageSecretReader,
    orgStore,
    auditStore,
    webhookSecretResolver,
    webhookStore,
    eventBus,
    meteringClient,
    driveStorageResolver,
    projectedSearchEngine,
  } = context;
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
  return {
    ...context,
    outboundWebhookWorker,
    auditVerifierWorker,
    auditDestinationConfigs,
    tenantHardDeleteWorker,
    auditShippingWorkers,
  };
}
