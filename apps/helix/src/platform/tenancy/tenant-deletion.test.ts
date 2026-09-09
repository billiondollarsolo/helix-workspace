import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { StorageObject } from "@helix/sdk";
import {
  createHmacAuditAnchorAuthenticator,
  type ImmutableAuditObject,
} from "../audit/immutable-s3.js";
import type { SearchEngine, SearchRequest, SearchResponse } from "../search/types.js";
import {
  TenantDeletionBlockedError,
  TenantDeletionWorkflow,
  type TenantDeletionProofRecord,
  type TenantDeletionStore,
} from "./tenant-deletion.js";
import type { OrgRecord } from "./orgs.js";

const org = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "acme",
  displayName: "Acme",
  status: "soft_deleted",
  tier: "enterprise",
  planId: "enterprise",
  region: "us-east",
  byoConfig: {},
  featureFlags: {},
  quotas: {},
  branding: {},
  suspendedAt: null,
  softDeletedAt: new Date("2026-01-01T00:00:00.000Z"),
  hardDeletedAt: null,
} satisfies OrgRecord;

describe("TenantDeletionWorkflow", () => {
  it("refuses every destructive phase while any hold exists", async () => {
    const store = new MemoryStore();
    store.record = proof({ status: "blocked", blockers: [{ type: "mail_hold", count: 1 }] });
    const storage = new MemoryStorage(["drive/a"]);
    const workflow = workflowWith({ store, storage });

    await expect(workflow.run(org)).rejects.toBeInstanceOf(TenantDeletionBlockedError);
    expect([...storage.keys]).toEqual(["drive/a"]);
    expect(store.sqlPurges).toBe(0);
  });

  it("retries a partial namespace failure and returns the same signed proof idempotently", async () => {
    const store = new MemoryStore();
    const storage = new MemoryStorage(["drive/a", "chat/b"]);
    storage.failOnceFor = "chat/b";
    const search = new MemorySearch(["mail:1", "drive:2"]);
    const written: ImmutableAuditObject[] = [];
    const signer = createHmacAuditAnchorAuthenticator(
      "tenant-delete-test",
      "tenant-delete-test-secret-at-least-32-bytes",
    );
    const workflow = workflowWith({ store, storage, search, signer, written });

    await expect(workflow.run(org)).rejects.toThrow("object delete failed");
    expect(store.sqlPurges).toBe(0);
    const first = await workflow.run(org);
    expect(storage.keys.size).toBe(0);
    expect(search.documents).toEqual([]);
    expect(store.sqlPurges).toBe(1);
    expect(written).toHaveLength(1);
    expect(written[0]?.objectLock?.mode).toBe("COMPLIANCE");
    expect(first.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);

    const second = await workflow.run(org);
    expect(second).toEqual(first);
    expect(store.sqlPurges).toBe(1);
    expect(written).toHaveLength(1);
  });

  it("defines a catalog purge, holds, proof immutability, and valid system audit principal", async () => {
    const migration = await readFile(
      new URL("../../db/migrations/0152_verifiable_tenant_deletion.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("helix_tenant_deletion_blockers");
    expect(migration).toContain("information_schema.columns");
    expect(migration).toContain("disable trigger user");
    expect(migration).toContain("completed tenant deletion proof is immutable");
    expect(migration).toContain("'system'");
    expect(migration).toContain("identity_subjects");
  });
});

function workflowWith(input: {
  readonly store: MemoryStore;
  readonly storage: MemoryStorage;
  readonly search?: MemorySearch;
  readonly signer?: ReturnType<typeof createHmacAuditAnchorAuthenticator>;
  readonly written?: ImmutableAuditObject[];
}) {
  const signer =
    input.signer ??
    createHmacAuditAnchorAuthenticator(
      "tenant-delete-test",
      "tenant-delete-test-secret-at-least-32-bytes",
    );
  return new TenantDeletionWorkflow({
    store: input.store,
    storageResolver: () => ({
      client: input.storage,
      managedBy: "helix-default",
      prefix: "tenant/",
    }),
    proofStore: {
      async putObject(object) {
        input.written?.push(object);
      },
    },
    signer,
    ...(input.search === undefined ? {} : { search: input.search }),
    cache: {
      async purgeTenant() {
        return 2;
      },
    },
    secrets: {
      async deleteTenantSecrets() {
        return 3;
      },
    },
    now: () => new Date("2026-02-01T00:00:00.000Z"),
  });
}

class MemoryStorage {
  readonly keys: Set<string>;
  failOnceFor: string | undefined;

  constructor(keys: readonly string[]) {
    this.keys = new Set(keys);
  }

  async put(object: StorageObject) {
    this.keys.add(object.key);
  }
  async get() {
    return null;
  }
  async delete(key: string) {
    if (this.failOnceFor === key) {
      this.failOnceFor = undefined;
      throw new Error("object delete failed");
    }
    this.keys.delete(key);
  }
  async *listKeys(prefix: string) {
    yield* [...this.keys].filter((key) => key.startsWith(prefix));
  }
}

class MemorySearch implements SearchEngine {
  readonly id = "memory";
  constructor(readonly documents: string[]) {}
  async index() {}
  async upsert() {}
  async delete(ids: readonly string[]) {
    for (const id of ids) {
      const index = this.documents.indexOf(id);
      if (index >= 0) this.documents.splice(index, 1);
    }
  }
  async search(_request: SearchRequest): Promise<SearchResponse> {
    return {
      query: "",
      hits: this.documents.map((id) => ({
        id,
        type: "drive",
        title: id,
        body: "",
        attributes: {},
      })),
    };
  }
}

class MemoryStore implements TenantDeletionStore {
  record = proof();
  sqlPurges = 0;
  async prepare() {
    return this.record;
  }
  async recordStep() {}
  async purgeSql() {
    this.sqlPurges += 1;
    return { objects: 2 };
  }
  async complete(input: Parameters<TenantDeletionStore["complete"]>[0]) {
    this.record = proof({
      status: "completed",
      manifest: input.manifest,
      manifestSha256: input.manifestSha256,
      proofSignature: input.proofSignature,
      proofKeyId: input.proofKeyId,
      proofObjectKey: input.proofObjectKey,
      completedAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    return this.record;
  }
  async find() {
    return this.record;
  }
}

function proof(overrides: Partial<TenantDeletionProofRecord> = {}): TenantDeletionProofRecord {
  return {
    orgId: org.id,
    status: "running",
    attemptCount: 1,
    objectKeys: [],
    blockers: [],
    systemActorId: "22222222-2222-4222-8222-222222222222",
    sqlCounts: {},
    manifest: null,
    manifestSha256: null,
    proofSignature: null,
    proofKeyId: null,
    proofObjectKey: null,
    completedAt: null,
    ...overrides,
  };
}
