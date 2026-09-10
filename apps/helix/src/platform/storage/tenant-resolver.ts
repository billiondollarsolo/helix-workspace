import type { JsonObject, StorageClient, StorageObject } from "@helix/sdk-types";
import { createHash } from "node:crypto";
import { assertStorageRegion } from "../tenancy/residency.js";
import { hasControlCharacter } from "../util/strings.js";
import type { S3CompatibleObjectEvidence } from "./s3-compatible.js";
import {
  createS3CompatibleStorage,
  type S3CompatibleCredentials,
  type S3CompatibleStorageConfig,
} from "./s3-compatible.js";

export interface TenantStorageClient extends StorageClient {
  headObject?(key: string): Promise<S3CompatibleObjectEvidence | null>;
  copyObject?(sourceKey: string, destinationKey: string): Promise<void>;
  checkHealth?(): Promise<void>;
  listKeys?(prefix: string): AsyncIterable<string>;
  presignGetUrl?(
    key: string,
    options?: {
      readonly expiresSeconds?: number;
      readonly contentType?: string;
      readonly metadata?: Record<string, string>;
    },
  ): Promise<string>;
  presignPutUrl?(
    key: string,
    options?: {
      readonly expiresSeconds?: number;
      readonly contentType?: string;
      readonly metadata?: Record<string, string>;
    },
  ): Promise<string>;
  presignPutRequest?(
    key: string,
    options?: {
      readonly expiresSeconds?: number;
      readonly contentType?: string;
      readonly metadata?: Record<string, string>;
    },
  ): Promise<TenantPresignedPutUpload>;
  createMultipartUpload?(
    key: string,
    options?: { readonly contentType?: string; readonly metadata?: Record<string, string> },
  ): Promise<{ readonly uploadId: string }>;
  presignUploadPart?(
    key: string,
    uploadId: string,
    partNumber: number,
    options?: { readonly contentType?: string; readonly expiresSeconds?: number },
  ): Promise<string>;
  completeMultipartUpload?(
    key: string,
    uploadId: string,
    parts: readonly { readonly partNumber: number; readonly etag: string }[],
  ): Promise<void>;
  abortMultipartUpload?(key: string, uploadId: string): Promise<void>;
}

export interface TenantPresignedPutUpload {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export interface ResolvedTenantStorage {
  readonly client: TenantStorageClient;
  readonly managedBy: "helix-default" | "byo";
  readonly prefix: string;
  readonly region?: string;
  /** Encryption mode enforced by every object write for this resolved client. */
  readonly encryptionAtRest?: "AES256" | "aws:kms" | undefined;
}

export interface TenantStorageStateSnapshot {
  readonly managedBy: "helix-default" | "byo";
  readonly storage: JsonObject | null;
}

export interface TenantStorageSecretReader {
  read(input: {
    readonly orgId: string;
    readonly scope: "byo-storage" | "mail-provider";
    readonly handle: string;
  }): Promise<Record<string, string> | undefined>;
  deleteTenantSecrets?(input: { readonly orgId: string }): Promise<number>;
}

interface VersionedTenantStorageSecret {
  readonly value: Record<string, string>;
  /** Backend version, not secret material; changes atomically when credentials rotate. */
  readonly version: string;
}

export interface TenantStoragePoolMetrics {
  setStoragePoolSize(input: { readonly size: number }): void;
  recordStoragePoolEviction(): void;
}

export type TenantStorageResolver = (input: {
  readonly orgId: string;
  readonly refresh?: boolean;
}) => Promise<ResolvedTenantStorage | undefined> | ResolvedTenantStorage | undefined;

export function createTenantStorageResolver(options: {
  readonly defaultClient: TenantStorageClient | undefined;
  readonly defaultServerSideEncryption?: "AES256" | "aws:kms" | undefined;
  readonly loadByoConfig: (
    orgId: string,
  ) => Promise<JsonObject | undefined> | JsonObject | undefined;
  readonly secretReader?: TenantStorageSecretReader | undefined;
  readonly createS3Client?: (config: S3CompatibleStorageConfig) => TenantStorageClient;
  readonly cacheMaxEntries?: number | undefined;
  readonly cacheIdleTtlMs?: number | undefined;
  readonly secretRefreshIntervalMs?: number | undefined;
  readonly cacheNow?: (() => number) | undefined;
  readonly metrics?: TenantStoragePoolMetrics | undefined;
  readonly deploymentRegion?: string | undefined;
}): TenantStorageResolver {
  const now = options.cacheNow ?? Date.now;
  const maxEntries = options.cacheMaxEntries ?? 100;
  const secretRefreshIntervalMs = options.secretRefreshIntervalMs ?? 60_000;
  const secrets = new Map<
    string,
    { readonly value: VersionedTenantStorageSecret; readonly expiresAt: number }
  >();
  const cache = new TenantStorageResolutionCache({
    maxEntries,
    idleTtlMs: options.cacheIdleTtlMs ?? 60 * 60 * 1000,
    now,
    metrics: options.metrics,
  });
  return async ({ orgId, refresh = false }) => {
    const storageConfig = storageConfigFromByo(await options.loadByoConfig(orgId), orgId);
    if (storageConfig === undefined) return undefined;
    if (storageConfig.kind === "byo" && options.deploymentRegion !== undefined) {
      assertStorageRegion(storageConfig.region, options.deploymentRegion);
      assertRegionalKmsKey(storageConfig.serverSideEncryptionAwsKmsKeyId, options.deploymentRegion);
    }
    let secret: VersionedTenantStorageSecret | undefined;
    if (storageConfig.kind === "byo") {
      const secretKey = `${orgId}:${storageConfig.credentialsSecretHandle}`;
      const cachedSecret = secrets.get(secretKey);
      if (!refresh && cachedSecret !== undefined && cachedSecret.expiresAt > now()) {
        secret = cachedSecret.value;
      } else {
        secret = await readByoStorageSecret(storageConfig, options.secretReader);
        secrets.delete(secretKey);
        secrets.set(secretKey, { value: secret, expiresAt: now() + secretRefreshIntervalMs });
        while (secrets.size > maxEntries) {
          const oldest = secrets.keys().next().value;
          if (oldest === undefined) break;
          secrets.delete(oldest);
        }
      }
    }
    const cacheKey = storageResolutionCacheKey(orgId, storageConfig, secret?.version);
    if (!refresh) {
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }
    let resolved: ResolvedTenantStorage | undefined;
    if (storageConfig.kind === "byo") {
      if (secret === undefined) throw new Error("BYO storage credentials were not resolved.");
      const client = createByoS3StorageClient(storageConfig, secret, options.createS3Client);
      resolved = {
        client: createPrefixedStorageClient(client, storageConfig.prefix),
        managedBy: "byo",
        prefix: storageConfig.prefix,
        region: storageConfig.region,
        encryptionAtRest: storageConfig.serverSideEncryption,
      };
      cache.set(cacheKey, resolved);
      return resolved;
    }
    if (options.defaultClient === undefined) {
      return undefined;
    }
    resolved = {
      client: createPrefixedStorageClient(options.defaultClient, storageConfig.prefix),
      managedBy: "helix-default",
      prefix: storageConfig.prefix,
      ...(options.deploymentRegion === undefined ? {} : { region: options.deploymentRegion }),
      ...(options.defaultServerSideEncryption === undefined
        ? {}
        : { encryptionAtRest: options.defaultServerSideEncryption }),
    };
    cache.set(cacheKey, resolved);
    return resolved;
  };
}

export function createDefaultTenantStorageResolver(
  client: TenantStorageClient | undefined,
  options: {
    readonly prefixForOrg?: (orgId: string) => string;
    readonly serverSideEncryption?: "AES256" | "aws:kms";
    readonly region?: string;
  } = {},
): TenantStorageResolver {
  if (client === undefined) {
    return () => undefined;
  }
  const prefixForOrg = options.prefixForOrg ?? defaultTenantStoragePrefix;
  return ({ orgId }) => {
    const prefix = normalizePrefix(prefixForOrg(orgId));
    return {
      client: createPrefixedStorageClient(client, prefix),
      managedBy: "helix-default",
      prefix,
      ...(options.region === undefined ? {} : { region: options.region }),
      ...(options.serverSideEncryption === undefined
        ? {}
        : { encryptionAtRest: options.serverSideEncryption }),
    };
  };
}

export async function resolveTenantStorageSnapshot(input: {
  readonly orgId: string;
  readonly state: TenantStorageStateSnapshot;
  readonly defaultClient: TenantStorageClient | undefined;
  readonly secretReader?: TenantStorageSecretReader | undefined;
  readonly createS3Client?: (config: S3CompatibleStorageConfig) => TenantStorageClient;
  readonly deploymentRegion?: string | undefined;
}): Promise<ResolvedTenantStorage | undefined> {
  if (input.state.managedBy === "helix-default") {
    const storage = readRecord(input.state.storage);
    if (storage !== undefined && storage.kind !== "helix-default") {
      throw new Error("Helix-default storage snapshot must use kind helix-default.");
    }
    if (input.defaultClient === undefined) {
      return undefined;
    }
    const prefix = normalizePrefix(
      readString(storage?.prefix) ?? defaultTenantStoragePrefix(input.orgId),
    );
    return {
      client: createPrefixedStorageClient(input.defaultClient, prefix),
      managedBy: "helix-default",
      prefix,
      ...(input.deploymentRegion === undefined ? {} : { region: input.deploymentRegion }),
    };
  }

  const storageConfig =
    input.state.storage === null
      ? undefined
      : storageConfigFromByo({ storage: input.state.storage }, input.orgId);
  if (storageConfig === undefined || storageConfig.kind !== "byo") {
    throw new Error("BYO storage snapshot must use kind byo.");
  }
  if (input.deploymentRegion !== undefined) {
    assertStorageRegion(storageConfig.region, input.deploymentRegion);
    assertRegionalKmsKey(storageConfig.serverSideEncryptionAwsKmsKeyId, input.deploymentRegion);
  }
  const secret = await readByoStorageSecret(storageConfig, input.secretReader);
  const client = createByoS3StorageClient(storageConfig, secret, input.createS3Client);
  return {
    client: createPrefixedStorageClient(client, storageConfig.prefix),
    managedBy: "byo",
    prefix: storageConfig.prefix,
    region: storageConfig.region,
  };
}

export function defaultTenantStoragePrefix(orgId: string): string {
  return `tenants/${orgId}/`;
}

function storageConfigFromByo(
  byoConfig: JsonObject | undefined,
  orgId: string,
):
  | { readonly kind: "helix-default"; readonly prefix: string }
  | {
      readonly kind: "byo";
      readonly provider: "aws-s3" | "r2" | "s3-compatible";
      readonly endpoint: string;
      readonly region: string;
      readonly bucket: string;
      readonly prefix: string;
      readonly orgId: string;
      readonly credentialsSecretHandle: string;
      readonly forcePathStyle: boolean;
      readonly serverSideEncryption: "aws:kms";
      readonly serverSideEncryptionAwsKmsKeyId: string;
      readonly securityPolicy: {
        readonly requireTls: true;
        readonly requireVersioning: true;
        readonly objectLock: {
          readonly mode: "COMPLIANCE" | "GOVERNANCE";
          readonly retentionDays: number;
        };
      };
    }
  | undefined {
  const storage = readRecord(byoConfig?.storage);
  if (storage === undefined) {
    return undefined;
  }
  if (storage.kind === "helix-default") {
    return {
      kind: "helix-default",
      prefix: normalizePrefix(readString(storage.prefix) ?? ""),
    };
  }
  if (storage.kind === "byo") {
    const provider = readString(storage.provider);
    if (provider !== "aws-s3" && provider !== "r2" && provider !== "s3-compatible") {
      throw new Error("BYO storage provider must be aws-s3, r2, or s3-compatible.");
    }
    const bucket = readRequiredString(storage.bucket, "BYO storage bucket is required.");
    const credentialsSecretHandle = readSecretHandle(
      storage.credentials_secret_handle,
      "BYO storage credentials_secret_handle is required.",
    );
    return {
      kind: "byo",
      provider,
      endpoint: secureEndpointForProvider(provider, readString(storage.endpoint)),
      region: readRequiredString(storage.region, "BYO storage region is required."),
      bucket,
      prefix: normalizePrefix(
        readString(storage.prefix)?.trim() || defaultTenantStoragePrefix(orgId),
      ),
      orgId,
      credentialsSecretHandle,
      forcePathStyle: readBoolean(storage.force_path_style) ?? provider !== "aws-s3",
      ...serverSideEncryptionFromStorageConfig(storage),
      securityPolicy: securityPolicyFromStorageConfig(storage),
    };
  }
  return undefined;
}

function createByoS3StorageClient(
  config: Exclude<
    ReturnType<typeof storageConfigFromByo>,
    undefined | { readonly kind: "helix-default" }
  >,
  secret: VersionedTenantStorageSecret,
  createS3Client: ((config: S3CompatibleStorageConfig) => TenantStorageClient) | undefined,
): TenantStorageClient {
  return (createS3Client ?? createS3CompatibleStorage)({
    endpoint: config.endpoint,
    region: config.region,
    bucket: config.bucket,
    credentials: s3CredentialsFromSecret(secret.value),
    forcePathStyle: config.forcePathStyle,
    serverSideEncryption: config.serverSideEncryption,
    serverSideEncryptionAwsKmsKeyId: config.serverSideEncryptionAwsKmsKeyId,
    securityPolicy: config.securityPolicy,
  });
}

function serverSideEncryptionFromStorageConfig(storage: Record<string, unknown>): {
  readonly serverSideEncryption: "aws:kms";
  readonly serverSideEncryptionAwsKmsKeyId: string;
} {
  const encryption = readRecord(storage.encryption);
  const kmsKeyId = readString(encryption?.sse_kms_key_arn)?.trim();
  if (kmsKeyId === undefined || kmsKeyId.length === 0) {
    throw new Error("BYO storage requires an SSE-KMS key.");
  }
  return {
    serverSideEncryption: "aws:kms",
    serverSideEncryptionAwsKmsKeyId: kmsKeyId,
  };
}

function assertRegionalKmsKey(keyId: string, region: string): void {
  if (!keyId.startsWith("arn:")) return;
  if (keyId.split(":")[3] !== region) {
    throw new Error(`BYO storage KMS key is outside tenant region '${region}'.`);
  }
}

function securityPolicyFromStorageConfig(storage: Record<string, unknown>) {
  const lifecycle = readRecord(storage.lifecycle);
  const rawMode = readString(lifecycle?.object_lock)?.toUpperCase();
  const retentionDays = lifecycle?.retention_days;
  if (
    (rawMode !== "GOVERNANCE" && rawMode !== "COMPLIANCE") ||
    !Number.isSafeInteger(retentionDays) ||
    (retentionDays as number) < 1
  ) {
    throw new Error(
      "BYO storage requires governance or compliance object lock with retention_days.",
    );
  }
  const mode: "GOVERNANCE" | "COMPLIANCE" = rawMode;
  return {
    requireTls: true as const,
    requireVersioning: true as const,
    objectLock: { mode, retentionDays: retentionDays as number },
  };
}

function secureEndpointForProvider(
  provider: "aws-s3" | "r2" | "s3-compatible",
  endpoint: string | undefined,
): string {
  if (endpoint !== undefined && endpoint.length > 0) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:") throw new Error("BYO storage endpoint must use HTTPS.");
    return url.toString().replace(/\/$/u, "");
  }
  if (provider === "aws-s3") {
    return "https://s3.amazonaws.com";
  }
  throw new Error("BYO storage endpoint is required for this provider.");
}

async function readByoStorageSecret(
  config: Exclude<
    ReturnType<typeof storageConfigFromByo>,
    undefined | { readonly kind: "helix-default" }
  >,
  reader: TenantStorageSecretReader | undefined,
): Promise<VersionedTenantStorageSecret> {
  if (reader === undefined) throw new Error("BYO storage secret reader is not configured.");
  const secret = await reader.read({
    orgId: config.orgId,
    scope: "byo-storage",
    handle: config.credentialsSecretHandle,
  });
  if (secret === undefined) throw new Error("BYO storage credentials were not found.");
  return {
    value: secret,
    version: createHash("sha256")
      .update(
        JSON.stringify(Object.entries(secret).sort(([left], [right]) => left.localeCompare(right))),
      )
      .digest("hex"),
  };
}

function s3CredentialsFromSecret(secret: Record<string, string>): S3CompatibleCredentials {
  const accessKeyId = secret.accessKeyId ?? secret.access_key_id ?? secret.AWS_ACCESS_KEY_ID;
  const secretAccessKey =
    secret.secretAccessKey ?? secret.secret_access_key ?? secret.AWS_SECRET_ACCESS_KEY;
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error("BYO storage credentials must include accessKeyId and secretAccessKey.");
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(secret.sessionToken === undefined && secret.AWS_SESSION_TOKEN === undefined
      ? {}
      : { sessionToken: secret.sessionToken ?? secret.AWS_SESSION_TOKEN }),
  };
}

function readSecretHandle(value: unknown, message: string): string {
  const handle = readRequiredString(value, message).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/u.test(handle)) {
    throw new Error("Secret handle must be a canonical 1-100 character identifier.");
  }
  return handle;
}

export function createPrefixedStorageClient(
  client: TenantStorageClient,
  prefix: string,
): TenantStorageClient {
  const normalizedPrefix = normalizePrefix(prefix);
  const presignGetUrl = client.presignGetUrl?.bind(client);
  const presignPutUrl = client.presignPutUrl?.bind(client);
  const presignPutRequest = client.presignPutRequest?.bind(client);
  const headObject = client.headObject?.bind(client);
  const copyObject = client.copyObject?.bind(client);
  const head = client.head?.bind(client);
  const getStream = client.getStream?.bind(client);
  const getRange = client.getRange?.bind(client);
  const copy = client.copy?.bind(client);
  const listKeys = client.listKeys?.bind(client);
  const createMultipartUpload = client.createMultipartUpload?.bind(client);
  const presignUploadPart = client.presignUploadPart?.bind(client);
  const completeMultipartUpload = client.completeMultipartUpload?.bind(client);
  const abortMultipartUpload = client.abortMultipartUpload?.bind(client);
  const checkHealth = client.checkHealth?.bind(client);
  return {
    async put(object: StorageObject): Promise<void> {
      await client.put({ ...object, key: prefixedKey(normalizedPrefix, object.key) });
    },
    async get(key: string): Promise<StorageObject | null> {
      const object = await client.get(prefixedKey(normalizedPrefix, key));
      if (object === null) {
        return null;
      }
      return {
        ...object,
        key,
      };
    },
    async delete(key: string): Promise<void> {
      await client.delete(prefixedKey(normalizedPrefix, key));
    },
    ...(headObject === undefined
      ? {}
      : {
          headObject(key: string) {
            return headObject(prefixedKey(normalizedPrefix, key));
          },
        }),
    ...(copyObject === undefined
      ? {}
      : {
          copyObject(sourceKey: string, destinationKey: string) {
            return copyObject(
              prefixedKey(normalizedPrefix, sourceKey),
              prefixedKey(normalizedPrefix, destinationKey),
            );
          },
        }),
    ...(checkHealth === undefined ? {} : { checkHealth }),
    ...(listKeys === undefined
      ? {}
      : {
          async *listKeys(prefix: string): AsyncIterable<string> {
            for await (const key of listKeys(prefixedKey(normalizedPrefix, prefix))) {
              if (!key.startsWith(normalizedPrefix)) {
                throw new Error("Storage returned an object outside the tenant namespace.");
              }
              yield key.slice(normalizedPrefix.length);
            }
          },
        }),
    ...(head === undefined
      ? {}
      : {
          async head(key: string) {
            const result = await head(prefixedKey(normalizedPrefix, key));
            return result === null ? null : { ...result, key };
          },
        }),
    ...(getStream === undefined
      ? {}
      : {
          async getStream(key: string): Promise<StorageObject | null> {
            const object = await getStream(prefixedKey(normalizedPrefix, key));
            return object === null ? null : { ...object, key };
          },
        }),
    ...(getRange === undefined
      ? {}
      : {
          async getRange(key: string, start: number, end: number): Promise<StorageObject | null> {
            const object = await getRange(prefixedKey(normalizedPrefix, key), start, end);
            return object === null ? null : { ...object, key };
          },
        }),
    ...(copy === undefined
      ? {}
      : {
          async copy(sourceKey: string, destinationKey: string): Promise<void> {
            await copy(
              prefixedKey(normalizedPrefix, sourceKey),
              prefixedKey(normalizedPrefix, destinationKey),
            );
          },
        }),
    ...(createMultipartUpload === undefined
      ? {}
      : {
          async createMultipartUpload(key: string, options?: { readonly contentType?: string }) {
            return createMultipartUpload(prefixedKey(normalizedPrefix, key), options);
          },
        }),
    ...(presignUploadPart === undefined
      ? {}
      : {
          async presignUploadPart(
            key: string,
            uploadId: string,
            partNumber: number,
            options?: { readonly contentType?: string; readonly expiresSeconds?: number },
          ): Promise<string> {
            return presignUploadPart(
              prefixedKey(normalizedPrefix, key),
              uploadId,
              partNumber,
              options,
            );
          },
        }),
    ...(completeMultipartUpload === undefined
      ? {}
      : {
          async completeMultipartUpload(
            key: string,
            uploadId: string,
            parts: readonly { readonly partNumber: number; readonly etag: string }[],
          ): Promise<void> {
            await completeMultipartUpload(prefixedKey(normalizedPrefix, key), uploadId, parts);
          },
        }),
    ...(abortMultipartUpload === undefined
      ? {}
      : {
          async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
            await abortMultipartUpload(prefixedKey(normalizedPrefix, key), uploadId);
          },
        }),
    ...(presignGetUrl === undefined
      ? {}
      : {
          async presignGetUrl(
            key: string,
            options?: Parameters<NonNullable<TenantStorageClient["presignGetUrl"]>>[1],
          ): Promise<string> {
            return presignGetUrl(prefixedKey(normalizedPrefix, key), options);
          },
        }),
    ...(presignPutUrl === undefined
      ? {}
      : {
          async presignPutUrl(
            key: string,
            options?: Parameters<NonNullable<TenantStorageClient["presignPutUrl"]>>[1],
          ): Promise<string> {
            return presignPutUrl(prefixedKey(normalizedPrefix, key), options);
          },
        }),
    ...(presignPutRequest === undefined && presignPutUrl === undefined
      ? {}
      : {
          async presignPutRequest(
            key: string,
            options?: Parameters<NonNullable<TenantStorageClient["presignPutRequest"]>>[1],
          ): Promise<TenantPresignedPutUpload> {
            if (presignPutRequest !== undefined) {
              return presignPutRequest(prefixedKey(normalizedPrefix, key), options);
            }
            if (presignPutUrl === undefined) {
              throw new Error("Resolved storage client does not support presigned PUT URLs.");
            }
            return {
              url: await presignPutUrl(prefixedKey(normalizedPrefix, key), options),
              headers: presignedPutHeadersFromOptions(options),
            };
          },
        }),
  };
}

function presignedPutHeadersFromOptions(
  options:
    | {
        readonly contentType?: string;
        readonly metadata?: Record<string, string>;
      }
    | undefined,
): Record<string, string> {
  return {
    ...(options?.contentType === undefined ? {} : { "content-type": options.contentType }),
    ...Object.fromEntries(
      Object.entries(options?.metadata ?? {}).map(([name, value]) => [
        `x-amz-meta-${name.toLowerCase()}`,
        value,
      ]),
    ),
  };
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim().replace(/^\/+/u, "");
  if (trimmed.includes("..") || trimmed.includes("\\") || hasControlCharacter(trimmed)) {
    throw new Error("Storage prefix must not contain path traversal or control characters.");
  }
  if (trimmed.includes("//")) {
    throw new Error("Storage prefix must not contain repeated separators.");
  }
  if (trimmed.length === 0) {
    return "";
  }
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function prefixedKey(prefix: string, key: string): string {
  const normalizedKey = key.replace(/^\/+/u, "");
  return `${prefix}${normalizedKey}`;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readRequiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value.trim();
}

function storageResolutionCacheKey(
  orgId: string,
  storageConfig: NonNullable<ReturnType<typeof storageConfigFromByo>>,
  secretVersion?: string,
): string {
  return `${orgId}:${createHash("sha256")
    .update(stableStringify({ storageConfig, secretVersion }))
    .digest("hex")}`;
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

class TenantStorageResolutionCache {
  readonly #entries = new Map<
    string,
    { readonly value: ResolvedTenantStorage; readonly lastUsedAt: number }
  >();

  constructor(
    private readonly options: {
      readonly maxEntries: number;
      readonly idleTtlMs: number;
      readonly now: () => number;
      readonly metrics?: TenantStoragePoolMetrics | undefined;
    },
  ) {}

  get(key: string): ResolvedTenantStorage | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.#entries.delete(key);
      this.recordEviction();
      return undefined;
    }
    this.#entries.delete(key);
    this.#entries.set(key, { value: entry.value, lastUsedAt: this.options.now() });
    return entry.value;
  }

  set(key: string, value: ResolvedTenantStorage): void {
    if (this.options.maxEntries <= 0) {
      return;
    }
    this.#entries.delete(key);
    this.#entries.set(key, { value, lastUsedAt: this.options.now() });
    this.evictExpired();
    while (this.#entries.size > this.options.maxEntries) {
      const oldestKey = this.#entries.keys().next().value;
      if (oldestKey === undefined) {
        return;
      }
      this.#entries.delete(oldestKey);
      this.recordEviction();
    }
    this.recordSize();
  }

  private evictExpired(): void {
    for (const [key, entry] of this.#entries) {
      if (this.isExpired(entry)) {
        this.#entries.delete(key);
        this.recordEviction();
      }
    }
  }

  private isExpired(entry: { readonly lastUsedAt: number }): boolean {
    return (
      this.options.idleTtlMs >= 0 && this.options.now() - entry.lastUsedAt > this.options.idleTtlMs
    );
  }

  private recordEviction(): void {
    this.options.metrics?.recordStoragePoolEviction();
    this.recordSize();
  }

  private recordSize(): void {
    this.options.metrics?.setStoragePoolSize({ size: this.#entries.size });
  }
}
