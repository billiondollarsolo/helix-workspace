import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FederationBackupWorker, recoveryServer } from "./federation-worker.js";
import { persist, workerConfiguration } from "./federation-worker-state.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(options: { interval?: number; command?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "federation-backup-worker-"));
  directories.push(directory);
  const management = join(directory, "management.key"),
    restore = join(directory, "restore.key");
  writeFileSync(management, "a".repeat(64), { mode: 0o600 });
  writeFileSync(restore, "b".repeat(64), { mode: 0o600 });
  const script =
    options.command ??
    `const fs=require('node:fs');const {request,source}=JSON.parse(fs.readFileSync(process.env.HELIX_FEDERATION_BACKUP_REQUEST_FILE,'utf8'));const now=new Date().toISOString();const result=source||{backupId:request.id,createdAt:now,artifactDigest:'a'.repeat(64),manifestDigest:'b'.repeat(64),encrypted:true,destinationRef:'offsite',retentionDays:30,offHost:true,keyCustodyRef:'vault:fixture',coverage:['database','files','configuration'],appVersion:'fixture',schemaVersion:'1',databaseRecoveryPoint:now,objectRecoveryPoint:null,verifiedAt:null,restoredAt:null,targetDatabase:null,targetObjectBucket:null};if(request.kind!=='backup')result.verifiedAt=now;if(request.kind==='restore'){result.restoredAt=now;result.targetDatabase=request.targetDatabase;result.targetObjectBucket=request.targetObjectBucket??null;}fs.writeFileSync(process.env.HELIX_FEDERATION_BACKUP_RECEIPT_FILE,JSON.stringify(result),{mode:0o600});`;
  const config = workerConfiguration.parse({
    binding: {
      application: "bot",
      installationId: randomUUID(),
      tenantId: randomUUID(),
      orgId: randomUUID(),
      connectionId: randomUUID(),
    },
    stateDirectory: join(directory, "state"),
    managementKeyFile: management,
    restoreKeyFile: restore,
    scheduler: "worker",
    localSchedulerDisabled: true,
    destinations: ["offsite"],
    minimumRetentionDays: 30,
    requiredCoverage: ["database", "files", "configuration"],
    initialPolicy: {
      revision: 0,
      enabled: false,
      intervalMinutes: 5,
      retentionDays: 30,
      destinationRef: "offsite",
    },
    commands: {
      backup: [process.execPath, "-e", script],
      verify: [process.execPath, "-e", script],
      restore: [process.execPath, "-e", script],
    },
    timeoutSeconds: 1,
  });
  return { directory, config, worker: new FederationBackupWorker(config) };
}
describe("independent federation backup worker", () => {
  it("rejects symlinked journals and requires an explicit scheduler handoff", () => {
    const { config } = fixture();
    expect(
      () => new FederationBackupWorker({ ...config, localSchedulerDisabled: false }),
    ).toThrow();
    const alias = join(config.stateDirectory, "../alias");
    symlinkSync(config.stateDirectory, alias);
    expect(() => new FederationBackupWorker({ ...config, stateDirectory: alias })).toThrow(
      "symbolic links",
    );
  });
  it("expires queued restore authority while the source is unavailable", async () => {
    const { worker } = fixture();
    const id = randomUUID();
    worker.request({ id, kind: "backup" });
    await worker.runOnce();
    worker.request({ id: randomUUID(), kind: "verify", backupId: id });
    await worker.runOnce();
    const job = worker.request(
      { id: randomUUID(), kind: "restore", backupId: id, targetDatabase: "helix_restore_expired" },
      new Date(Date.now() + 25000).toISOString(),
    );
    job.authorityExpiresAt = new Date(Date.now() - 1000).toISOString();
    await worker.runOnce();
    expect(job.status).toBe("failed");
    expect(job.error).toBe("source_unavailable");
    expect(job.receipt).toBeNull();
  });

  it("runs one durable operation, verifies exact artifacts and restores only to isolated targets", async () => {
    const { worker } = fixture(),
      id = randomUUID();
    worker.request({ id, kind: "backup" });
    await worker.runOnce();
    expect(worker.state.jobs[0]?.status).toBe("completed");
    expect(worker.request({ id, kind: "backup" }).receipt?.backupId).toBe(id);
    expect(() => worker.request({ id, kind: "verify", backupId: id })).toThrow("different input");
    expect(() =>
      worker.request({
        id: randomUUID(),
        kind: "restore",
        backupId: id,
        targetDatabase: "production",
        targetObjectBucket: "production",
      }),
    ).toThrow();
    const verify = randomUUID();
    worker.request({ id: verify, kind: "verify", backupId: id });
    await worker.runOnce();
    const restore = randomUUID();
    worker.request(
      {
        id: restore,
        kind: "restore",
        backupId: id,
        targetDatabase: "helix_restore_fixture",
        targetObjectBucket: "helix-restore-fixture",
      },
      new Date(Date.now() + 25000).toISOString(),
    );
    await worker.runOnce();
    expect(worker.state.jobs.at(-1)?.status).toBe("completed");
    expect(worker.status().alerts).not.toContain("restore_drill_missing");
  });
  it("retains acknowledged policy while Workspace is offline and rejects stale/reordered policy", async () => {
    const { config, worker } = fixture();
    const policy = { ...config.initialPolicy, revision: 1, enabled: true };
    worker.setPolicy(policy);
    expect(() => worker.setPolicy({ ...policy, revision: 0 })).toThrow("older");
    expect(() => worker.setPolicy({ ...policy, retentionDays: 1 })).toThrow("retention");
    await worker.runOnce();
    const reopened = new FederationBackupWorker(config);
    await reopened.runOnce();
    expect(reopened.state.jobs).toHaveLength(1);
    expect(reopened.state.policy).toEqual(policy);
    expect(
      () =>
        new FederationBackupWorker({
          ...config,
          binding: { ...config.binding, orgId: randomUUID() },
        }),
    ).toThrow("another installation");
  });
  it("never replays unknown jobs on restart or command timeout", async () => {
    const { config, worker } = fixture({ command: "setInterval(()=>{},1000)" });
    worker.request({ id: randomUUID(), kind: "backup" });
    await worker.runOnce();
    expect(worker.state.jobs[0]?.status).toBe("unknown");
    const reopened = new FederationBackupWorker(config);
    await reopened.runOnce();
    expect(() => reopened.request({ id: randomUUID(), kind: "backup" })).toThrow("reconciliation");
    const journal = JSON.parse(readFileSync(join(config.stateDirectory, "state.json"), "utf8")) as {
      jobs: { status: string }[];
    };
    if (journal.jobs[0]) journal.jobs[0].status = "running";
    persist(join(config.stateDirectory, "state.json"), journal);
    expect(new FederationBackupWorker(config).state.jobs[0]?.status).toBe("unknown");
  });
  it("requires independent credentials, rejects browser cookies and acknowledges lost detach replies only", async () => {
    const { worker } = fixture(),
      server = recoveryServer(worker);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener");
    const call = (path: string, key: string, method = "GET", body?: unknown, cookie = false) =>
      fetch(`http://127.0.0.1:${String(address.port)}/v1/federation-operations${path}`, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          ...(cookie ? { cookie: "session=not-allowed" } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    try {
      expect((await call("/status", "c".repeat(64))).status).toBe(401);
      expect((await call("/status", "a".repeat(64), "GET", undefined, true)).status).toBe(401);
      expect((await call("/status", "b".repeat(64))).status).toBe(200);
      expect(
        (await call("/jobs", "b".repeat(64), "POST", { id: randomUUID(), kind: "backup" })).status,
      ).toBe(401);
      expect((await call("/detach", "a".repeat(64), "POST", {})).status).toBe(200);
      expect((await call("/detach", "a".repeat(64), "POST", {})).status).toBe(200);
      expect((await call("/status", "a".repeat(64))).status).toBe(401);
      expect((await call("/status", "b".repeat(64))).status).toBe(401);
      expect(worker.state.owner).toBe("local");
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  });
});
