import { envFlag, parseS3ServerSideEncryption } from "../bootstrap/env.js";
import { PostgresChatAttachmentStore } from "../platform/chat/index.js";
import { loadDriveConfig } from "../platform/drive/config.js";
import {
  createClamAvVirusScanner,
  DriveVirusScanRetryWorker,
  PostgresDriveStore,
  PostgresDriveWorkflowStore,
} from "../platform/drive/index.js";
import {
  ClamavScanner,
  createBetaSpamSecondPass,
  MailAttachmentCleanupWorker,
  MailTrashPurgeWorker,
  PostgresMailAttachmentIngestor,
  PostgresMailQuarantineStore,
  PostgresMailStore,
  PostgresMailTrashPurger,
  SpamdScanner,
} from "../platform/mail/index.js";
import {
  ByoStorageHealthWorker,
  createDefaultTenantStorageResolver,
  createS3CompatibleStorage,
  createTenantStorageMigrationPairResolver,
  createTenantStorageResolver,
  PostgresTenantStorageMigrationJobStore,
  resolveTenantStorageSnapshot,
  TenantStorageMigrationWorker,
} from "../platform/storage/index.js";
import type { installApps } from "./apps.js";

export async function installStorage(context: Awaited<ReturnType<typeof installApps>>) {
  const {
    bootEnv,
    app,
    metrics,
    sql,
    mailCfg,
    tenantStorageSecretReader,
    orgStore,
    eventBus,
    coreApps,
    dlp,
    securityTier,
  } = context;
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
      "RUSTFS_ENDPOINT (and RUSTFS_API_PORT) unset; tenant storage writes (mail and drive) will fail. Set RUSTFS_ENDPOINT=http://localhost:28437 or run docker-compose up rustfs.",
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
  return {
    ...context,
    driveConfig,
    clamavScanner,
    inboundMailScanners,
    driveStorage,
    driveStorageResolver,
    tenantStorageMigrationJobStore,
    tenantStorageMigrationWorker,
    byoStorageHealthWorker,
    mailAttachmentCleanupWorker,
    mailTrashPurgeWorker,
    mailStore,
    mailQuarantineStore,
    driveStore,
    driveWorkflowStore,
    chatAttachmentStore,
    driveVirusScanRetryWorker,
  };
}
