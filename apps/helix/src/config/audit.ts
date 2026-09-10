import { type AuditDestinationConfig } from "../platform/audit/destinations.js";
import {
  createHmacAuditAnchorAuthenticator,
  type ImmutableAuditObjectLockMode,
} from "../platform/audit/immutable-s3.js";
import type { SiemAuditFormat } from "../platform/audit/siem-format.js";
import type { SiemSyslogTransport } from "../platform/audit/siem-syslog.js";
import { createS3CompatibleStorage } from "../platform/storage/index.js";
import { envValueFlag } from "../platform/util/env.js";

export interface ImmutableAuditShippingConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  readonly prefix: string;
  readonly batchSize: number;
  readonly intervalMs: number;
  readonly retentionDays: number;
  readonly objectLockMode: ImmutableAuditObjectLockMode;
  readonly anchorKeyId: string;
  readonly anchorSecret: string;
}

export function getImmutableAuditShippingConfig(
  env: NodeJS.ProcessEnv,
): ImmutableAuditShippingConfig | undefined {
  if (!envValueFlag(env.AUDIT_IMMUTABLE_S3_ENABLED ?? "", false)) {
    return undefined;
  }
  const endpoint = env.AUDIT_IMMUTABLE_S3_ENDPOINT ?? env.AUDIT_S3_ENDPOINT;
  const bucket = env.AUDIT_IMMUTABLE_S3_BUCKET ?? env.AUDIT_S3_BUCKET;
  const accessKeyId =
    env.AUDIT_IMMUTABLE_S3_ACCESS_KEY ?? env.AUDIT_S3_ACCESS_KEY ?? env.RUSTFS_ACCESS_KEY;
  const secretAccessKey =
    env.AUDIT_IMMUTABLE_S3_SECRET_KEY ?? env.AUDIT_S3_SECRET_KEY ?? env.RUSTFS_SECRET_KEY;
  const anchorKeyId = env.AUDIT_IMMUTABLE_S3_ANCHOR_KEY_ID;
  const anchorSecret = env.AUDIT_IMMUTABLE_S3_ANCHOR_SECRET;
  if (endpoint === undefined || endpoint.length === 0) {
    throw new TypeError("AUDIT_IMMUTABLE_S3_ENDPOINT or AUDIT_S3_ENDPOINT is required");
  }
  if (bucket === undefined || bucket.length === 0) {
    throw new TypeError("AUDIT_IMMUTABLE_S3_BUCKET or AUDIT_S3_BUCKET is required");
  }
  if (accessKeyId === undefined || accessKeyId.length === 0) {
    throw new TypeError("AUDIT_IMMUTABLE_S3_ACCESS_KEY or AUDIT_S3_ACCESS_KEY is required");
  }
  if (secretAccessKey === undefined || secretAccessKey.length === 0) {
    throw new TypeError("AUDIT_IMMUTABLE_S3_SECRET_KEY or AUDIT_S3_SECRET_KEY is required");
  }
  if (anchorKeyId === undefined || anchorKeyId.length === 0) {
    throw new TypeError("AUDIT_IMMUTABLE_S3_ANCHOR_KEY_ID is required");
  }
  if (anchorSecret === undefined || anchorSecret.length < 32) {
    throw new TypeError("AUDIT_IMMUTABLE_S3_ANCHOR_SECRET must be at least 32 characters");
  }
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: env.AUDIT_IMMUTABLE_S3_REGION ?? env.AUDIT_S3_REGION ?? "us-east-1",
    forcePathStyle: envValueFlag(
      env.AUDIT_IMMUTABLE_S3_FORCE_PATH_STYLE ?? env.AUDIT_S3_FORCE_PATH_STYLE ?? "true",
      true,
    ),
    prefix: env.AUDIT_IMMUTABLE_S3_PREFIX ?? env.AUDIT_S3_PREFIX ?? "audit/activity",
    batchSize: Number.parseInt(env.AUDIT_IMMUTABLE_S3_BATCH_SIZE ?? "500", 10),
    intervalMs: Number.parseInt(env.AUDIT_IMMUTABLE_S3_INTERVAL_MS ?? "60000", 10),
    retentionDays: Number.parseInt(env.AUDIT_IMMUTABLE_S3_RETENTION_DAYS ?? "365", 10),
    objectLockMode: parseImmutableAuditObjectLockMode(
      env.AUDIT_IMMUTABLE_S3_OBJECT_LOCK_MODE ?? "COMPLIANCE",
    ),
    anchorKeyId,
    anchorSecret,
  };
}

function parseImmutableAuditObjectLockMode(value: string): ImmutableAuditObjectLockMode {
  if (value !== "COMPLIANCE" && value !== "GOVERNANCE") {
    throw new TypeError("AUDIT_IMMUTABLE_S3_OBJECT_LOCK_MODE must be COMPLIANCE or GOVERNANCE");
  }
  return value;
}

/**
 * Resolve every configured audit-shipping destination (Follow-up A).
 *
 * Destinations are selected by their per-destination enable flag and are
 * additive — Tier 3 ("immutable S3 + SIEM") simply enables both. The returned
 * configs are consumed by {@link createAuditDestinationShipper}:
 *
 *  - `immutable-s3`             — `AUDIT_IMMUTABLE_S3_ENABLED`
 *  - `siem-syslog`              — `AUDIT_SIEM_SYSLOG_ENABLED`
 *  - `audit-immutable-postgres` — `AUDIT_WORM_POSTGRES_ENABLED`
 */
export function getAuditDestinationConfigs(
  env: NodeJS.ProcessEnv,
): readonly AuditDestinationConfig[] {
  const configs: AuditDestinationConfig[] = [];
  const s3Config = getImmutableAuditShippingConfig(env);
  if (s3Config !== undefined) {
    const anchorAuthenticator = createHmacAuditAnchorAuthenticator(
      s3Config.anchorKeyId,
      s3Config.anchorSecret,
    );
    configs.push({
      destination: "immutable-s3",
      batchSize: s3Config.batchSize,
      intervalMs: s3Config.intervalMs,
      storage: createS3CompatibleStorage({
        endpoint: s3Config.endpoint,
        region: s3Config.region,
        bucket: s3Config.bucket,
        credentials: {
          accessKeyId: s3Config.accessKeyId,
          secretAccessKey: s3Config.secretAccessKey,
        },
        forcePathStyle: s3Config.forcePathStyle,
      }),
      prefix: s3Config.prefix,
      objectLockMode: s3Config.objectLockMode,
      retentionDays: s3Config.retentionDays,
      signer: anchorAuthenticator,
      verifier: anchorAuthenticator,
    });
  }
  if (envValueFlag(env.AUDIT_SIEM_SYSLOG_ENABLED ?? "", false)) {
    const host = env.AUDIT_SIEM_SYSLOG_HOST;
    if (host === undefined || host.length === 0) {
      throw new TypeError("AUDIT_SIEM_SYSLOG_HOST is required when AUDIT_SIEM_SYSLOG_ENABLED");
    }
    configs.push({
      destination: "siem-syslog",
      host,
      port: Number.parseInt(env.AUDIT_SIEM_SYSLOG_PORT ?? "514", 10),
      transport: parseSiemSyslogTransport(env.AUDIT_SIEM_SYSLOG_TRANSPORT ?? "tcp"),
      format: parseSiemAuditFormat(env.AUDIT_SIEM_SYSLOG_FORMAT ?? "cef"),
      ...(env.AUDIT_SIEM_SYSLOG_BATCH_SIZE === undefined
        ? {}
        : { batchSize: Number.parseInt(env.AUDIT_SIEM_SYSLOG_BATCH_SIZE, 10) }),
      ...(env.AUDIT_SIEM_SYSLOG_INTERVAL_MS === undefined
        ? {}
        : { intervalMs: Number.parseInt(env.AUDIT_SIEM_SYSLOG_INTERVAL_MS, 10) }),
      ...(env.AUDIT_SIEM_SYSLOG_FACILITY === undefined
        ? {}
        : { facility: Number.parseInt(env.AUDIT_SIEM_SYSLOG_FACILITY, 10) }),
      ...(env.AUDIT_SIEM_SYSLOG_SEVERITY === undefined
        ? {}
        : { severity: Number.parseInt(env.AUDIT_SIEM_SYSLOG_SEVERITY, 10) }),
      ...(env.AUDIT_SIEM_SYSLOG_APP_NAME === undefined
        ? {}
        : { appName: env.AUDIT_SIEM_SYSLOG_APP_NAME }),
      ...(env.AUDIT_SIEM_SYSLOG_TRANSPORT === "tls"
        ? {
            tls: {
              ...(env.AUDIT_SIEM_SYSLOG_TLS_REJECT_UNAUTHORIZED === undefined
                ? {}
                : {
                    rejectUnauthorized: envValueFlag(
                      env.AUDIT_SIEM_SYSLOG_TLS_REJECT_UNAUTHORIZED,
                      true,
                    ),
                  }),
              ...(env.AUDIT_SIEM_SYSLOG_TLS_CA === undefined
                ? {}
                : { ca: env.AUDIT_SIEM_SYSLOG_TLS_CA }),
            },
          }
        : {}),
    });
  }
  if (envValueFlag(env.AUDIT_WORM_POSTGRES_ENABLED ?? "", false)) {
    configs.push({
      destination: "audit-immutable-postgres",
      ...(env.AUDIT_WORM_POSTGRES_BATCH_SIZE === undefined
        ? {}
        : { batchSize: Number.parseInt(env.AUDIT_WORM_POSTGRES_BATCH_SIZE, 10) }),
      ...(env.AUDIT_WORM_POSTGRES_INTERVAL_MS === undefined
        ? {}
        : { intervalMs: Number.parseInt(env.AUDIT_WORM_POSTGRES_INTERVAL_MS, 10) }),
    });
  }
  return configs;
}

function parseSiemSyslogTransport(value: string): SiemSyslogTransport {
  if (value !== "tcp" && value !== "tls" && value !== "udp") {
    throw new TypeError("AUDIT_SIEM_SYSLOG_TRANSPORT must be tcp, tls, or udp");
  }
  return value;
}

function parseSiemAuditFormat(value: string): SiemAuditFormat {
  if (value !== "cef" && value !== "leef") {
    throw new TypeError("AUDIT_SIEM_SYSLOG_FORMAT must be cef or leef");
  }
  return value;
}
