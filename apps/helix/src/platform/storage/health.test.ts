import { describe, expect, it } from "vitest";
import {
  persistedTenantStorageHealth,
  testTenantStorageConnection,
  type TenantStorageClient,
} from "./index.js";

const orgId = "11111111-1111-4111-8111-111111111111";

describe("tenant storage health", () => {
  it("runs a write-read-delete probe and returns diagnostics", async () => {
    const storage = new RecordingStorageClient();

    const health = await testTenantStorageConnection({
      orgId,
      storageResolver: async (input) => {
        expect(input).toEqual({ orgId, refresh: true });
        return { client: storage, managedBy: "byo", prefix: "helix/" };
      },
      refresh: true,
    });

    expect(health).toMatchObject({
      status: "healthy",
      message: "Tenant object storage write/read/delete probe succeeded.",
      managedBy: "byo",
      prefix: "helix/",
    });
    expect(storage.calls.map((call) => call.split(":")[0])).toEqual(["put", "get", "delete"]);
  });

  it("reports degraded when storage is unavailable", async () => {
    const health = await testTenantStorageConnection({
      orgId,
      storageResolver: async () => undefined,
    });

    expect(health).toMatchObject({
      status: "degraded",
      message: "Tenant object storage is not configured.",
    });
  });

  it("reports degraded when the resolver is not wired", async () => {
    const health = await testTenantStorageConnection({
      orgId,
      storageResolver: undefined,
    });

    expect(health).toMatchObject({
      status: "degraded",
      message: "Tenant storage resolver is not configured.",
    });
  });

  it("deletes the probe object when the read does not match", async () => {
    const storage = new RecordingStorageClient({ readBody: "wrong-body" });

    const health = await testTenantStorageConnection({
      orgId,
      storageResolver: async () => ({ client: storage, managedBy: "helix-default", prefix: "" }),
    });

    expect(health).toMatchObject({
      status: "degraded",
      message: "Tenant object storage probe read did not match the written object.",
      managedBy: "helix-default",
      prefix: "",
    });
    expect(storage.calls.map((call) => call.split(":")[0])).toEqual(["put", "get", "delete"]);
    expect(storage.objectCount()).toBe(0);
  });

  it("reports storage client failures without throwing", async () => {
    const health = await testTenantStorageConnection({
      orgId,
      storageResolver: async () => ({
        client: new FailingStorageClient("bucket access denied"),
        managedBy: "byo",
        prefix: "tenant-a/",
      }),
    });

    expect(health).toMatchObject({
      status: "degraded",
      message: "bucket access denied",
    });
  });

  it("keeps persisted health free of storage diagnostics", async () => {
    const persisted = persistedTenantStorageHealth({
      status: "healthy",
      checked_at: "2026-05-24T00:00:00.000Z",
      message: "ok",
      managedBy: "byo",
      prefix: "helix/",
    });

    expect(persisted).toEqual({
      status: "healthy",
      checked_at: "2026-05-24T00:00:00.000Z",
      message: "ok",
    });
    expect(JSON.stringify(persisted)).not.toContain("managedBy");
    expect(JSON.stringify(persisted)).not.toContain("prefix");
  });
});

class RecordingStorageClient implements TenantStorageClient {
  readonly calls: string[] = [];
  #objects = new Map<string, Uint8Array>();

  constructor(private readonly options: { readonly readBody?: string } = {}) {}

  async put(object: { readonly key: string; readonly body: Uint8Array }): Promise<void> {
    this.calls.push(`put:${object.key}`);
    this.#objects.set(object.key, object.body);
  }

  async get(key: string): Promise<{ readonly key: string; readonly body: Uint8Array } | null> {
    this.calls.push(`get:${key}`);
    const body = this.#objects.get(key);
    if (body === undefined) {
      return null;
    }
    return {
      key,
      body:
        this.options.readBody === undefined ? body : new TextEncoder().encode(this.options.readBody),
    };
  }

  async delete(key: string): Promise<void> {
    this.calls.push(`delete:${key}`);
    this.#objects.delete(key);
  }

  objectCount(): number {
    return this.#objects.size;
  }
}

class FailingStorageClient implements TenantStorageClient {
  constructor(private readonly message: string) {}

  async put(): Promise<void> {
    throw new Error(this.message);
  }

  async get(): Promise<null> {
    throw new Error(this.message);
  }

  async delete(): Promise<void> {
    throw new Error(this.message);
  }
}
