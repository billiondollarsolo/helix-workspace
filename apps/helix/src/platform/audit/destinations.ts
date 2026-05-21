import type postgres from "postgres";
import type { StorageClient } from "@helix/sdk";
import {
  shipImmutableAuditBatch,
  type ImmutableAuditObjectLockMode,
} from "./immutable-s3.js";
import type { AuditBatchShipper } from "./shipping-worker.js";
import { PostgresWormAuditShipper } from "./immutable-postgres.js";
import {
  SiemAuditShipper,
  type SiemSyslogTlsOptions,
  type SiemSyslogTransport,
} from "./siem-syslog.js";
import type { SiemAuditFormat } from "./siem-format.js";

/**
 * Unified audit-destination selection.
 *
 * The `AuditShippingWorker` ships to whatever {@link AuditBatchShipper} it is
 * given. This module makes the three production destinations selectable from a
 * single config value so server.ts can register any of them without bespoke
 * wiring per destination:
 *
 *  - `immutable-s3`           — {@link shipImmutableAuditBatch} (S3 Object-Lock)
 *  - `siem-syslog`            — {@link SiemAuditShipper} (CEF/LEEF over syslog)
 *  - `audit-immutable-postgres` — {@link PostgresWormAuditShipper} (WORM table)
 *
 * server.ts wiring (do NOT edit server.ts here — register later):
 *
 * ```ts
 * import {
 *   createAuditDestinationShipper,
 *   type AuditDestinationConfig,
 * } from "./platform/audit/destinations.js";
 * import { AuditShippingWorker } from "./platform/audit/shipping-worker.js";
 *
 * // auditDestinationConfig is read from platform config; one entry per
 * // configured destination. Each worker is started under LeaderElection and
 * // stopped in the graceful-shutdown drain, exactly like the S3 worker today.
 * const auditDestinationWorkers = auditDestinationConfigs.map((config) =>
 *   new AuditShippingWorker({
 *     store: auditStore,
 *     destination: config.destination,
 *     batchSize: config.batchSize,
 *     intervalMs: config.intervalMs,
 *     shipper: createAuditDestinationShipper(config, { sql }),
 *     onResult: (result) => {
 *       if (result.status === "shipped") {
 *         metrics.recordAuditShipping({
 *           destination: result.destination,
 *           recordCount: result.shippedRecordCount,
 *           lagSeconds: result.lagSeconds,
 *         });
 *       }
 *     },
 *   }),
 * );
 * for (const worker of auditDestinationWorkers) {
 *   worker.start(); // gate with LeaderElection like the other singleton workers
 * }
 * // ...in the graceful-shutdown drain:
 * await Promise.all(auditDestinationWorkers.map((worker) => worker.stop()));
 * ```
 */

export type AuditDestinationKind =
  | "immutable-s3"
  | "siem-syslog"
  | "audit-immutable-postgres";

export interface ImmutableS3AuditDestinationConfig {
  readonly destination: "immutable-s3";
  readonly batchSize?: number;
  readonly intervalMs?: number;
  readonly storage: StorageClient;
  readonly prefix?: string;
  readonly objectLockMode?: ImmutableAuditObjectLockMode;
  readonly retentionDays?: number;
}

export interface SiemSyslogAuditDestinationConfig {
  readonly destination: "siem-syslog";
  readonly batchSize?: number;
  readonly intervalMs?: number;
  readonly host: string;
  readonly port: number;
  readonly transport: SiemSyslogTransport;
  readonly format: SiemAuditFormat;
  readonly facility?: number;
  readonly severity?: number;
  readonly appName?: string;
  readonly tls?: SiemSyslogTlsOptions;
}

export interface WormPostgresAuditDestinationConfig {
  readonly destination: "audit-immutable-postgres";
  readonly batchSize?: number;
  readonly intervalMs?: number;
}

export type AuditDestinationConfig =
  | ImmutableS3AuditDestinationConfig
  | SiemSyslogAuditDestinationConfig
  | WormPostgresAuditDestinationConfig;

export interface AuditDestinationDependencies {
  /** Required for the `audit-immutable-postgres` destination. */
  readonly sql?: postgres.Sql;
}

/**
 * Build the {@link AuditBatchShipper} for a configured audit destination.
 *
 * @throws TypeError when the config references a destination whose required
 *   dependency (e.g. a Postgres client) was not provided.
 */
export function createAuditDestinationShipper(
  config: AuditDestinationConfig,
  dependencies: AuditDestinationDependencies = {},
): AuditBatchShipper {
  switch (config.destination) {
    case "immutable-s3":
      return {
        ship: (records) =>
          shipImmutableAuditBatch(
            {
              store: config.storage,
              ...(config.prefix === undefined ? {} : { prefix: config.prefix }),
              ...(config.batchSize === undefined ? {} : { batchSize: config.batchSize }),
              ...(config.objectLockMode === undefined
                ? {}
                : { objectLockMode: config.objectLockMode }),
              ...(config.retentionDays === undefined
                ? {}
                : { retentionDays: config.retentionDays }),
            },
            records,
          ),
      };
    case "siem-syslog":
      return new SiemAuditShipper({
        host: config.host,
        port: config.port,
        transport: config.transport,
        format: config.format,
        ...(config.facility === undefined ? {} : { facility: config.facility }),
        ...(config.severity === undefined ? {} : { severity: config.severity }),
        ...(config.appName === undefined ? {} : { appName: config.appName }),
        ...(config.tls === undefined ? {} : { tls: config.tls }),
      });
    case "audit-immutable-postgres": {
      if (dependencies.sql === undefined) {
        throw new TypeError(
          "audit-immutable-postgres destination requires a Postgres client (dependencies.sql)",
        );
      }
      return new PostgresWormAuditShipper(dependencies.sql);
    }
    default: {
      const exhaustive: never = config;
      throw new TypeError(
        `Unknown audit destination: ${(exhaustive as { destination: string }).destination}`,
      );
    }
  }
}

/** All audit destinations that can be selected for the `AuditShippingWorker`. */
export const auditDestinationKinds: readonly AuditDestinationKind[] = [
  "immutable-s3",
  "siem-syslog",
  "audit-immutable-postgres",
];
