import type { AuditRecord } from "@helix/sdk";
import type { Actor } from "@helix/sdk-types";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/test-actor.js";
import {
  registerBackupAdminRoutes,
  ScriptedBackupAdminService,
  type BackupAdminService,
  type BackupOperationResult,
  type RegisterBackupAdminRoutesOptions,
} from "./admin-routes.js";
import type { RestoreJob, RestoreJobRequest, RestoreJobStore } from "./restore-jobs.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const approverOne = "33333333-3333-4333-8333-333333333333";
const approverTwo = "44444444-4444-4444-8444-444444444444";
const orgId = "22222222-2222-4222-8222-222222222222";
const restorePayload = {
  backupId: "backup-20260520T120000Z",
  encrypted: true,
  targetDatabase: "helix_restore_incident_42",
  targetObjectBucket: "helix-restore-incident-42",
  idempotencyKey: "incident-42",
};

describe("backup admin routes", () => {
  it("still lets config writers create backups but never restore", async () => {
    const harness = await createHarness();
    const backup = await harness.app.inject({
      method: "POST",
      url: "/api/admin/backups",
      headers: adminHeaders("admin.config.write"),
      payload: { backupId: restorePayload.backupId },
    });
    const restore = await harness.app.inject({
      method: "POST",
      url: "/api/admin/restores",
      headers: adminHeaders("admin.config.write", actorId, true),
      payload: restorePayload,
    });

    expect(backup.statusCode).toBe(200);
    expect(restore.statusCode).toBe(403);
    expect(restore.json()).toMatchObject({ requiredScope: "admin.backups.restore" });
    expect(harness.jobs.jobs).toHaveLength(0);
  });

  it("requires recent step-up before persisting a restore request", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/admin/restores",
      headers: adminHeaders("admin.backups.restore"),
      payload: restorePayload,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "step_up_required" });
    expect(harness.jobs.jobs).toHaveLength(0);
  });

  it("requires one other stepped-up admin when second-admin approval is enabled", async () => {
    const harness = await createHarness();
    const created = await harness.app.inject({
      method: "POST",
      url: "/api/admin/restores",
      headers: adminHeaders("admin.backups.restore", actorId, true),
      payload: restorePayload,
    });
    const job = created.json() as RestoreJob;
    const selfApproval = await harness.app.inject({
      method: "POST",
      url: `/api/admin/restores/${job.id}/approvals`,
      headers: adminHeaders("admin.backups.restore", actorId, true),
    });
    const first = await harness.app.inject({
      method: "POST",
      url: `/api/admin/restores/${job.id}/approvals`,
      headers: adminHeaders("admin.backups.restore", approverOne, true),
    });
    const second = await harness.app.inject({
      method: "POST",
      url: `/api/admin/restores/${job.id}/approvals`,
      headers: adminHeaders("admin.backups.restore", approverTwo, true),
    });

    expect(created.statusCode).toBe(202);
    expect(job).toMatchObject({
      status: "pending_approval",
      approvalCount: 0,
      backupId: restorePayload.backupId,
      encrypted: true,
      targetDatabase: restorePayload.targetDatabase,
      targetObjectBucket: restorePayload.targetObjectBucket,
    });
    expect(selfApproval.statusCode).toBe(409);
    expect(first.json()).toMatchObject({
      status: "queued",
      approvalCount: 1,
      requiredApprovals: 1,
    });
    expect(second.statusCode).toBe(409);
    expect(harness.audit.map((record) => record.verb)).toEqual([
      "backup.restore.requested",
      "backup.restore.approved",
    ]);
  });

  it.each([false, true])(
    "honors independent MFA and approval choices (approval %s)",
    async (required) => {
      const harness = await createHarness(async () => ({
        sensitiveActionMfaRequired: false,
        secondAdminApprovalRequired: required,
      }));
      const create = (scopes: string, extra = {}) =>
        harness.app.inject({
          method: "POST",
          url: "/api/admin/restores",
          headers: adminHeaders(scopes),
          payload: { ...restorePayload, ...extra },
        });
      expect((await create("mail.read")).statusCode).toBe(403);
      expect((await create("admin.backups.restore", { requiredApprovals: 0 })).statusCode).toBe(
        400,
      );
      const response = await create("admin.backups.restore");
      expect(response.statusCode).toBe(202);
      expect(response.json()).toMatchObject({
        status: required ? "pending_approval" : "queued",
        approvalCount: 0,
        requiredApprovals: required ? 1 : 0,
      });
      expect(harness.audit[0]?.metadata).toMatchObject({ requiredApprovals: required ? 1 : 0 });
    },
  );

  it("keeps MFA when approvals alone are disabled", async () => {
    const harness = await createHarness(async () => ({
      sensitiveActionMfaRequired: true,
      secondAdminApprovalRequired: false,
    }));
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/admin/restores",
      headers: adminHeaders("admin.backups.restore"),
      payload: restorePayload,
    });
    expect(response.statusCode).toBe(403);
    expect(harness.jobs.jobs).toHaveLength(0);
  });

  it("requires explicit safe isolated restore targets", async () => {
    const harness = await createHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/api/admin/restores",
      headers: adminHeaders("admin.backups.restore", actorId, true),
      payload: { ...restorePayload, targetDatabase: "helix" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("builds an isolated restore command that can never drop a target", async () => {
    const service = new ScriptedBackupAdminService({
      restoreScript: "missing-restore.sh",
      backupDir: "/var/backups/helix",
      execute: false,
    });
    const result = await service.restoreBackup(restorePayload);

    expect(result.command).toEqual([
      "bash",
      "missing-restore.sh",
      "--backup",
      "/var/backups/helix/backup-20260520T120000Z.tar.gz.age",
      "--target-db",
      "helix_restore_incident_42",
      "--restore-objects",
      "--object-target-bucket",
      "helix-restore-incident-42",
      "--no-object-switch",
      "--verify",
      "--dry-run",
    ]);
    expect(result.command).not.toContain("--allow-drop-target");
  });
});

async function createHarness(
  securityControls?: RegisterBackupAdminRoutesOptions["securityControls"],
): Promise<{
  app: ReturnType<typeof fastify>;
  jobs: FakeRestoreJobStore;
  audit: (AuditRecord & { readonly orgId: string })[];
}> {
  const app = fastify();
  const jobs = new FakeRestoreJobStore();
  const audit: (AuditRecord & { readonly orgId: string })[] = [];
  await registerBackupAdminRoutes(app, {
    service: new FakeBackupAdminService(),
    restoreJobs: jobs,
    actorFromRequest,
    stepUpVerified: (request) => request.headers["x-test-mfa"] === "true",
    ...(securityControls === undefined ? {} : { securityControls }),
    auditSink: { append: async (record) => void audit.push(record) },
  });
  return { app, jobs, audit };
}

class FakeBackupAdminService implements BackupAdminService {
  async createBackup(): Promise<BackupOperationResult> {
    return operationResult("backup-1", ["backup"]);
  }
  async restoreBackup(): Promise<BackupOperationResult> {
    return operationResult("restore-1", ["restore"]);
  }
}

class FakeRestoreJobStore implements RestoreJobStore {
  readonly jobs: RestoreJob[] = [];
  private readonly approvals = new Map<string, Set<string>>();

  async createJob(id: string, actor: Actor, input: RestoreJobRequest): Promise<RestoreJob> {
    const job = makeJob(id, actor, input);
    this.jobs.push(job);
    return job;
  }
  async getJob(id: string, targetOrgId: string): Promise<RestoreJob | undefined> {
    return this.jobs.find((job) => job.id === id && job.orgId === targetOrgId);
  }
  async approveJob(id: string, actor: Actor): Promise<RestoreJob | undefined> {
    const index = this.jobs.findIndex((job) => job.id === id && job.orgId === actor.orgId);
    if (index < 0) return undefined;
    const approvals = this.approvals.get(id) ?? new Set<string>();
    approvals.add(actor.id);
    this.approvals.set(id, approvals);
    const current = this.jobs[index];
    if (current === undefined) return undefined;
    const updated: RestoreJob = {
      ...current,
      approvalCount: approvals.size,
      status: approvals.size >= current.requiredApprovals ? "queued" : "pending_approval",
    };
    this.jobs[index] = updated;
    return updated;
  }
  async cancelJob(): Promise<RestoreJob | undefined> {
    return undefined;
  }
  async claimJobs(): Promise<readonly RestoreJob[]> {
    return [];
  }
  async cancellationRequested(): Promise<boolean> {
    return false;
  }
  async completeJob(): Promise<void> {}
  async failJob(): Promise<void> {}
  async markCancelled(): Promise<void> {}
}

function makeJob(id: string, actor: Actor, input: RestoreJobRequest): RestoreJob {
  return {
    id,
    orgId: actor.orgId,
    requestedByActorId: actor.id,
    backupId: input.backupId,
    encrypted: input.encrypted,
    targetDatabase: input.targetDatabase,
    targetObjectBucket: input.targetObjectBucket,
    status: input.requiredApprovals === 0 ? "queued" : "pending_approval",
    approvalCount: 0,
    requiredApprovals: input.requiredApprovals ?? 2,
    attemptCount: 0,
    cancellationRequested: false,
  };
}

function operationResult(operationId: string, command: readonly string[]): BackupOperationResult {
  return { status: "completed", operationId, command, stdout: "", stderr: "" };
}

function adminHeaders(scopes: string, id = actorId, mfa = false): Record<string, string> {
  return {
    "x-helix-actor-id": id,
    "x-helix-org-id": orgId,
    "x-helix-scopes": scopes,
    ...(mfa ? { "x-test-mfa": "true" } : {}),
  };
}
