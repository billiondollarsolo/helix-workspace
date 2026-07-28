import { describe, expect, it } from "vitest";
import {
  createDefaultTenantStorageResolver,
  createPrefixedStorageClient,
  createTenantStorageResolver,
  resolveTenantStorageSnapshot,
  type TenantStorageClient,
} from "./tenant-resolver.js";

describe("tenant storage resolver", () => {
  it("prefixes object operations while preserving logical keys to callers", async () => {
    const storage = new RecordingStorageClient();
    const scoped = createPrefixedStorageClient(storage, "/tenants/org-1");

    await scoped.put({
      key: "/drive/file.txt",
      body: new Uint8Array([1]),
      contentType: "text/plain",
    });
    const object = await scoped.get("drive/file.txt");
    await scoped.delete("drive/file.txt");
    const putUrl = await scoped.presignPutUrl?.("drive/file.txt", { contentType: "text/plain" });
    const putRequest = await scoped.presignPutRequest?.("drive/file.txt", {
      contentType: "text/plain",
      metadata: { Upload: "demo" },
    });
    const getUrl = await scoped.presignGetUrl?.("drive/file.txt", { expiresSeconds: 60 });
    const multipart = await scoped.createMultipartUpload?.("drive/large.bin");
    const partUrl = await scoped.presignUploadPart?.("drive/large.bin", "upload-a", 1);
    await scoped.completeMultipartUpload?.("drive/large.bin", "upload-a", [
      { partNumber: 1, etag: "etag-a" },
    ]);
    await scoped.abortMultipartUpload?.("drive/abandoned.bin", "upload-b");
    await scoped.copyObject?.("drive/source.bin", "drive/copy.bin");

    expect(storage.calls).toEqual([
      "put:tenants/org-1/drive/file.txt",
      "get:tenants/org-1/drive/file.txt",
      "delete:tenants/org-1/drive/file.txt",
      "presign-put:tenants/org-1/drive/file.txt:text/plain",
      "presign-put-request:tenants/org-1/drive/file.txt:text/plain:demo",
      "presign-get:tenants/org-1/drive/file.txt:60",
      "multipart-create:tenants/org-1/drive/large.bin",
      "multipart-part:tenants/org-1/drive/large.bin:upload-a:1",
      "multipart-complete:tenants/org-1/drive/large.bin:upload-a",
      "multipart-abort:tenants/org-1/drive/abandoned.bin:upload-b",
      "copy:tenants/org-1/drive/source.bin:tenants/org-1/drive/copy.bin",
    ]);
    expect(object?.key).toBe("drive/file.txt");
    expect(putUrl).toBe("put://tenants/org-1/drive/file.txt");
    expect(putRequest).toEqual({
      url: "put-request://tenants/org-1/drive/file.txt",
      headers: {
        "content-type": "text/plain",
        "x-amz-meta-upload": "demo",
      },
    });
    expect(getUrl).toBe("get://tenants/org-1/drive/file.txt");
    expect(multipart).toEqual({ uploadId: "upload-a" });
    expect(partUrl).toBe("part://tenants/org-1/drive/large.bin/1");
  });

  it("creates helix-default tenant resolvers with the standard tenant prefix", async () => {
    const storage = new RecordingStorageClient();
    const resolver = createDefaultTenantStorageResolver(storage);
    const resolved = await resolver({ orgId: "org-default" });

    expect(resolved?.managedBy).toBe("helix-default");
    expect(resolved?.prefix).toBe("tenants/org-default/");
    await resolved?.client.delete("drive/object");
    expect(storage.calls).toEqual(["delete:tenants/org-default/drive/object"]);
  });

  it("uses stored helix-default storage prefixes when tenant config has a namespace", async () => {
    const storage = new RecordingStorageClient();
    const resolver = createTenantStorageResolver({
      defaultClient: storage,
      loadByoConfig: () => ({
        storage: {
          kind: "helix-default",
          prefix: "tenants/org-configured/",
        },
      }),
    });
    const resolved = await resolver({ orgId: "org-configured" });

    expect(resolved?.managedBy).toBe("helix-default");
    expect(resolved?.prefix).toBe("tenants/org-configured/");
    await resolved?.client.put({ key: "drive/file.txt", body: new Uint8Array([1]) });
    expect(storage.calls).toEqual(["put:tenants/org-configured/drive/file.txt"]);
  });

  it("keeps existing unscoped default storage behavior when no tenant storage config exists", async () => {
    const storage = new RecordingStorageClient();
    const resolver = createTenantStorageResolver({
      defaultClient: storage,
      loadByoConfig: () => ({}),
    });
    const resolved = await resolver({ orgId: "org-legacy" });

    expect(resolved?.prefix).toBe("");
    await resolved?.client.delete("drive/file.txt");
    expect(storage.calls).toEqual(["delete:drive/file.txt"]);
  });

  it("resolves BYO s3-compatible storage from a Vault-path secret without changing logical keys", async () => {
    const created: unknown[] = [];
    const storage = new RecordingStorageClient();
    const resolver = createTenantStorageResolver({
      defaultClient: undefined,
      secretReader: {
        async read(path) {
          expect(path).toBe("tenants/acme/byo-storage/s3");
          return {
            accessKeyId: "access-key",
            secretAccessKey: "secret-key",
            sessionToken: "session-token",
          };
        },
      },
      createS3Client(config) {
        created.push(config);
        return storage;
      },
      loadByoConfig: () => ({
        storage: {
          kind: "byo",
          provider: "s3-compatible",
          endpoint: "https://storage.example.com",
          region: "us-west-2",
          bucket: "acme-bucket",
          prefix: "helix/",
          credentials_vault_path: "tenants/acme/byo-storage/s3",
          encryption: {
            sse_kms_key_arn: "arn:aws:kms:us-west-2:123456789012:key/acme",
          },
        },
      }),
    });

    const resolved = await resolver({ orgId: "org-byo" });
    expect(resolved?.managedBy).toBe("byo");
    expect(resolved?.prefix).toBe("helix/");
    await resolved?.client.put({ key: "drive/file.txt", body: new Uint8Array([1]) });

    expect(storage.calls).toEqual(["put:helix/drive/file.txt"]);
    expect(created).toEqual([
      {
        endpoint: "https://storage.example.com",
        region: "us-west-2",
        bucket: "acme-bucket",
        credentials: {
          accessKeyId: "access-key",
          secretAccessKey: "secret-key",
          sessionToken: "session-token",
        },
        forcePathStyle: true,
        serverSideEncryption: "aws:kms",
        serverSideEncryptionAwsKmsKeyId: "arn:aws:kms:us-west-2:123456789012:key/acme",
      },
    ]);
  });

  it("reuses resolved BYO clients for the same org and unchanged storage config", async () => {
    let secretReads = 0;
    let created = 0;
    const storage = new RecordingStorageClient();
    const resolver = createTenantStorageResolver({
      defaultClient: undefined,
      secretReader: {
        async read() {
          secretReads += 1;
          return {
            accessKeyId: "access-key",
            secretAccessKey: "secret-key",
          };
        },
      },
      createS3Client() {
        created += 1;
        return storage;
      },
      loadByoConfig: () => ({
        storage: {
          kind: "byo",
          provider: "s3-compatible",
          endpoint: "https://storage.example.com",
          bucket: "acme-bucket",
          prefix: "helix/",
          credentials_vault_path: "tenants/acme/byo-storage/s3",
        },
      }),
    });

    const first = await resolver({ orgId: "org-byo" });
    const second = await resolver({ orgId: "org-byo" });
    await first?.client.put({ key: "drive/a.txt", body: new Uint8Array([1]) });
    await second?.client.put({ key: "drive/b.txt", body: new Uint8Array([2]) });

    expect(first?.client).toBe(second?.client);
    expect(secretReads).toBe(1);
    expect(created).toBe(1);
    expect(storage.calls).toEqual(["put:helix/drive/a.txt", "put:helix/drive/b.txt"]);
  });

  it("refreshes the cached BYO client when tenant storage config changes", async () => {
    const created: Array<{ readonly credentials: { readonly secretAccessKey: string } }> = [];
    const firstStorage = new RecordingStorageClient();
    const secondStorage = new RecordingStorageClient();
    let prefix = "first/";
    let credentialsVaultPath = "tenants/acme/byo-storage/first";
    const resolver = createTenantStorageResolver({
      defaultClient: undefined,
      secretReader: {
        async read(path) {
          return {
            accessKeyId: path,
            secretAccessKey: "secret-key",
          };
        },
      },
      createS3Client(config) {
        created.push({ credentials: { secretAccessKey: config.credentials.secretAccessKey } });
        return created.length === 1 ? firstStorage : secondStorage;
      },
      loadByoConfig: () => ({
        storage: {
          kind: "byo",
          provider: "s3-compatible",
          endpoint: "https://storage.example.com",
          bucket: "acme-bucket",
          prefix,
          credentials_vault_path: credentialsVaultPath,
        },
      }),
    });

    const first = await resolver({ orgId: "org-byo" });
    await first?.client.delete("drive/file.txt");
    prefix = "second/";
    credentialsVaultPath = "tenants/acme/byo-storage/second";
    const second = await resolver({ orgId: "org-byo" });
    await second?.client.delete("drive/file.txt");

    expect(first?.client).not.toBe(second?.client);
    expect(created).toHaveLength(2);
    expect(firstStorage.calls).toEqual(["delete:first/drive/file.txt"]);
    expect(secondStorage.calls).toEqual(["delete:second/drive/file.txt"]);
  });

  it("refreshes the cached BYO client when only SSE-KMS config changes", async () => {
    let sseKmsKeyArn = "arn:aws:kms:us-east-1:123456789012:key/first";
    const created: Array<{ readonly kmsKeyId: string | undefined }> = [];
    const firstStorage = new RecordingStorageClient();
    const secondStorage = new RecordingStorageClient();
    const resolver = createTenantStorageResolver({
      defaultClient: undefined,
      secretReader: {
        async read() {
          return {
            accessKeyId: "access-key",
            secretAccessKey: "secret-key",
          };
        },
      },
      createS3Client(config) {
        created.push({ kmsKeyId: config.serverSideEncryptionAwsKmsKeyId });
        return created.length === 1 ? firstStorage : secondStorage;
      },
      loadByoConfig: () => ({
        storage: {
          kind: "byo",
          provider: "aws-s3",
          bucket: "acme-bucket",
          credentials_vault_path: "tenants/acme/byo-storage/aws",
          encryption: {
            sse_kms_key_arn: sseKmsKeyArn,
          },
        },
      }),
    });

    const first = await resolver({ orgId: "org-aws" });
    await first?.client.delete("drive/file.txt");
    sseKmsKeyArn = "arn:aws:kms:us-east-1:123456789012:key/second";
    const second = await resolver({ orgId: "org-aws" });
    await second?.client.delete("drive/file.txt");

    expect(first?.client).not.toBe(second?.client);
    expect(created).toEqual([
      { kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/first" },
      { kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/second" },
    ]);
  });

  it("refreshes the cached BYO client on demand when credentials rotate in place", async () => {
    let secretAccessKey = "first-secret";
    const created: unknown[] = [];
    const firstStorage = new RecordingStorageClient();
    const secondStorage = new RecordingStorageClient();
    const resolver = createTenantStorageResolver({
      defaultClient: undefined,
      secretReader: {
        async read() {
          return {
            accessKeyId: "access-key",
            secretAccessKey,
          };
        },
      },
      createS3Client(config) {
        created.push({ credentials: { secretAccessKey: config.credentials.secretAccessKey } });
        return created.length === 1 ? firstStorage : secondStorage;
      },
      loadByoConfig: () => ({
        storage: {
          kind: "byo",
          provider: "s3-compatible",
          endpoint: "https://storage.example.com",
          bucket: "acme-bucket",
          prefix: "helix/",
          credentials_vault_path: "tenants/acme/byo-storage/s3",
        },
      }),
    });

    const first = await resolver({ orgId: "org-byo" });
    await first?.client.delete("drive/a.txt");
    secretAccessKey = "rotated-secret";
    const refreshed = await resolver({ orgId: "org-byo", refresh: true });
    await refreshed?.client.delete("drive/b.txt");
    const cachedAfterRefresh = await resolver({ orgId: "org-byo" });
    await cachedAfterRefresh?.client.delete("drive/c.txt");

    expect(first?.client).not.toBe(refreshed?.client);
    expect(refreshed?.client).toBe(cachedAfterRefresh?.client);
    expect(created).toEqual([
      { credentials: { secretAccessKey: "first-secret" } },
      { credentials: { secretAccessKey: "rotated-secret" } },
    ]);
    expect(firstStorage.calls).toEqual(["delete:helix/drive/a.txt"]);
    expect(secondStorage.calls).toEqual(["delete:helix/drive/b.txt", "delete:helix/drive/c.txt"]);
  });

  it("evicts least recently used tenant storage clients when the cache is full", async () => {
    let created = 0;
    const metrics = new RecordingStoragePoolMetrics();
    const resolver = createTenantStorageResolver({
      defaultClient: undefined,
      cacheMaxEntries: 1,
      metrics,
      secretReader: {
        async read() {
          return {
            accessKeyId: "access-key",
            secretAccessKey: "secret-key",
          };
        },
      },
      createS3Client() {
        created += 1;
        return new RecordingStorageClient();
      },
      loadByoConfig: (orgId) => ({
        storage: {
          kind: "byo",
          provider: "s3-compatible",
          endpoint: "https://storage.example.com",
          bucket: `${orgId}-bucket`,
          prefix: `${orgId}/`,
          credentials_vault_path: `tenants/${orgId}/byo-storage/s3`,
        },
      }),
    });

    await (await resolver({ orgId: "org-a" }))?.client.delete("drive/file.txt");
    await (await resolver({ orgId: "org-b" }))?.client.delete("drive/file.txt");
    await (await resolver({ orgId: "org-a" }))?.client.delete("drive/file.txt");

    expect(created).toBe(3);
    expect(metrics.sizes).toEqual([1, 1, 1, 1, 1]);
    expect(metrics.evictions).toBe(2);
  });

  it("expires idle tenant storage clients after the configured TTL", async () => {
    let created = 0;
    let now = 0;
    const metrics = new RecordingStoragePoolMetrics();
    const resolver = createTenantStorageResolver({
      defaultClient: undefined,
      cacheIdleTtlMs: 10,
      cacheNow: () => now,
      metrics,
      secretReader: {
        async read() {
          return {
            accessKeyId: "access-key",
            secretAccessKey: "secret-key",
          };
        },
      },
      createS3Client() {
        created += 1;
        return new RecordingStorageClient();
      },
      loadByoConfig: () => ({
        storage: {
          kind: "byo",
          provider: "s3-compatible",
          endpoint: "https://storage.example.com",
          bucket: "acme-bucket",
          prefix: "helix/",
          credentials_vault_path: "tenants/acme/byo-storage/s3",
        },
      }),
    });

    await (await resolver({ orgId: "org-byo" }))?.client.delete("drive/a.txt");
    now = 5;
    await (await resolver({ orgId: "org-byo" }))?.client.delete("drive/b.txt");
    now = 16;
    await (await resolver({ orgId: "org-byo" }))?.client.delete("drive/c.txt");

    expect(created).toBe(2);
    expect(metrics.sizes).toEqual([1, 0, 1]);
    expect(metrics.evictions).toBe(1);
  });

  it("fails closed for BYO storage when the secret reader is not configured", async () => {
    const resolver = createTenantStorageResolver({
      defaultClient: undefined,
      loadByoConfig: () => ({
        storage: {
          kind: "byo",
          provider: "r2",
          endpoint: "https://account.r2.cloudflarestorage.com",
          bucket: "acme-bucket",
          credentials_vault_path: "tenants/acme/byo-storage/r2",
        },
      }),
    });

    await expect(resolver({ orgId: "org-byo" })).rejects.toThrow(
      "BYO storage secret reader is not configured.",
    );
  });

  it("defaults AWS S3 endpoint and virtual-host addressing when endpoint is omitted", async () => {
    const created: unknown[] = [];
    const resolver = createTenantStorageResolver({
      defaultClient: undefined,
      secretReader: {
        async read() {
          return {
            AWS_ACCESS_KEY_ID: "access-key",
            AWS_SECRET_ACCESS_KEY: "secret-key",
          };
        },
      },
      createS3Client(config) {
        created.push(config);
        return new RecordingStorageClient();
      },
      loadByoConfig: () => ({
        storage: {
          kind: "byo",
          provider: "aws-s3",
          bucket: "acme-bucket",
          credentials_vault_path: "tenants/acme/byo-storage/aws",
        },
      }),
    });

    const resolved = await resolver({ orgId: "org-aws" });
    await resolved?.client.delete("drive/file.txt");

    expect(created).toEqual([
      expect.objectContaining({
        endpoint: "https://s3.amazonaws.com",
        region: "us-east-1",
        bucket: "acme-bucket",
        forcePathStyle: false,
      }),
    ]);
  });

  it("resolves Cloudflare R2 with the supplied S3-compatible endpoint", async () => {
    const created: unknown[] = [];
    const resolver = createTenantStorageResolver({
      defaultClient: undefined,
      secretReader: {
        async read() {
          return {
            accessKeyId: "r2-access-key",
            secretAccessKey: "r2-secret-key",
          };
        },
      },
      createS3Client(config) {
        created.push(config);
        return new RecordingStorageClient();
      },
      loadByoConfig: () => ({
        storage: {
          kind: "byo",
          provider: "r2",
          endpoint: "https://account-id.r2.cloudflarestorage.com",
          region: "auto",
          bucket: "acme-r2-bucket",
          credentials_vault_path: "tenants/acme/byo-storage/r2",
        },
      }),
    });

    const resolved = await resolver({ orgId: "org-r2" });
    await resolved?.client.delete("drive/file.txt");

    expect(created).toEqual([
      expect.objectContaining({
        endpoint: "https://account-id.r2.cloudflarestorage.com",
        region: "auto",
        bucket: "acme-r2-bucket",
        credentials: {
          accessKeyId: "r2-access-key",
          secretAccessKey: "r2-secret-key",
        },
        forcePathStyle: true,
      }),
    ]);
  });

  it("resolves helix-default storage snapshots with standard and explicit prefixes", async () => {
    const standard = new RecordingStorageClient();
    const standardResolved = resolveTenantStorageSnapshot({
      orgId: "org-default",
      state: { managedBy: "helix-default", storage: null },
      defaultClient: standard,
    });

    expect(standardResolved?.managedBy).toBe("helix-default");
    expect(standardResolved?.prefix).toBe("tenants/org-default/");
    await standardResolved?.client.delete("drive/file.txt");
    expect(standard.calls).toEqual(["delete:tenants/org-default/drive/file.txt"]);

    const explicit = new RecordingStorageClient();
    const explicitResolved = resolveTenantStorageSnapshot({
      orgId: "org-explicit",
      state: {
        managedBy: "helix-default",
        storage: { kind: "helix-default", prefix: "/custom/prefix" },
      },
      defaultClient: explicit,
    });

    expect(explicitResolved?.prefix).toBe("custom/prefix/");
    await explicitResolved?.client.put({ key: "drive/file.txt", body: new Uint8Array([1]) });
    expect(explicit.calls).toEqual(["put:custom/prefix/drive/file.txt"]);
  });

  it("resolves BYO storage snapshots lazily through the secret reader", async () => {
    let secretReads = 0;
    const created: unknown[] = [];
    const storage = new RecordingStorageClient();
    const resolved = resolveTenantStorageSnapshot({
      orgId: "org-byo",
      state: {
        managedBy: "byo",
        storage: {
          kind: "byo",
          provider: "s3-compatible",
          endpoint: "https://storage.example.com",
          region: "us-west-2",
          bucket: "acme-bucket",
          prefix: "customer/",
          credentials_vault_path: "tenants/acme/byo-storage/s3",
        },
      },
      defaultClient: undefined,
      secretReader: {
        async read(path) {
          secretReads += 1;
          expect(path).toBe("tenants/acme/byo-storage/s3");
          return {
            accessKeyId: "access-key",
            secretAccessKey: "secret-key",
          };
        },
      },
      createS3Client(config) {
        created.push(config);
        return storage;
      },
    });

    expect(resolved?.managedBy).toBe("byo");
    expect(resolved?.prefix).toBe("customer/");
    expect(secretReads).toBe(0);
    await resolved?.client.put({ key: "drive/file.txt", body: new Uint8Array([1]) });

    expect(secretReads).toBe(1);
    expect(storage.calls).toEqual(["put:customer/drive/file.txt"]);
    expect(created).toEqual([
      expect.objectContaining({
        endpoint: "https://storage.example.com",
        region: "us-west-2",
        bucket: "acme-bucket",
        credentials: {
          accessKeyId: "access-key",
          secretAccessKey: "secret-key",
        },
      }),
    ]);
  });

  it("rejects storage snapshot manager/kind mismatches", () => {
    expect(() =>
      resolveTenantStorageSnapshot({
        orgId: "org-1",
        state: {
          managedBy: "helix-default",
          storage: {
            kind: "byo",
            provider: "aws-s3",
            bucket: "acme-bucket",
            credentials_vault_path: "tenants/acme/byo-storage/aws",
          },
        },
        defaultClient: new RecordingStorageClient(),
      }),
    ).toThrow("Helix-default storage snapshot must use kind helix-default.");

    expect(() =>
      resolveTenantStorageSnapshot({
        orgId: "org-1",
        state: {
          managedBy: "byo",
          storage: { kind: "helix-default", prefix: "tenants/org-1/" },
        },
        defaultClient: new RecordingStorageClient(),
      }),
    ).toThrow("BYO storage snapshot must use kind byo.");
  });
});

class RecordingStorageClient implements TenantStorageClient {
  readonly calls: string[] = [];

  async put(object: { readonly key: string }): Promise<void> {
    this.calls.push(`put:${object.key}`);
  }

  async get(key: string): Promise<{ readonly key: string; readonly body: Uint8Array }> {
    this.calls.push(`get:${key}`);
    return { key, body: new Uint8Array([1]) };
  }

  async delete(key: string): Promise<void> {
    this.calls.push(`delete:${key}`);
  }

  async presignPutUrl(key: string, options?: { readonly contentType?: string }): Promise<string> {
    this.calls.push(`presign-put:${key}:${options?.contentType ?? ""}`);
    return `put://${key}`;
  }

  async presignPutRequest(
    key: string,
    options?: { readonly contentType?: string; readonly metadata?: Record<string, string> },
  ): Promise<{ readonly url: string; readonly headers: Record<string, string> }> {
    this.calls.push(
      `presign-put-request:${key}:${options?.contentType ?? ""}:${options?.metadata?.Upload ?? ""}`,
    );
    return {
      url: `put-request://${key}`,
      headers: {
        ...(options?.contentType === undefined ? {} : { "content-type": options.contentType }),
        ...Object.fromEntries(
          Object.entries(options?.metadata ?? {}).map(([name, value]) => [
            `x-amz-meta-${name.toLowerCase()}`,
            value,
          ]),
        ),
      },
    };
  }

  async presignGetUrl(
    key: string,
    options?: { readonly expiresSeconds?: number },
  ): Promise<string> {
    this.calls.push(`presign-get:${key}:${String(options?.expiresSeconds ?? "")}`);
    return `get://${key}`;
  }

  async createMultipartUpload(key: string): Promise<{ readonly uploadId: string }> {
    this.calls.push(`multipart-create:${key}`);
    return { uploadId: "upload-a" };
  }

  async presignUploadPart(key: string, uploadId: string, partNumber: number): Promise<string> {
    this.calls.push(`multipart-part:${key}:${uploadId}:${String(partNumber)}`);
    return `part://${key}/${String(partNumber)}`;
  }

  async completeMultipartUpload(key: string, uploadId: string): Promise<void> {
    this.calls.push(`multipart-complete:${key}:${uploadId}`);
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    this.calls.push(`multipart-abort:${key}:${uploadId}`);
  }

  async copyObject(sourceKey: string, destinationKey: string): Promise<void> {
    this.calls.push(`copy:${sourceKey}:${destinationKey}`);
  }
}

class RecordingStoragePoolMetrics {
  readonly sizes: number[] = [];
  evictions = 0;

  setStoragePoolSize(input: { readonly size: number }): void {
    this.sizes.push(input.size);
  }

  recordStoragePoolEviction(): void {
    this.evictions += 1;
  }
}
