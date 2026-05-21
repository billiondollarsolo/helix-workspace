import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

const execFileAsync = promisify(execFile);
const adminConfigWriteScope = "admin.config.write";
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
});

export interface BackupOperationResult {
  readonly status: "completed" | "dry_run";
  readonly operationId: string;
  readonly command: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
}

export interface BackupAdminService {
  createBackup(input: { readonly backupId?: string | undefined }): Promise<BackupOperationResult>;
  restoreBackup(input: {
    readonly backupId: string;
    readonly encrypted?: boolean | undefined;
  }): Promise<BackupOperationResult>;
}

export interface RegisterBackupAdminRoutesOptions {
  readonly service: BackupAdminService;
  readonly actorFromRequest: (request: FastifyRequest) => Promise<Actor> | Actor;
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
    if (!canOperateBackups(actor)) {
      return reply.code(403).send(permissionDeniedResponse());
    }

    const parsed = restoreSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: "Invalid restore request.", issues: parsed.error.issues });
    }

    return options.service.restoreBackup(parsed.data);
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

  async createBackup(input: { readonly backupId?: string | undefined }): Promise<BackupOperationResult> {
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
      "--allow-drop-target",
      "--verify",
      execute ? "--execute" : "--dry-run",
    ];
    if (!execute) {
      return dryRunResult("restore", args);
    }
    return runScript("restore", args, this.options.timeoutMs);
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
): Promise<BackupOperationResult> {
  const [script, ...scriptArgs] = args;
  const result = await execFileAsync("bash", [script ?? "", ...scriptArgs], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 8,
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
  return `backup-${new Date().toISOString().replaceAll(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z")}`;
}

function shouldExecute(value: boolean | undefined): boolean {
  if (value !== undefined) {
    return value;
  }
  const raw = process.env.HELIX_ADMIN_BACKUP_EXECUTE;
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
