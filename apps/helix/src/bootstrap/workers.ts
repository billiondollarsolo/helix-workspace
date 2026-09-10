import { loadHelixConfig, subscribeToConfigHotReload } from "../platform/config/loader.js";
import {
  LeaderElection,
  PostgresAdvisoryLockClient,
  SingletonWorkerSupervisor,
} from "../platform/leader/election.js";
import type { installRoutes } from "./routes.js";

export async function installWorkers(context: Awaited<ReturnType<typeof installRoutes>>) {
  const {
    bootEnv,
    app,
    sql,
    redis,
    betterAuthRuntime,
    tenantProvisioningWorker,
    eventBus,
    meetLifecycleWorker,
    meteringIngestWorker,
    meteringRollupWorker,
    configSources,
    runtimeConfiguration,
    chatRetentionWorker,
    tenantStorageMigrationWorker,
    byoStorageHealthWorker,
    mailAttachmentCleanupWorker,
    mailTrashPurgeWorker,
    driveVirusScanRetryWorker,
    searchEventIndexer,
    searchMutationWorker,
    searchShadowReindexWorker,
    searchReconciliationWorker,
    enrichmentWorker,
    outboxWorker,
    outboundMailWorker,
    signupVerificationEmailWorker,
    signupOnboardingInviteEmailWorker,
    smtpMailReceiverConfig,
    smtpMailReceiver,
    smtpSubmissionConfig,
    smtpSubmissionServer,
    outboundWebhookWorker,
    auditVerifierWorker,
    tenantHardDeleteWorker,
    auditShippingWorkers,
    pendingActionExpiryWorker,
    calendarInvitationDeliveryWorker,
    leaderGatedWorkers,
    chatRoutes,
  } = context;
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

  // P2-4: wire config hot-reload. `subscribeToConfigHotReload` was implemented
  // and tested but never called — without this, NATS-published config changes
  // (`helix.config.changed`, emitted by the platform-config admin API) had no
  // runtime effect. On each change the config is re-merged from the same
  // sources and the runtime holder is swapped so runtime readers observe it.
  const unsubscribeConfigHotReload = await subscribeToConfigHotReload({
    events: eventBus,
    reload: () => loadHelixConfig(configSources),
    onReload: (config) => {
      runtimeConfiguration.current = config;
      void import("../platform/ai/operator-settings.js").then(
        ({ applyOperatorAiFromHelixConfig }) => {
          applyOperatorAiFromHelixConfig(config);
        },
      );
      app.log.info({ tier: config.security.tier }, "Applied hot-reloaded platform configuration");
    },
  });

  app.addHook("onClose", async () => {
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
  return { ...context, workerSupervisors };
}
