import type { AuditRecord } from "@helix/sdk";
import { describe, expect, it, vi } from "vitest";
import type { BackupOperationResult, RestoreExecutor } from "./admin-routes.js";
import { RestoreJobWorker, type RestoreJob, type RestoreJobStore } from "./restore-jobs.js";

const job: RestoreJob = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  orgId: "22222222-2222-4222-8222-222222222222",
  requestedByActorId: "11111111-1111-4111-8111-111111111111",
  backupId: "backup-20260520T120000Z",
  encrypted: false,
  targetDatabase: "helix_restore_incident_42",
  targetObjectBucket: "helix-restore-incident-42",
  status: "processing",
  approvalCount: 2,
  requiredApprovals: 2,
  attemptCount: 1,
  leaseToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  cancellationRequested: false,
};

describe("RestoreJobWorker", () => {
  it("audits execution before invoking the isolated restore and completing the lease", async () => {
    const events: string[] = [];
    const store = fakeStore({
      completeJob: async () => void events.push("state:completed"),
    });
    const executor: RestoreExecutor = {
      restoreBackup: async (input) => {
        events.push("execute");
        expect(input).toMatchObject({
          targetDatabase: job.targetDatabase,
          targetObjectBucket: job.targetObjectBucket,
        });
        return result;
      },
    };
    const worker = new RestoreJobWorker({
      store,
      executor,
      auditSink: { append: async (record) => void events.push(`audit:${record.verb}`) },
      owner: "test",
    });

    await expect(worker.drainOnce()).resolves.toBe(1);
    expect(events).toEqual([
      "audit:backup.restore.execution_started",
      "execute",
      "audit:backup.restore.completed",
      "state:completed",
    ]);
  });

  it("honours a durable cancellation before starting the restore", async () => {
    const executor = { restoreBackup: vi.fn<RestoreExecutor["restoreBackup"]>() };
    const markCancelled = vi.fn<RestoreJobStore["markCancelled"]>();
    const audit: (AuditRecord & { readonly orgId: string })[] = [];
    const worker = new RestoreJobWorker({
      store: fakeStore({ cancellationRequested: async () => true, markCancelled }),
      executor,
      auditSink: { append: async (record) => void audit.push(record) },
      owner: "test",
    });

    await worker.drainOnce();

    expect(executor.restoreBackup).not.toHaveBeenCalled();
    expect(markCancelled).toHaveBeenCalledWith(job);
    expect(audit.map((record) => record.verb)).toEqual([
      "backup.restore.execution_started",
      "backup.restore.cancelled",
    ]);
  });

  it("fails closed when immutable audit is unavailable", async () => {
    const executor = { restoreBackup: vi.fn<RestoreExecutor["restoreBackup"]>() };
    const failJob = vi.fn<RestoreJobStore["failJob"]>();
    const worker = new RestoreJobWorker({
      store: fakeStore({ failJob }),
      executor,
      auditSink: {
        append: async () => {
          throw new Error("audit unavailable");
        },
      },
      owner: "test",
    });

    await expect(worker.drainOnce()).rejects.toThrow("audit unavailable");
    expect(executor.restoreBackup).not.toHaveBeenCalled();
    expect(failJob).not.toHaveBeenCalled();
  });
});

const result: BackupOperationResult = {
  status: "completed",
  operationId: "restore-1",
  command: ["restore"],
  stdout: "",
  stderr: "",
};

function fakeStore(overrides: Partial<RestoreJobStore> = {}): RestoreJobStore {
  return {
    createJob: async () => job,
    getJob: async () => job,
    approveJob: async () => job,
    cancelJob: async () => job,
    claimJobs: async () => [job],
    cancellationRequested: async () => false,
    completeJob: async () => undefined,
    failJob: async () => undefined,
    markCancelled: async () => undefined,
    ...overrides,
  };
}
