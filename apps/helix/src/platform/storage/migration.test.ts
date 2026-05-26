import { createHash } from "node:crypto";
import type postgres from "postgres";
import { describe, expect, it } from "vitest";
import type { StorageObject } from "@helix/sdk-types";
import {
  createTenantStorageMigrationPairResolver,
  listTenantStorageMigrationObjects,
  PostgresTenantStorageMigrationJobStore,
  runTenantStorageMigration,
  TenantStorageMigrationWorker,
  type TenantStorageMigrationJobRecord,
  type TenantStorageMigrationJobStore,
  type TenantStorageMigrationMetrics,
  type TenantStorageMigrationObservabilitySnapshot,
} from "./migration.js";
import type { TenantStorageClient } from "./tenant-resolver.js";

describe("runTenantStorageMigration", () => {
  it("copies unique logical keys from source to destination and verifies hashes", async () => {
    const source = new MemoryStorageClient();
    const destination = new MemoryStorageClient();
    source.seed({
      key: "drive/report.txt",
      body: new TextEncoder().encode("launch report"),
      contentType: "text/plain",
      metadata: { origin: "helix-default" },
    });

    const result = await runTenantStorageMigration({
      orgId: "org-1",
      target: "byo",
      source,
      destination,
      now: fixedClock(),
      objects: [
        {
          storageKey: "/drive/report.txt",
          byteSize: "launch report".length,
          sha256: sha256("launch report"),
        },
        {
          storageKey: "drive/report.txt",
          byteSize: "launch report".length,
          sha256: sha256("launch report"),
        },
      ],
    });

    expect(result).toEqual({
      orgId: "org-1",
      target: "byo",
      status: "completed",
      startedAt: "2026-05-24T10:00:00.000Z",
      completedAt: "2026-05-24T10:00:01.000Z",
      plannedCount: 1,
      copiedCount: 1,
      verifiedCount: 1,
      failures: [],
    });
    await expect(storageObjectText(await destination.get("drive/report.txt"))).resolves.toBe(
      "launch report",
    );
    expect(destination.objects.get("drive/report.txt")?.contentType).toBe("text/plain");
    expect(destination.objects.get("drive/report.txt")?.metadata).toEqual({
      origin: "helix-default",
    });
  });

  it("supports dry-run planning without mutating the destination", async () => {
    const source = new MemoryStorageClient();
    const destination = new MemoryStorageClient();
    source.seed({
      key: "drive/report.txt",
      body: new TextEncoder().encode("launch report"),
    });

    const result = await runTenantStorageMigration({
      orgId: "org-1",
      target: "helix-default",
      source,
      destination,
      dryRun: true,
      now: fixedClock(),
      objects: [{ storageKey: "drive/report.txt" }],
    });

    expect(result).toMatchObject({
      status: "dry_run",
      plannedCount: 1,
      copiedCount: 0,
      verifiedCount: 0,
      failures: [],
    });
    expect(await destination.get("drive/report.txt")).toBeNull();
  });

  it("reports missing source objects and verification failures without aborting the job", async () => {
    const source = new MemoryStorageClient();
    const destination = new MemoryStorageClient();
    source.seed({
      key: "drive/bad-hash.txt",
      body: new TextEncoder().encode("unexpected"),
    });
    source.seed({
      key: "drive/good.txt",
      body: new TextEncoder().encode("good"),
    });

    const result = await runTenantStorageMigration({
      orgId: "org-1",
      target: "byo",
      source,
      destination,
      now: fixedClock(),
      objects: [
        { storageKey: "drive/missing.txt" },
        { storageKey: "drive/bad-hash.txt", sha256: sha256("expected") },
        { storageKey: "drive/good.txt", sha256: sha256("good") },
      ],
    });

    expect(result.status).toBe("completed_with_errors");
    expect(result.copiedCount).toBe(1);
    expect(result.verifiedCount).toBe(1);
    expect(result.failures).toEqual([
      { storageKey: "drive/missing.txt", reason: "Source object was not found." },
      { storageKey: "drive/bad-hash.txt", reason: "Object sha256 mismatch." },
    ]);
    await expect(storageObjectText(await destination.get("drive/good.txt"))).resolves.toBe("good");
    expect(await destination.get("drive/bad-hash.txt")).toBeNull();
  });
});

describe("listTenantStorageMigrationObjects", () => {
  it("builds a DB-backed logical key inventory across current objects, versions, and previews", async () => {
    const recording = createRecordingSql([
      [
        {
          storage_key: "drive/current.txt",
          byte_size: 10,
          sha256: sha256("current"),
        },
        {
          storage_key: "drive/version-1.txt",
          byte_size: 9,
          sha256: sha256("version"),
        },
        {
          storage_key: "sheets/org-1/sheet-1/versions/2",
          byte_size: 512,
          sha256: sha256("sheet-version"),
        },
        {
          storage_key: "slides/org-1/deck-1/versions/3",
          byte_size: 768,
          sha256: sha256("slide-version"),
        },
        {
          storage_key: "previews/current.pdf",
          byte_size: null,
          sha256: null,
        },
      ],
    ]);

    const inventory = await listTenantStorageMigrationObjects(recording.sql, "org-1");

    expect(inventory).toEqual([
      {
        storageKey: "drive/current.txt",
        byteSize: 10,
        sha256: sha256("current"),
      },
      {
        storageKey: "drive/version-1.txt",
        byteSize: 9,
        sha256: sha256("version"),
      },
      {
        storageKey: "sheets/org-1/sheet-1/versions/2",
        byteSize: 512,
        sha256: sha256("sheet-version"),
      },
      {
        storageKey: "slides/org-1/deck-1/versions/3",
        byteSize: 768,
        sha256: sha256("slide-version"),
      },
      {
        storageKey: "previews/current.pdf",
      },
    ]);
    expect(recording.calls).toHaveLength(1);
    expect(recording.calls[0]?.text).toContain("from objects");
    expect(recording.calls[0]?.text).toContain("from drive_versions v");
    expect(recording.calls[0]?.text).toContain("metadata->'preview'->>'storageKey'");
    expect(recording.calls[0]?.text).toContain("distinct on (stored.storage_key)");
    expect(recording.calls[0]?.values).toEqual(["org-1", "org-1", "org-1"]);
  });
});

describe("PostgresTenantStorageMigrationJobStore", () => {
  it("creates, claims, and completes durable tenant storage migration jobs", async () => {
    const startedAt = new Date("2026-05-24T10:00:00.000Z");
    const recording = createRecordingSql([
      [
        jobRow({
          id: "job-1",
          status: "queued",
          started_at: null,
          completed_at: null,
        }),
      ],
      [
        jobRow({
          id: "job-1",
          status: "running",
          attempt_count: 1,
          started_at: startedAt,
          completed_at: null,
        }),
      ],
      [
        jobRow({
          id: "job-1",
          status: "succeeded_with_errors",
          planned_count: 2,
          copied_count: 1,
          verified_count: 1,
          failures: [{ storageKey: "drive/missing.txt", reason: "Source object was not found." }],
          started_at: startedAt,
          completed_at: new Date("2026-05-24T10:01:00.000Z"),
        }),
      ],
    ]);
    const store = new PostgresTenantStorageMigrationJobStore(recording.sql);

    const created = await store.create({
      orgId: "org-1",
      target: "byo",
      dryRun: true,
      requestedByActorId: "actor-1",
      sourceStorage: {
        managedBy: "helix-default",
        storage: { kind: "helix-default", prefix: "tenants/org-1/" },
      },
      targetStorage: {
        managedBy: "byo",
        storage: { kind: "byo", provider: "aws-s3", bucket: "customer-bucket" },
      },
    });
    const claimed = await store.claimPending({ limit: 1 });
    const completed = await store.markCompleted({
      id: "job-1",
      result: {
        orgId: "org-1",
        target: "byo",
        status: "completed_with_errors",
        startedAt: "2026-05-24T10:00:00.000Z",
        completedAt: "2026-05-24T10:01:00.000Z",
        plannedCount: 2,
        copiedCount: 1,
        verifiedCount: 1,
        failures: [{ storageKey: "drive/missing.txt", reason: "Source object was not found." }],
      },
    });

    expect(created).toMatchObject({ id: "job-1", status: "queued", dryRun: true });
    expect(created.sourceStorage).toEqual({
      managedBy: "helix-default",
      storage: { kind: "helix-default", prefix: "tenants/org-1/" },
    });
    expect(created.targetStorage).toEqual({
      managedBy: "byo",
      storage: { kind: "byo", provider: "aws-s3", bucket: "customer-bucket" },
    });
    expect(claimed[0]).toMatchObject({ id: "job-1", status: "running", attemptCount: 1 });
    expect(completed).toMatchObject({
      id: "job-1",
      status: "succeeded_with_errors",
      plannedCount: 2,
      copiedCount: 1,
      verifiedCount: 1,
    });
    expect(recording.calls[1]?.text).toContain("for update skip locked");
    expect(recording.calls[2]?.values).toContain("succeeded_with_errors");
    expect(recording.calls[0]?.text).toContain("source_storage");
    expect(recording.calls[0]?.text).toContain("target_storage");
  });

  it("builds low-cardinality observability snapshots for active and stalled jobs", async () => {
    const recording = createRecordingSql([
      [
        { target: "byo", status: "running", count: "2" },
        { target: "helix-default", status: "failed", count: 1 },
      ],
      [{ target: "byo", count: "1", oldest_age_seconds: "2400" }],
    ]);
    const store = new PostgresTenantStorageMigrationJobStore(recording.sql);

    const snapshot = await store.getObservabilitySnapshot({
      stalledBefore: new Date("2026-05-24T10:00:00.000Z"),
      now: new Date("2026-05-24T10:40:00.000Z"),
    });

    expect(snapshot).toEqual({
      activeJobs: [
        { target: "byo", status: "running", count: 2 },
        { target: "helix-default", status: "failed", count: 1 },
      ],
      stalledJobs: [{ target: "byo", count: 1, oldestAgeSeconds: 2400 }],
    });
    expect(recording.calls[0]?.text).toContain("group by target, status");
    expect(recording.calls[1]?.text).toContain("updated_at < ?");
  });
});

describe("TenantStorageMigrationWorker", () => {
  it("claims queued jobs, runs the copy engine, and persists completed results", async () => {
    const source = new MemoryStorageClient();
    const destination = new MemoryStorageClient();
    source.seed({
      key: "drive/report.txt",
      body: new TextEncoder().encode("launch report"),
    });
    const store = new InMemoryTenantStorageMigrationJobStore([
      migrationJob({
        id: "job-1",
        orgId: "org-1",
        target: "byo",
        sourceStorage: { managedBy: "helix-default", storage: null },
        targetStorage: {
          managedBy: "byo",
          storage: { kind: "byo", provider: "aws-s3", bucket: "customer-bucket" },
        },
      }),
    ]);
    const worker = new TenantStorageMigrationWorker({
      store,
      listObjects: () => [
        {
          storageKey: "drive/report.txt",
          byteSize: "launch report".length,
          sha256: sha256("launch report"),
        },
      ],
      resolveStoragePair: () => ({ source, destination }),
    });

    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      dryRun: 0,
      failed: 0,
    });

    expect(store.completed[0]?.result).toMatchObject({
      orgId: "org-1",
      target: "byo",
      status: "completed",
      plannedCount: 1,
      copiedCount: 1,
      verifiedCount: 1,
    });
    await expect(storageObjectText(await destination.get("drive/report.txt"))).resolves.toBe(
      "launch report",
    );
  });

  it("marks jobs failed when source and destination storage cannot be resolved", async () => {
    const store = new InMemoryTenantStorageMigrationJobStore([
      migrationJob({
        id: "job-1",
        orgId: "org-1",
        target: "byo",
        sourceStorage: { managedBy: "helix-default", storage: null },
        targetStorage: {
          managedBy: "byo",
          storage: { kind: "byo", provider: "aws-s3", bucket: "customer-bucket" },
        },
      }),
    ]);
    const worker = new TenantStorageMigrationWorker({
      store,
      listObjects: () => [],
      resolveStoragePair: () => {
        throw new Error("BYO storage config is not ready.");
      },
    });

    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      dryRun: 0,
      failed: 1,
    });
    expect(store.failed).toEqual([{ id: "job-1", error: "BYO storage config is not ready." }]);
  });

  it("records migration job and stalled-job metrics after worker runs", async () => {
    const store = new InMemoryTenantStorageMigrationJobStore(
      [
        migrationJob({
          id: "job-1",
          orgId: "org-1",
          target: "byo",
          sourceStorage: { managedBy: "helix-default", storage: null },
          targetStorage: {
            managedBy: "byo",
            storage: { kind: "byo", provider: "aws-s3", bucket: "customer-bucket" },
          },
        }),
      ],
      {
        activeJobs: [{ target: "byo", status: "failed", count: 1 }],
        stalledJobs: [{ target: "byo", count: 1, oldestAgeSeconds: 1_900 }],
      },
    );
    const metrics = new RecordingTenantStorageMigrationMetrics();
    const worker = new TenantStorageMigrationWorker({
      store,
      metrics,
      now: () => new Date("2026-05-24T10:40:00.000Z"),
      stalledAfterMs: 30 * 60_000,
      listObjects: () => [],
      resolveStoragePair: () => {
        throw new Error("BYO storage config is not ready.");
      },
    });

    await worker.runOnce();

    expect(metrics.jobs).toEqual([{ target: "byo", status: "failed" }]);
    expect(metrics.snapshots).toEqual([
      {
        activeJobs: [{ target: "byo", status: "failed", count: 1 }],
        stalledJobs: [{ target: "byo", count: 1, oldestAgeSeconds: 1_900 }],
      },
    ]);
    expect(store.stalledBeforeValues).toEqual([new Date("2026-05-24T10:10:00.000Z")]);
  });

  it("does not fail completed migration work when metrics snapshot refresh fails", async () => {
    const store = new InMemoryTenantStorageMigrationJobStore(
      [
        migrationJob({
          id: "job-1",
          orgId: "org-1",
          target: "byo",
          dryRun: true,
        }),
      ],
      new Error("metrics snapshot unavailable"),
    );
    const errors: unknown[] = [];
    const worker = new TenantStorageMigrationWorker({
      store,
      metrics: new RecordingTenantStorageMigrationMetrics(),
      listObjects: () => [{ storageKey: "drive/report.txt" }],
      resolveStoragePair: () => {
        throw new Error("storage pair should not be resolved for dry-run jobs");
      },
      onError: (error) => {
        errors.push(error);
      },
    });

    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      dryRun: 1,
      failed: 0,
    });
    expect(store.completed).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(new Error("metrics snapshot unavailable"));
  });

  it("fails live jobs before copy when staged storage snapshots are missing", async () => {
    const store = new InMemoryTenantStorageMigrationJobStore([
      migrationJob({ id: "job-1", orgId: "org-1", target: "byo" }),
    ]);
    const worker = new TenantStorageMigrationWorker({
      store,
      listObjects: () => [{ storageKey: "drive/report.txt" }],
      resolveStoragePair: () => {
        throw new Error("storage pair should not be resolved without staged snapshots");
      },
    });

    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      dryRun: 0,
      failed: 1,
    });
    expect(store.failed).toEqual([
      {
        id: "job-1",
        error: "Live tenant storage migration requires staged source and target storage snapshots.",
      },
    ]);
  });

  it("fails live rollback jobs before copy when the BYO source snapshot is missing", async () => {
    const store = new InMemoryTenantStorageMigrationJobStore([
      migrationJob({
        id: "job-1",
        orgId: "org-1",
        target: "helix-default",
        sourceStorage: { managedBy: "byo", storage: null },
        targetStorage: { managedBy: "helix-default", storage: null },
      }),
    ]);
    const worker = new TenantStorageMigrationWorker({
      store,
      listObjects: () => [{ storageKey: "drive/report.txt" }],
      resolveStoragePair: () => {
        throw new Error("storage pair should not be resolved without a staged BYO source");
      },
    });

    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      dryRun: 0,
      failed: 1,
    });
    expect(store.failed).toEqual([
      {
        id: "job-1",
        error: "Live migration to helix-default requires a staged BYO source storage config.",
      },
    ]);
  });

  it("plans dry-run jobs without resolving storage credentials", async () => {
    const store = new InMemoryTenantStorageMigrationJobStore([
      migrationJob({ id: "job-1", orgId: "org-1", target: "byo", dryRun: true }),
    ]);
    const worker = new TenantStorageMigrationWorker({
      store,
      listObjects: () => [{ storageKey: "drive/report.txt" }],
      resolveStoragePair: () => {
        throw new Error("storage pair should not be resolved for dry-run jobs");
      },
    });

    await expect(worker.runOnce()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      dryRun: 1,
      failed: 0,
    });
    expect(store.completed[0]?.result).toMatchObject({
      status: "dry_run",
      plannedCount: 1,
    });
    expect(store.failed).toEqual([]);
  });
});

describe("createTenantStorageMigrationPairResolver", () => {
  it("uses staged storage snapshots without consulting current tenant config", async () => {
    const source = new MemoryStorageClient();
    const destination = new MemoryStorageClient();
    const seenStates: unknown[] = [];
    const resolver = createTenantStorageMigrationPairResolver({
      currentStorageResolver: async () => {
        throw new Error("current storage should not be consulted");
      },
      helixDefaultStorageResolver: async () => {
        throw new Error("helix-default storage should not be consulted");
      },
      snapshotStorageResolver: ({ state }) => {
        seenStates.push(state);
        return {
          client: state.managedBy === "helix-default" ? source : destination,
          managedBy: state.managedBy,
          prefix: state.managedBy === "helix-default" ? "tenants/org-1/" : "customer/",
        };
      },
    });

    await expect(
      resolver(
        migrationJob({
          target: "byo",
          sourceStorage: {
            managedBy: "helix-default",
            storage: { kind: "helix-default", prefix: "tenants/org-1/" },
          },
          targetStorage: {
            managedBy: "byo",
            storage: { kind: "byo", provider: "aws-s3", bucket: "customer-bucket" },
          },
        }),
      ),
    ).resolves.toEqual({ source, destination });
    expect(seenStates).toEqual([
      { managedBy: "helix-default", storage: { kind: "helix-default", prefix: "tenants/org-1/" } },
      { managedBy: "byo", storage: { kind: "byo", provider: "aws-s3", bucket: "customer-bucket" } },
    ]);
  });

  it("requires a snapshot resolver when staged storage snapshots are present", async () => {
    const resolver = createTenantStorageMigrationPairResolver({
      currentStorageResolver: async () => {
        throw new Error("current storage should not be consulted");
      },
      helixDefaultStorageResolver: async () => {
        throw new Error("helix-default storage should not be consulted");
      },
    });

    await expect(
      resolver(
        migrationJob({
          sourceStorage: { managedBy: "helix-default", storage: null },
          targetStorage: {
            managedBy: "byo",
            storage: { kind: "byo", provider: "aws-s3", bucket: "customer-bucket" },
          },
        }),
      ),
    ).rejects.toThrow("Tenant storage snapshot resolver is not configured.");
  });

  it("resolves helix-default to BYO copy pairs only when BYO is active", async () => {
    const helixDefault = new MemoryStorageClient();
    const byo = new MemoryStorageClient();
    const resolver = createTenantStorageMigrationPairResolver({
      currentStorageResolver: async () => ({
        client: byo,
        managedBy: "byo",
        prefix: "customer/",
      }),
      helixDefaultStorageResolver: async () => ({
        client: helixDefault,
        managedBy: "helix-default",
        prefix: "tenants/org-1/",
      }),
    });

    await expect(resolver(migrationJob({ target: "byo" }))).resolves.toEqual({
      source: helixDefault,
      destination: byo,
    });
    await expect(resolver(migrationJob({ target: "helix-default" }))).resolves.toEqual({
      source: byo,
      destination: helixDefault,
    });
  });

  it("fails closed when the requested migration direction is ambiguous", async () => {
    const resolver = createTenantStorageMigrationPairResolver({
      currentStorageResolver: async () => ({
        client: new MemoryStorageClient(),
        managedBy: "helix-default",
        prefix: "tenants/org-1/",
      }),
      helixDefaultStorageResolver: async () => ({
        client: new MemoryStorageClient(),
        managedBy: "helix-default",
        prefix: "tenants/org-1/",
      }),
    });

    await expect(resolver(migrationJob({ target: "byo" }))).rejects.toThrow(
      "BYO storage config must be active before migrating to BYO.",
    );
    await expect(resolver(migrationJob({ target: "helix-default" }))).rejects.toThrow(
      "Tenant is not currently using BYO storage.",
    );
  });
});

class MemoryStorageClient implements TenantStorageClient {
  readonly objects = new Map<
    string,
    {
      readonly body: Uint8Array;
      readonly contentType?: string | undefined;
      readonly metadata?: Record<string, string> | undefined;
    }
  >();

  seed(object: StorageObject): void {
    if (!(object.body instanceof Uint8Array)) {
      throw new Error("Test storage seed expects Uint8Array bodies.");
    }
    this.objects.set(object.key, {
      body: object.body,
      ...(object.contentType === undefined ? {} : { contentType: object.contentType }),
      ...(object.metadata === undefined ? {} : { metadata: object.metadata }),
    });
  }

  async put(object: StorageObject): Promise<void> {
    if (!(object.body instanceof Uint8Array)) {
      throw new Error("Test storage put expects Uint8Array bodies.");
    }
    this.seed(object);
  }

  async get(key: string): Promise<StorageObject | null> {
    const object = this.objects.get(key);
    if (object === undefined) {
      return null;
    }
    return {
      key,
      body: object.body,
      ...(object.contentType === undefined ? {} : { contentType: object.contentType }),
      ...(object.metadata === undefined ? {} : { metadata: object.metadata }),
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

async function storageObjectText(object: StorageObject | null): Promise<string | null> {
  if (object === null) {
    return null;
  }
  if (!(object.body instanceof Uint8Array)) {
    throw new Error("Test storage object expects Uint8Array bodies.");
  }
  return new TextDecoder().decode(object.body);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixedClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 4, 24, 10, 0, tick++));
}

interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSql(responses: readonly (readonly unknown[])[]): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedQuery[];
} {
  const calls: RecordedQuery[] = [];
  let callIndex = 0;
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join("?"), values });
    return Promise.resolve(responses[callIndex++] ?? []);
  };
  return {
    sql: Object.assign(tag, {
      json: (value: unknown) => value,
      array: (value: unknown) => value,
    }) as unknown as postgres.Sql,
    calls,
  };
}

function jobRow(
  overrides: Partial<{
    readonly id: string;
    readonly org_id: string;
    readonly target: "byo" | "helix-default";
    readonly status:
      | "queued"
      | "running"
      | "succeeded"
      | "succeeded_with_errors"
      | "failed"
      | "dry_run";
    readonly dry_run: boolean;
    readonly requested_by_actor_id: string | null;
    readonly source_storage: Record<string, unknown> | null;
    readonly target_storage: Record<string, unknown> | null;
    readonly planned_count: number;
    readonly copied_count: number;
    readonly verified_count: number;
    readonly failures: readonly { readonly storageKey: string; readonly reason: string }[];
    readonly last_error: string | null;
    readonly attempt_count: number;
    readonly started_at: Date | null;
    readonly completed_at: Date | null;
    readonly created_at: Date;
    readonly updated_at: Date;
  }> = {},
): Record<string, unknown> {
  return {
    id: "job-1",
    org_id: "org-1",
    target: "byo",
    status: "queued",
    dry_run: true,
    requested_by_actor_id: "actor-1",
    source_storage: {
      managedBy: "helix-default",
      storage: { kind: "helix-default", prefix: "tenants/org-1/" },
    },
    target_storage: {
      managedBy: "byo",
      storage: { kind: "byo", provider: "aws-s3", bucket: "customer-bucket" },
    },
    planned_count: 0,
    copied_count: 0,
    verified_count: 0,
    failures: [],
    last_error: null,
    attempt_count: 0,
    started_at: null,
    completed_at: null,
    created_at: new Date("2026-05-24T09:59:00.000Z"),
    updated_at: new Date("2026-05-24T09:59:00.000Z"),
    ...overrides,
  };
}

function migrationJob(
  overrides: Partial<TenantStorageMigrationJobRecord> = {},
): TenantStorageMigrationJobRecord {
  return {
    id: "job-1",
    orgId: "org-1",
    target: "byo",
    status: "queued",
    dryRun: false,
    requestedByActorId: null,
    sourceStorage: null,
    targetStorage: null,
    plannedCount: 0,
    copiedCount: 0,
    verifiedCount: 0,
    failures: [],
    lastError: null,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    createdAt: new Date("2026-05-24T09:59:00.000Z"),
    updatedAt: new Date("2026-05-24T09:59:00.000Z"),
    ...overrides,
  };
}

class InMemoryTenantStorageMigrationJobStore implements Pick<
  TenantStorageMigrationJobStore,
  "claimPending" | "getObservabilitySnapshot" | "markCompleted" | "markFailed"
> {
  readonly completed: Parameters<TenantStorageMigrationJobStore["markCompleted"]>[0][] = [];
  readonly failed: Parameters<TenantStorageMigrationJobStore["markFailed"]>[0][] = [];
  readonly stalledBeforeValues: Date[] = [];

  constructor(
    private readonly jobs: TenantStorageMigrationJobRecord[],
    private readonly snapshot: Error | TenantStorageMigrationObservabilitySnapshot = {
      activeJobs: [],
      stalledJobs: [],
    },
  ) {}

  async claimPending(): Promise<readonly TenantStorageMigrationJobRecord[]> {
    return this.jobs.splice(0, this.jobs.length).map((job) => ({
      ...job,
      status: "running",
      attemptCount: job.attemptCount + 1,
      startedAt: new Date("2026-05-24T10:00:00.000Z"),
    }));
  }

  async markCompleted(
    input: Parameters<TenantStorageMigrationJobStore["markCompleted"]>[0],
  ): Promise<TenantStorageMigrationJobRecord> {
    this.completed.push(input);
    return migrationJob({
      id: input.id,
      orgId: input.result.orgId,
      target: input.result.target,
      status: input.result.status === "dry_run" ? "dry_run" : "succeeded",
      plannedCount: input.result.plannedCount,
      copiedCount: input.result.copiedCount,
      verifiedCount: input.result.verifiedCount,
      failures: input.result.failures,
    });
  }

  async markFailed(
    input: Parameters<TenantStorageMigrationJobStore["markFailed"]>[0],
  ): Promise<TenantStorageMigrationJobRecord> {
    this.failed.push(input);
    return migrationJob({ id: input.id, status: "failed", lastError: input.error });
  }

  async getObservabilitySnapshot(input: {
    readonly stalledBefore: Date;
  }): Promise<TenantStorageMigrationObservabilitySnapshot> {
    this.stalledBeforeValues.push(input.stalledBefore);
    if (this.snapshot instanceof Error) {
      throw this.snapshot;
    }
    return this.snapshot;
  }
}

class RecordingTenantStorageMigrationMetrics implements TenantStorageMigrationMetrics {
  readonly jobs: Parameters<TenantStorageMigrationMetrics["recordTenantStorageMigrationJob"]>[0][] =
    [];
  readonly snapshots: TenantStorageMigrationObservabilitySnapshot[] = [];

  recordTenantStorageMigrationJob(
    input: Parameters<TenantStorageMigrationMetrics["recordTenantStorageMigrationJob"]>[0],
  ): void {
    this.jobs.push(input);
  }

  setTenantStorageMigrationObservability(
    snapshot: TenantStorageMigrationObservabilitySnapshot,
  ): void {
    this.snapshots.push(snapshot);
  }
}
