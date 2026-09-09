import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../../config/env.js";
import {
  RestoreJobIdempotencyConflict,
  type RestoreAuditSink,
  type RestoreJobStore,
} from "./restore-jobs.js";

const execFileAsync = promisify(execFile);
const adminConfigWriteScope = "admin.config.write";
export const backupRestoreScope = "admin.backups.restore";
const backupIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

const backupCreateSchema = z.object({
  backupId: backupIdSchema.optional(),
});

const restoreSchema = z.object({
  backupId: backupIdSchema,
  encrypted: z.boolean().default(false),
  targetDatabase: z.string().regex(/^helix_restore_[a-z0-9_]{1,49}$/u),
  targetObjectBucket: z.string().regex(/^helix-restore-[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u),
  idempotencyKey: z.string().trim().min(1).max(128),
});
const restoreJobParamsSchema = z.object({ id: z.string().uuid() });

export interface BackupOperationResult {
  readonly status: "completed" | "dry_run";
  readonly operationId: string;
  readonly command: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
}

export interface RestoreExecutor {
  restoreBackup(input: {
    readonly backupId: string;
    readonly encrypted?: boolean | undefined;
    readonly targetDatabase: string;
    readonly targetObjectBucket: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<BackupOperationResult>;
}

export interface BackupAdminService extends RestoreExecutor {
  createBackup(input: { readonly backupId?: string | undefined }): Promise<BackupOperationResult>;
}

export interface RegisterBackupAdminRoutesOptions {
  readonly service: BackupAdminService;
  readonly restoreJobs: RestoreJobStore;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
  readonly stepUpVerified: (request: FastifyRequest) => Promise<boolean> | boolean;
  readonly auditSink: RestoreAuditSink;
}

export async function registerBackupAdminRoutes(
  app: FastifyInstance,
  options: RegisterBackupAdminRoutesOptions,
): Promise<void> {
  app.post("/api/admin/backups", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canOperateBackups(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = backupCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid backup request.", issues: parsed.error.issues });
    }

    return options.service.createBackup(parsed.data);
  });

  app.post("/api/admin/restores", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canRestoreBackups(actor)) {
      return reply.code(403).send(restorePermissionDeniedResponse());
    }
    if (!(await options.stepUpVerified(request))) {
      return reply.code(403).send(stepUpRequiredResponse());
    }

    const parsed = restoreSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid restore request.", issues: parsed.error.issues });
    }

    const id = randomUUID();
    try {
      const job = await options.restoreJobs.createJob(id, actor, parsed.data);
      await appendRestoreAudit(
        options.auditSink,
        actor,
        job.id,
        "backup.restore.requested",
        parsed.data,
      );
      return await reply.code(202).send(job);
    } catch (error) {
      if (error instanceof RestoreJobIdempotencyConflict) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/api/admin/restores/:id", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canRestoreBackups(actor)) return reply.code(403).send(restorePermissionDeniedResponse());
    const parsed = restoreJobParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid restore job id." });
    const job = await options.restoreJobs.getJob(parsed.data.id, actor.orgId);
    return job === undefined ? reply.code(404).send({ error: "Restore job not found." }) : job;
  });

  app.post("/api/admin/restores/:id/approvals", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canRestoreBackups(actor)) return reply.code(403).send(restorePermissionDeniedResponse());
    if (!(await options.stepUpVerified(request)))
      return reply.code(403).send(stepUpRequiredResponse());
    const parsed = restoreJobParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid restore job id." });
    const current = await options.restoreJobs.getJob(parsed.data.id, actor.orgId);
    if (current === undefined) return reply.code(404).send({ error: "Restore job not found." });
    if (current.requestedByActorId === actor.id) {
      return reply.code(409).send({ error: "Restore requester cannot approve their own job." });
    }
    if (current.status !== "pending_approval") {
      return reply.code(409).send({ error: "Restore job is not awaiting approval." });
    }
    await appendRestoreAudit(options.auditSink, actor, current.id, "backup.restore.approved", {
      backupId: current.backupId,
      targetDatabase: current.targetDatabase,
      targetObjectBucket: current.targetObjectBucket,
    });
    const job = await options.restoreJobs.approveJob(current.id, actor);
    return job ?? reply.code(409).send({ error: "Restore job could not be approved." });
  });

  app.post("/api/admin/restores/:id/cancel", async (request, reply) => {
    const actor = await options.actorFromRequest(request);
    if (!canRestoreBackups(actor)) return reply.code(403).send(restorePermissionDeniedResponse());
    if (!(await options.stepUpVerified(request)))
      return reply.code(403).send(stepUpRequiredResponse());
    const parsed = restoreJobParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid restore job id." });
    const current = await options.restoreJobs.getJob(parsed.data.id, actor.orgId);
    if (current === undefined) return reply.code(404).send({ error: "Restore job not found." });
    await appendRestoreAudit(
      options.auditSink,
      actor,
      current.id,
      "backup.restore.cancel_requested",
      {
        backupId: current.backupId,
        targetDatabase: current.targetDatabase,
        targetObjectBucket: current.targetObjectBucket,
      },
    );
    const job = await options.restoreJobs.cancelJob(current.id, actor.orgId);
    return job ?? reply.code(409).send({ error: "Restore job cannot be cancelled." });
  });
}

export function canOperateBackups(actor: Actor): boolean {
  const scopes = actor.scopes ?? [];
  return (
    scopes.includes(adminConfigWriteScope) ||
    scopes.includes("admin.config.*") ||
    scopes.includes("admin.*")
  );
}

export function canRestoreBackups(actor: Actor): boolean {
  const scopes = actor.scopes ?? [];
  return scopes.includes(backupRestoreScope) || scopes.includes("admin.*");
}

export interface ScriptedBackupAdminServiceOptions {
  readonly backupScript?: string;
  readonly restoreScript?: string;
  readonly backupDir?: string;
  readonly tier?: string;
  readonly execute?: boolean;
  readonly timeoutMs?: number;
}

export class ScriptedBackupAdminService implements BackupAdminService {
  constructor(private readonly options: ScriptedBackupAdminServiceOptions = {}) {}

  async createBackup(input: {
    readonly backupId?: string | undefined;
  }): Promise<BackupOperationResult> {
    const backupId = input.backupId ?? utcBackupId();
    const execute = shouldExecute(this.options.execute);
    const args = [
      this.options.backupScript ?? "infra/scripts/backup.sh",
      "--backup-id",
      backupId,
      execute ? "--execute" : "--dry-run",
    ];
    if (this.options.backupDir !== undefined) {
      args.push("--output-dir", this.options.backupDir);
    }
    if (this.options.tier !== undefined) {
      args.push("--tier", this.options.tier);
    }
    if (!execute) {
      return dryRunResult("backup", args);
    }
    return runScript("backup", args, this.options.timeoutMs);
  }

  async restoreBackup(input: {
    readonly backupId: string;
    readonly encrypted?: boolean | undefined;
    readonly targetDatabase: string;
    readonly targetObjectBucket: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<BackupOperationResult> {
    const execute = shouldExecute(this.options.execute);
    const extension = input.encrypted === true ? ".tar.gz.age" : ".tar.gz";
    const backupPath =
      this.options.backupDir === undefined
        ? `${input.backupId}${extension}`
        : `${this.options.backupDir.replace(/\/+$/u, "")}/${input.backupId}${extension}`;
    const args = [
      this.options.restoreScript ?? "infra/scripts/restore.sh",
      "--backup",
      backupPath,
      "--target-db",
      input.targetDatabase,
      "--restore-objects",
      "--object-target-bucket",
      input.targetObjectBucket,
      "--no-object-switch",
      "--verify",
      execute ? "--execute" : "--dry-run",
    ];
    if (!execute) {
      return dryRunResult("restore", args);
    }
    return runScript("restore", args, this.options.timeoutMs, input.signal);
  }
}

function dryRunResult(
  operation: "backup" | "restore",
  args: readonly string[],
): BackupOperationResult {
  return {
    status: "dry_run",
    operationId: `${operation}-dry-run`,
    command: ["bash", ...args],
    stdout: `Dry run only. Set HELIX_ADMIN_BACKUP_EXECUTE=true to execute: ${shellCommand([
      "bash",
      ...args,
    ])}\n`,
    stderr: "",
  };
}

async function runScript(
  operation: "backup" | "restore",
  args: readonly string[],
  timeoutMs = 15 * 60 * 1000,
  signal?: AbortSignal,
): Promise<BackupOperationResult> {
  const [script, ...scriptArgs] = args;
  const result = await execFileAsync("bash", [script ?? "", ...scriptArgs], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 8,
    signal,
  });

  return {
    status: args.includes("--execute") ? "completed" : "dry_run",
    operationId: `${operation}-${Date.now().toString(36)}`,
    command: ["bash", ...args],
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function utcBackupId(): string {
  return `backup-${new Date()
    .toISOString()
    .replaceAll(/[-:]/gu, "")
    .replace(/\.\d{3}Z$/u, "Z")}`;
}

function shouldExecute(value: boolean | undefined): boolean {
  if (value !== undefined) {
    return value;
  }
  const raw = env().HELIX_ADMIN_BACKUP_EXECUTE;
  return raw === "1" || raw?.toLowerCase() === "true" || raw?.toLowerCase() === "yes";
}

function shellCommand(args: readonly string[]): string {
  return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function permissionDeniedResponse(): {
  readonly error: string;
  readonly requiredScope: typeof adminConfigWriteScope;
} {
  return {
    error: "Admin backup operation permission denied.",
    requiredScope: adminConfigWriteScope,
  };
}

function restorePermissionDeniedResponse(): {
  readonly error: string;
  readonly requiredScope: typeof backupRestoreScope;
} {
  return { error: "Admin restore permission denied.", requiredScope: backupRestoreScope };
}

function stepUpRequiredResponse(): { readonly error: string; readonly code: string } {
  return {
    error: "Recent MFA verification is required for restore operations.",
    code: "step_up_required",
  };
}

async function appendRestoreAudit(
  sink: RestoreAuditSink,
  actor: Actor,
  jobId: string,
  verb: string,
  input: {
    readonly backupId: string;
    readonly targetDatabase: string;
    readonly targetObjectBucket: string;
  },
): Promise<void> {
  await sink.append({
    orgId: actor.orgId,
    actorId: actor.id,
    verb,
    objectType: "backup_restore_job",
    objectId: jobId,
    metadata: {
      backupId: input.backupId,
      targetDatabase: input.targetDatabase,
      targetObjectBucket: input.targetObjectBucket,
    },
  });
}
