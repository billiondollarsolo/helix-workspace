import { describe, expect, it, vi } from "vitest";
import type postgres from "postgres";
import type { SecurityScanResult } from "@helix/contracts";
import type { DriveStorageClient } from "./store.js";
import {
  DriveUploadScanWorker,
  PostgresDriveScanJobRepository,
  createDriveUploadScanWorker,
  type DriveScanJob,
  type DriveScanJobRepository,
  type DriveScanSettlement,
} from "./scan-worker.js";
import { createNoopVirusScanner, type VirusScanner } from "./scanning.js";

const now = "2026-07-28T12:00:00.000Z";
const job: DriveScanJob = {
  id: "scan-1",
  orgId: "11111111-1111-4111-8111-111111111111",
  objectId: "22222222-2222-4222-8222-222222222222",
  versionId: "33333333-3333-4333-8333-333333333333",
  requestedByActorId: "44444444-4444-4444-8444-444444444444",
  storageKey: "drive/file.bin",
  byteSize: 3,
  sha256: "a".repeat(64),
  attempts: 1,
  maxAttempts: 3,
  uploadState: "scanning",
  deletedAt: null,
};

class FakeRepository implements DriveScanJobRepository {
  readonly settlements: DriveScanSettlement[] = [];
  claimed = false;

  constructor(readonly jobs: readonly DriveScanJob[]) {}

  async claim(input: { readonly limit: number }): Promise<readonly DriveScanJob[]> {
    if (this.claimed) return [];
    this.claimed = true;
    return this.jobs.slice(0, input.limit);
  }

  async settle(input: { readonly settlement: DriveScanSettlement }): Promise<boolean> {
    this.settlements.push(input.settlement);
    return true;
  }
}

function scan(state: SecurityScanResult["state"], byteSize = 3): SecurityScanResult {
  const evidence = {
    scannerName: "clamav",
    scannerVersion: "1.4.3/27388",
    startedAt: now,
    completedAt: now,
    byteSize,
  };
  return state === "infected"
    ? { state, evidence: { ...evidence, signature: "Eicar-Test-Signature" } }
    : { state, evidence };
}

function storage(body: Uint8Array | AsyncIterable<Uint8Array>): DriveStorageClient {
  return {
    async put() {},
    async get(key) {
      return { key, body };
    },
    async delete() {},
  };
}

describe("DriveUploadScanWorker", () => {
  it("claims durable jobs with skip-locked leases and persisted attempt limits", async () => {
    const calls: string[] = [];
    let queryIndex = 0;
    const tag = (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      calls.push(text);
      queryIndex += 1;
      return Promise.resolve(
        queryIndex === 1
          ? [
              {
                id: job.id,
                org_id: job.orgId,
                object_id: job.objectId,
                version_id: job.versionId,
                requested_by_actor_id: job.requestedByActorId,
                owner_actor_id: job.requestedByActorId,
                storage_key: job.storageKey,
                byte_size: job.byteSize,
                sha256: job.sha256,
                attempts: 2,
                max_attempts: job.maxAttempts,
                upload_state: "uploaded",
                deleted_at: null,
              },
            ]
          : [],
      );
    };
    const sql = Object.assign(tag, {
      begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
        callback(sql as unknown as postgres.TransactionSql),
    }) as unknown as postgres.Sql;
    const repository = new PostgresDriveScanJobRepository(sql);

    await expect(
      repository.claim({ workerId: "worker-a", limit: 2, leaseMs: 60_000 }),
    ).resolves.toMatchObject([{ id: job.id, attempts: 2, uploadState: "uploaded" }]);
    expect(calls[0]).toContain("for update skip locked");
    expect(calls[0]).toContain("j.lease_expires_at < now()");
    expect(calls[0]).toContain("j.attempts < j.max_attempts");
    expect(calls[0]).toContain("attempts = attempts + 1");
    expect(calls[1]).toContain("upload_state = 'scanning'");
  });

  it("discards a late result when the object is no longer scanning", async () => {
    const calls: string[] = [];
    let queryIndex = 0;
    const tag = (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      calls.push(text);
      queryIndex += 1;
      return Promise.resolve(
        queryIndex === 1
          ? [
              {
                id: job.id,
                status: "running",
                lease_owner: "worker-a",
                upload_state: "active",
                deleted_at: null,
                sha256: job.sha256,
                current_version_id: job.versionId,
              },
            ]
          : [],
      );
    };
    const sql = Object.assign(tag, {
      begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
        callback(sql as unknown as postgres.TransactionSql),
      json: (value: unknown) => value,
    }) as unknown as postgres.Sql;
    const repository = new PostgresDriveScanJobRepository(sql);

    await expect(
      repository.settle({
        workerId: "worker-a",
        job,
        settlement: { kind: "active", scan: scan("clean"), disposition: "allow" },
      }),
    ).resolves.toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("status =");
    expect(calls.join("\n")).not.toContain("update objects");
    expect(calls.join("\n")).not.toContain("insert into activity");
  });

  it("activates only after a clean streaming verdict and is idempotent across drains", async () => {
    const repository = new FakeRepository([job]);
    const scanner: VirusScanner = {
      kind: "clamav",
      async scan(input) {
        expect(Symbol.asyncIterator in Object(input)).toBe(true);
        return { clean: true, disposition: "allow", securityScan: scan("clean") };
      },
    };
    const worker = new DriveUploadScanWorker({
      repository,
      scanner,
      storageForOrg: async () => storage(streamOf([1, 2, 3])),
    });

    await expect(worker.drainOnce()).resolves.toMatchObject({ claimed: 1, active: 1 });
    await expect(worker.drainOnce()).resolves.toMatchObject({ claimed: 0, active: 0 });
    expect(repository.settlements).toEqual([
      expect.objectContaining({ kind: "active", disposition: "allow" }),
    ]);
  });

  it("quarantines EICAR and cancels deleted files without scanning", async () => {
    const deleted = { ...job, id: "scan-deleted", deletedAt: new Date() };
    const repository = new FakeRepository([job, deleted]);
    const scanner: VirusScanner = {
      kind: "clamav",
      scan: vi.fn().mockResolvedValueOnce({
        clean: false,
        disposition: "quarantine",
        securityScan: scan("infected"),
      }),
    };
    const worker = new DriveUploadScanWorker({
      repository,
      scanner,
      concurrency: 2,
      storageForOrg: async () => storage(new Uint8Array([1, 2, 3])),
    });

    await expect(worker.drainOnce()).resolves.toMatchObject({
      claimed: 2,
      quarantined: 1,
      cancelled: 1,
    });
    expect(scanner.scan).toHaveBeenCalledTimes(1);
    expect(repository.settlements.map((item) => item.kind).sort()).toEqual([
      "cancelled",
      "quarantined",
    ]);
  });

  it("retries transient failures and reaches a terminal failure at the persisted limit", async () => {
    const retryRepository = new FakeRepository([job]);
    const terminalRepository = new FakeRepository([{ ...job, attempts: 3 }]);
    const scanner: VirusScanner = {
      kind: "clamav",
      async scan() {
        return {
          clean: false,
          disposition: "quarantine",
          securityScan: scan("scan_failed"),
        };
      },
    };
    const retryWorker = new DriveUploadScanWorker({
      repository: retryRepository,
      scanner,
      retryBaseMs: 100,
      storageForOrg: async () => storage(new Uint8Array([1, 2, 3])),
    });
    const terminalWorker = new DriveUploadScanWorker({
      repository: terminalRepository,
      scanner,
      storageForOrg: async () => storage(new Uint8Array([1, 2, 3])),
    });

    await retryWorker.drainOnce();
    await terminalWorker.drainOnce();

    expect(retryRepository.settlements[0]).toMatchObject({
      kind: "retry",
      errorCode: "scan_failed",
    });
    expect(terminalRepository.settlements[0]).toMatchObject({
      kind: "scan_failed",
      errorCode: "scan_failed",
    });
  });

  it("passes a logical 1 GiB object as bounded chunks without collecting it", async () => {
    const oneMiB = new Uint8Array(1024 * 1024);
    let yielded = 0;
    let maxChunk = 0;
    const logicalGiB = {
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 1024; index += 1) {
          yielded += oneMiB.byteLength;
          yield oneMiB;
        }
      },
    };
    const largeJob = { ...job, byteSize: 1024 ** 3 };
    const repository = new FakeRepository([largeJob]);
    const scanner: VirusScanner = {
      kind: "clamav",
      async scan(input) {
        let observed = 0;
        if (input instanceof Uint8Array || typeof input === "string") {
          throw new Error("Expected a streaming body");
        }
        for await (const chunk of input) {
          maxChunk = Math.max(maxChunk, chunk.byteLength);
          observed += chunk.byteLength;
        }
        return {
          clean: true,
          disposition: "allow",
          securityScan: scan("clean", observed),
        };
      },
    };
    const worker = new DriveUploadScanWorker({
      repository,
      scanner,
      storageForOrg: async () => storage(logicalGiB),
    });

    await expect(worker.drainOnce()).resolves.toMatchObject({ active: 1 });
    expect(yielded).toBe(1024 ** 3);
    expect(maxChunk).toBe(oneMiB.byteLength);
  });

  it("refuses Business boot when scanner resolution falls back to no-op", () => {
    expect(() =>
      createDriveUploadScanWorker({
        sql: {} as never,
        tier: "business",
        scanner: createNoopVirusScanner(),
      }),
    ).toThrow("Business Drive requires the real streaming ClamAV adapter");
  });

  it("does not start a worker without any scanner, even on Personal", () => {
    expect(() =>
      createDriveUploadScanWorker({
        sql: {} as never,
        tier: "personal",
        scanner: undefined,
      }),
    ).toThrow("Drive scan worker requires a configured malware scanner");
  });
});

async function* streamOf(bytes: readonly number[]): AsyncIterable<Uint8Array> {
  for (const byte of bytes) yield new Uint8Array([byte]);
}
