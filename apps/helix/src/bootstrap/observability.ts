import { listPendingMigrations } from "../db/migration-runner.js";
import { resolvePlatformMigrationSources } from "../db/migration-sources.js";
import { tierDefaults } from "../platform/config/tier.js";
import { NatsEventBus } from "../platform/events/nats-event-bus.js";
import type { installWorkers } from "./workers.js";

export async function installObservability(context: Awaited<ReturnType<typeof installWorkers>>) {
  const {
    bootEnv,
    app,
    metrics,
    sql,
    redis,
    betterAuthConfig,
    betterAuthRuntime,
    eventBus,
    coreApps,
    securityTier,
    driveConfig,
    clamavScanner,
    driveStorage,
    searchEngine,
    auditVerifierWorker,
    auditDestinationConfigs,
    auditShippingWorkers,
    readinessProbes,
    workerSupervisors,
  } = context;
  const migrationSources = await resolvePlatformMigrationSources();

  readinessProbes.push(
    {
      id: "database",
      check: async () => {
        await sql`select 1`;
      },
    },
    {
      id: "migrations",
      check: async () => {
        if ((await listPendingMigrations(sql, migrationSources)).length > 0) {
          throw new Error("pending database migrations");
        }
      },
    },
    {
      id: "workers",
      check: async () => {
        if (workerSupervisors.some((supervisor) => !supervisor.isHealthy)) {
          throw new Error("a required worker supervisor is unhealthy");
        }
      },
    },
  );

  const registeredApps = new Set<string>(coreApps.registeredAppIds());

  const storageRequired = ["mail", "drive"].some((id) => registeredApps.has(id));

  if (storageRequired) {
    readinessProbes.push({
      id: "object-storage",
      check: async () => {
        if (driveStorage === undefined) {
          throw new Error("object storage is not configured");
        }
        await driveStorage.checkHealth();
      },
    });
  }

  const distributedServicesRequired = securityTier !== "personal";

  if (distributedServicesRequired || redis !== undefined) {
    readinessProbes.push({
      id: "redis",
      check: async () => {
        if (redis === undefined) {
          throw new Error("Redis is unavailable");
        }
        await redis.ping();
      },
    });
  }

  if (distributedServicesRequired || bootEnv.NATS_URL !== undefined) {
    readinessProbes.push({
      id: "event-queue",
      check: async () => {
        if (!(eventBus instanceof NatsEventBus)) {
          throw new Error("a durable event queue is not configured");
        }
        await eventBus.checkHealth();
      },
    });
  }

  const productionServiceRequired = bootEnv.NODE_ENV === "production";

  if (productionServiceRequired || distributedServicesRequired || searchEngine !== undefined) {
    readinessProbes.push({
      id: "search",
      check: async () => {
        if (searchEngine === undefined) {
          throw new Error("search is not configured");
        }
        await searchEngine.search({
          query: "",
          limit: 1,
          filter: 'attributes.orgId = "__helix_readiness__"',
        });
      },
    });
  }

  if (productionServiceRequired || distributedServicesRequired) {
    readinessProbes.push({
      id: "identity-keys",
      check: async () => {
        if (betterAuthRuntime === undefined || betterAuthConfig === undefined) {
          throw new Error("session identity keys are not configured");
        }
      },
    });
  }

  if (
    (registeredApps.has("mail") || registeredApps.has("drive") || registeredApps.has("chat")) &&
    (productionServiceRequired || distributedServicesRequired)
  ) {
    readinessProbes.push({
      id: "antivirus",
      check: async () => {
        if (clamavScanner === undefined) {
          throw new Error("antivirus is not configured");
        }
        await clamavScanner.checkReadiness({
          maxSignatureAgeMs: driveConfig.antivirus.maxSignatureAgeMs,
        });
      },
    });
  }

  if (tierDefaults[securityTier].auditHashChain) {
    const configuredDestinations = new Set<string>(
      auditDestinationConfigs.map((config) => config.destination),
    );
    const requiredDestinations = tierDefaults[securityTier].auditDestinations
      .filter((destination) => destination !== "postgres")
      .map((destination) =>
        destination === "siem"
          ? "siem-syslog"
          : destination === "worm"
            ? "audit-immutable-postgres"
            : destination,
      );
    readinessProbes.push({
      id: "audit",
      check: async () => {
        const shippingWorkersHealthy = auditShippingWorkers.every(({ name, worker }) => {
          const supervisor = workerSupervisors.find((candidate) => candidate.name === name);
          return (
            supervisor !== undefined &&
            supervisor.isHealthy &&
            (!supervisor.isLeader || worker.isHealthy)
          );
        });
        if (
          auditVerifierWorker === undefined ||
          !auditVerifierWorker.isHealthy ||
          !shippingWorkersHealthy ||
          requiredDestinations.some((destination) => !configuredDestinations.has(destination))
        ) {
          throw new Error("a required audit worker is not configured");
        }
      },
    });
  }

  app.get("/metrics", async (_request, reply) => {
    reply.header("content-type", metrics.registry.contentType);
    return metrics.registry.metrics();
  });
  return { ...context };
}
