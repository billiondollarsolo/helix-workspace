import { createHash } from "node:crypto";
import type { JsonObject, StorageClient, StorageObject } from "@helix/sdk-types";
import {
  createS3CompatibleStorage,
  type S3CompatibleCredentials,
  type S3CompatibleStorageConfig,
} from "./s3-compatible.js";

export interface TenantStorageClient extends StorageClient {
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
}

export interface TenantPresignedPutUpload {
  readonly url: string;
  readonly headers: Record<string, string>;
}

export interface ResolvedTenantStorage {
  readonly client: TenantStorageClient;
  readonly managedBy: "helix-default" | "byo";
  readonly prefix: string;
}

export interface TenantStorageStateSnapshot {
  readonly managedBy: "helix-default" | "byo";
  readonly storage: JsonObject | null;
}

export interface TenantStorageMigrationWriteTarget {
  readonly jobId: string;
  readonly target: "helix-default" | "byo";
  readonly client: TenantStorageClient;
}

export interface TenantStorageMigrationWriteCoordinator {
  resolveWriteTarget(input: {
    readonly orgId: string;
    readonly currentStorage: TenantStorageStateSnapshot;
  }):
    | Promise<TenantStorageMigrationWriteTarget | undefined>
    | TenantStorageMigrationWriteTarget
    | undefined;
}

export interface TenantStorageSecretReader {
  read(path: string): Promise<Record<string, string> | undefined>;
}

export interface TenantStorageSecretWriter {
  write(path: string, secret: Record<string, string>): Promise<void>;
}

export interface TenantStorageSecretStore
  extends TenantStorageSecretReader, TenantStorageSecretWriter {}

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
  readonly loadByoConfig: (
    orgId: string,
  ) => Promise<JsonObject | undefined> | JsonObject | undefined;
  readonly secretReader?: TenantStorageSecretReader | undefined;
  readonly createS3Client?: (config: S3CompatibleStorageConfig) => TenantStorageClient;
  readonly cacheMaxEntries?: number | undefined;
  readonly cacheIdleTtlMs?: number | undefined;
  readonly cacheNow?: (() => number) | undefined;
  readonly metrics?: TenantStoragePoolMetrics | undefined;
  readonly migrationWriteCoordinator?: TenantStorageMigrationWriteCoordinator | undefined;
}): TenantStorageResolver {
  const cache = new TenantStorageResolutionCache({
    maxEntries: options.cacheMaxEntries ?? 100,
    idleTtlMs: options.cacheIdleTtlMs ?? 60 * 60 * 1000,
    now: options.cacheNow ?? Date.now,
    metrics: options.metrics,
  });
  return async ({ orgId, refresh = false }) => {
    const byoConfig = await options.loadByoConfig(orgId);
    const storageConfig = storageConfigFromByo(byoConfig);
    const currentStorage = tenantStorageStateSnapshotFromByoConfig(byoConfig);
    const cacheKey = storageResolutionCacheKey(orgId, storageConfig, options.defaultClient);
    if (!refresh) {
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
    }
    let resolved: ResolvedTenantStorage | undefined;
    if (storageConfig === undefined) {
      if (options.defaultClient === undefined) {
        return undefined;
      }
      resolved = {
        client: options.defaultClient,
        managedBy: "helix-default",
        prefix: "",
      };
      resolved = withMigrationWriteCoordination({
        orgId,
        currentStorage,
        resolved,
        coordinator: options.migrationWriteCoordinator,
      });
      cache.set(cacheKey, resolved);
      return resolved;
    }
    if (storageConfig.kind === "byo") {
      const client = createByoS3StorageClient(storageConfig, options);
      resolved = {
        client: createPrefixedStorageClient(client, storageConfig.prefix),
        managedBy: "byo",
        prefix: storageConfig.prefix,
      };
      resolved = withMigrationWriteCoordination({
        orgId,
        currentStorage,
        resolved,
        coordinator: options.migrationWriteCoordinator,
      });
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
    };
    resolved = withMigrationWriteCoordination({
      orgId,
      currentStorage,
      resolved,
      coordinator: options.migrationWriteCoordinator,
    });
    cache.set(cacheKey, resolved);
    return resolved;
  };
}

export function createDefaultTenantStorageResolver(
  client: TenantStorageClient | undefined,
  options: { readonly prefixForOrg?: (orgId: string) => string } = {},
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
    };
  };
}

export function resolveTenantStorageSnapshot(input: {
  readonly orgId: string;
  readonly state: TenantStorageStateSnapshot;
  readonly defaultClient: TenantStorageClient | undefined;
  readonly secretReader?: TenantStorageSecretReader | undefined;
  readonly createS3Client?: (config: S3CompatibleStorageConfig) => TenantStorageClient;
}): ResolvedTenantStorage | undefined {
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
    };
  }

  const storageConfig =
    input.state.storage === null
      ? undefined
      : storageConfigFromByo({ storage: input.state.storage });
  if (storageConfig === undefined || storageConfig.kind !== "byo") {
    throw new Error("BYO storage snapshot must use kind byo.");
  }
  const client = createByoS3StorageClient(storageConfig, {
    ...(input.secretReader === undefined ? {} : { secretReader: input.secretReader }),
    ...(input.createS3Client === undefined ? {} : { createS3Client: input.createS3Client }),
  });
  return {
    client: createPrefixedStorageClient(client, storageConfig.prefix),
    managedBy: "byo",
    prefix: storageConfig.prefix,
  };
}

export function defaultTenantStoragePrefix(orgId: string): string {
  return `tenants/${orgId}/`;
}

function storageConfigFromByo(byoConfig: JsonObject | undefined):
  | { readonly kind: "helix-default"; readonly prefix: string }
  | {
      readonly kind: "byo";
      readonly provider: "aws-s3" | "r2" | "s3-compatible";
      readonly endpoint: string;
      readonly region: string;
      readonly bucket: string;
      readonly prefix: string;
      readonly credentialsVaultPath: string;
      readonly forcePathStyle: boolean;
      readonly serverSideEncryption?: "aws:kms";
      readonly serverSideEncryptionAwsKmsKeyId?: string;
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
    const credentialsVaultPath = readRequiredString(
      storage.credentials_vault_path,
      "BYO storage credentials_vault_path is required.",
    );
    return {
      kind: "byo",
      provider,
      endpoint: endpointForProvider(provider, readString(storage.endpoint)),
      region: readString(storage.region) ?? "us-east-1",
      bucket,
      prefix: normalizePrefix(readString(storage.prefix) ?? ""),
      credentialsVaultPath,
      forcePathStyle: readBoolean(storage.force_path_style) ?? provider !== "aws-s3",
      ...serverSideEncryptionFromStorageConfig(storage),
    };
  }
  return undefined;
}

function tenantStorageStateSnapshotFromByoConfig(
  byoConfig: JsonObject | undefined,
): TenantStorageStateSnapshot {
  const storage = readRecord(byoConfig?.storage);
  if (storage === undefined) {
    return { managedBy: "helix-default", storage: null };
  }
  if (storage.kind !== "byo" && storage.kind !== "helix-default") {
    return { managedBy: "helix-default", storage: null };
  }
  return {
    managedBy: storage.kind,
    storage: JSON.parse(JSON.stringify(storage)) as JsonObject,
  };
}

function withMigrationWriteCoordination(input: {
  readonly orgId: string;
  readonly currentStorage: TenantStorageStateSnapshot;
  readonly resolved: ResolvedTenantStorage;
  readonly coordinator: TenantStorageMigrationWriteCoordinator | undefined;
}): ResolvedTenantStorage {
  if (input.coordinator === undefined) {
    return input.resolved;
  }
  return {
    ...input.resolved,
    client: createMigrationAwareStorageClient({
      orgId: input.orgId,
      currentStorage: input.currentStorage,
      primary: input.resolved.client,
      coordinator: input.coordinator,
    }),
  };
}

function createMigrationAwareStorageClient(input: {
  readonly orgId: string;
  readonly currentStorage: TenantStorageStateSnapshot;
  readonly primary: TenantStorageClient;
  readonly coordinator: TenantStorageMigrationWriteCoordinator;
}): TenantStorageClient {
  const presignGetUrl = input.primary.presignGetUrl?.bind(input.primary);
  return {
    async put(object: StorageObject): Promise<void> {
      const target = await input.coordinator.resolveWriteTarget({
        orgId: input.orgId,
        currentStorage: input.currentStorage,
      });
      if (target === undefined) {
        await input.primary.put(object);
        return;
      }
      await input.primary.put(object);
      await target.client.put(object);
    },
    async get(key: string): Promise<StorageObject | null> {
      return input.primary.get(key);
    },
    async delete(key: string): Promise<void> {
      const target = await input.coordinator.resolveWriteTarget({
        orgId: input.orgId,
        currentStorage: input.currentStorage,
      });
      if (target !== undefined) {
        throw new Error(
          `Tenant storage migration ${target.jobId} is in progress; deletes are blocked until cutover completes.`,
        );
      }
      await input.primary.delete(key);
    },
    ...(presignGetUrl === undefined
      ? {}
      : {
          async presignGetUrl(
            key: string,
            options?: Parameters<NonNullable<TenantStorageClient["presignGetUrl"]>>[1],
          ): Promise<string> {
            return presignGetUrl(key, options);
          },
        }),
    async presignPutUrl(
      key: string,
      options?: Parameters<NonNullable<TenantStorageClient["presignPutUrl"]>>[1],
    ): Promise<string> {
      const target = await input.coordinator.resolveWriteTarget({
        orgId: input.orgId,
        currentStorage: input.currentStorage,
      });
      if (target !== undefined) {
        throw new Error(
          `Tenant storage migration ${target.jobId} is in progress; presigned uploads are blocked until cutover completes.`,
        );
      }
      if (input.primary.presignPutUrl === undefined) {
        throw new Error("Resolved storage client does not support presigned PUT URLs.");
      }
      return input.primary.presignPutUrl(key, options);
    },
    async presignPutRequest(
      key: string,
      options?: Parameters<NonNullable<TenantStorageClient["presignPutRequest"]>>[1],
    ): Promise<TenantPresignedPutUpload> {
      const target = await input.coordinator.resolveWriteTarget({
        orgId: input.orgId,
        currentStorage: input.currentStorage,
      });
      if (target !== undefined) {
        throw new Error(
          `Tenant storage migration ${target.jobId} is in progress; presigned uploads are blocked until cutover completes.`,
        );
      }
      if (input.primary.presignPutRequest !== undefined) {
        return input.primary.presignPutRequest(key, options);
      }
      if (input.primary.presignPutUrl === undefined) {
        throw new Error("Resolved storage client does not support presigned PUT URLs.");
      }
      return {
        url: await input.primary.presignPutUrl(key, options),
        headers: presignedPutHeadersFromOptions(options),
      };
    },
  };
}

function createByoS3StorageClient(
  config: Exclude<
    ReturnType<typeof storageConfigFromByo>,
    undefined | { readonly kind: "helix-default" }
  >,
  options: {
    readonly secretReader?: TenantStorageSecretReader | undefined;
    readonly createS3Client?: (config: S3CompatibleStorageConfig) => TenantStorageClient;
  },
): TenantStorageClient {
  const secretReader = options.secretReader;
  if (secretReader === undefined) {
    throw new Error("BYO storage secret reader is not configured.");
  }
  const createS3Client = options.createS3Client ?? createS3CompatibleStorage;
  return new LazyByoS3StorageClient({
    config,
    secretReader,
    createS3Client,
  });
}

class LazyByoS3StorageClient implements TenantStorageClient {
  #client: TenantStorageClient | undefined;

  constructor(
    private readonly options: {
      readonly config: Exclude<
        ReturnType<typeof storageConfigFromByo>,
        undefined | { readonly kind: "helix-default" }
      >;
      readonly secretReader: TenantStorageSecretReader;
      readonly createS3Client: (config: S3CompatibleStorageConfig) => TenantStorageClient;
    },
  ) {}

  async put(object: StorageObject): Promise<void> {
    await (await this.client()).put(object);
  }

  async get(key: string): Promise<StorageObject | null> {
    return (await this.client()).get(key);
  }

  async delete(key: string): Promise<void> {
    await (await this.client()).delete(key);
  }

  async presignGetUrl(
    key: string,
    options?: Parameters<NonNullable<TenantStorageClient["presignGetUrl"]>>[1],
  ): Promise<string> {
    const client = await this.client();
    if (client.presignGetUrl === undefined) {
      throw new Error("Resolved BYO storage client does not support presigned GET URLs.");
    }
    return client.presignGetUrl(key, options);
  }

  async presignPutUrl(
    key: string,
    options?: Parameters<NonNullable<TenantStorageClient["presignPutUrl"]>>[1],
  ): Promise<string> {
    const client = await this.client();
    if (client.presignPutUrl === undefined) {
      throw new Error("Resolved BYO storage client does not support presigned PUT URLs.");
    }
    return client.presignPutUrl(key, options);
  }

  async presignPutRequest(
    key: string,
    options?: Parameters<NonNullable<TenantStorageClient["presignPutRequest"]>>[1],
  ): Promise<TenantPresignedPutUpload> {
    const client = await this.client();
    if (client.presignPutRequest !== undefined) {
      return client.presignPutRequest(key, options);
    }
    if (client.presignPutUrl === undefined) {
      throw new Error("Resolved BYO storage client does not support presigned PUT URLs.");
    }
    return {
      url: await client.presignPutUrl(key, options),
      headers: presignedPutHeadersFromOptions(options),
    };
  }

  private async client(): Promise<TenantStorageClient> {
    if (this.#client !== undefined) {
      return this.#client;
    }
    const secret = await this.options.secretReader.read(this.options.config.credentialsVaultPath);
    if (secret === undefined) {
      throw new Error("BYO storage credentials were not found.");
    }
    this.#client = this.options.createS3Client({
      endpoint: this.options.config.endpoint,
      region: this.options.config.region,
      bucket: this.options.config.bucket,
      credentials: s3CredentialsFromSecret(secret),
      forcePathStyle: this.options.config.forcePathStyle,
      ...(this.options.config.serverSideEncryption === undefined
        ? {}
        : {
            serverSideEncryption: this.options.config.serverSideEncryption,
            ...(this.options.config.serverSideEncryptionAwsKmsKeyId === undefined
              ? {}
              : {
                  serverSideEncryptionAwsKmsKeyId:
                    this.options.config.serverSideEncryptionAwsKmsKeyId,
                }),
          }),
    });
    return this.#client;
  }
}

function serverSideEncryptionFromStorageConfig(storage: Record<string, unknown>):
  | {
      readonly serverSideEncryption: "aws:kms";
      readonly serverSideEncryptionAwsKmsKeyId: string;
    }
  | Record<string, never> {
  const encryption = readRecord(storage.encryption);
  const kmsKeyId = readString(encryption?.sse_kms_key_arn)?.trim();
  if (kmsKeyId === undefined || kmsKeyId.length === 0) {
    return {};
  }
  return {
    serverSideEncryption: "aws:kms",
    serverSideEncryptionAwsKmsKeyId: kmsKeyId,
  };
}

function endpointForProvider(
  provider: "aws-s3" | "r2" | "s3-compatible",
  endpoint: string | undefined,
): string {
  if (endpoint !== undefined && endpoint.length > 0) {
    return endpoint;
  }
  if (provider === "aws-s3") {
    return "https://s3.amazonaws.com";
  }
  throw new Error("BYO storage endpoint is required for this provider.");
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

export function createPrefixedStorageClient(
  client: TenantStorageClient,
  prefix: string,
): TenantStorageClient {
  const normalizedPrefix = normalizePrefix(prefix);
  const presignGetUrl = client.presignGetUrl?.bind(client);
  const presignPutUrl = client.presignPutUrl?.bind(client);
  const presignPutRequest = client.presignPutRequest?.bind(client);
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

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

function storageResolutionCacheKey(
  orgId: string,
  storageConfig: ReturnType<typeof storageConfigFromByo>,
  defaultClient: TenantStorageClient | undefined,
): string {
  const basis =
    storageConfig === undefined
      ? {
          kind: "legacy-default",
          hasDefaultClient: defaultClient !== undefined,
        }
      : storageConfig;
  return `${orgId}:${createHash("sha256").update(stableStringify(basis)).digest("hex")}`;
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
