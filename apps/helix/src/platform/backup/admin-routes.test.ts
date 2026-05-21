import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/actor.js";
import {
  registerBackupAdminRoutes,
  ScriptedBackupAdminService,
  type BackupAdminService,
  type BackupOperationResult,
} from "./admin-routes.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";

describe("backup admin routes", () => {
  it("creates backups for admin config writers", async () => {
    const service = new FakeBackupAdminService();
    const app = fastify();
    await registerBackupAdminRoutes(app, { service, actorFromRequest });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/backups",
      headers: adminHeaders(),
      payload: { backupId: "backup-20260520T120000Z", encrypted: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "completed",
      operationId: "backup-1",
      command: ["backup"],
    });
    expect(service.backupCalls).toEqual([{ backupId: "backup-20260520T120000Z" }]);
  });

  it("restores selected backups for admin config writers", async () => {
    const service = new FakeBackupAdminService();
    const app = fastify();
    await registerBackupAdminRoutes(app, { service, actorFromRequest });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/restores",
      headers: adminHeaders("admin.*"),
      payload: { backupId: "backup-20260520T120000Z", encrypted: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "completed",
      operationId: "restore-1",
      command: ["restore"],
    });
    expect(service.restoreCalls).toEqual([
      { backupId: "backup-20260520T120000Z", encrypted: true },
    ]);
  });

  it("requires admin config write scope", async () => {
    const service = new FakeBackupAdminService();
    const app = fastify();
    await registerBackupAdminRoutes(app, { service, actorFromRequest });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/backups",
      headers: adminHeaders("admin.audit"),
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Admin backup operation permission denied.",
      requiredScope: "admin.config.write",
    });
    expect(service.backupCalls).toEqual([]);
  });

  it("rejects unsafe restore backup ids before service execution", async () => {
    const service = new FakeBackupAdminService();
    const app = fastify();
    await registerBackupAdminRoutes(app, { service, actorFromRequest });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/restores",
      headers: adminHeaders(),
      payload: { backupId: "../helix" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Invalid restore request." });
    expect(service.restoreCalls).toEqual([]);
  });

  it("returns script dry-run metadata without requiring local script execution", async () => {
    const service = new ScriptedBackupAdminService({
      backupScript: "missing-backup.sh",
      restoreScript: "missing-restore.sh",
      backupDir: "/var/backups/helix",
      execute: false,
    });

    await expect(
      service.createBackup({ backupId: "backup-20260520T120000Z" }),
    ).resolves.toMatchObject({
      status: "dry_run",
      operationId: "backup-dry-run",
      command: [
        "bash",
        "missing-backup.sh",
        "--backup-id",
        "backup-20260520T120000Z",
        "--dry-run",
        "--output-dir",
        "/var/backups/helix",
      ],
    });

    await expect(
      service.restoreBackup({ backupId: "backup-20260520T120000Z" }),
    ).resolves.toMatchObject({
      status: "dry_run",
      operationId: "restore-dry-run",
      command: [
        "bash",
        "missing-restore.sh",
        "--backup",
        "/var/backups/helix/backup-20260520T120000Z.tar.gz",
        "--allow-drop-target",
        "--verify",
        "--dry-run",
      ],
    });

    await expect(
      service.restoreBackup({ backupId: "backup-20260520T120000Z", encrypted: true }),
    ).resolves.toMatchObject({
      status: "dry_run",
      operationId: "restore-dry-run",
      command: [
        "bash",
        "missing-restore.sh",
        "--backup",
        "/var/backups/helix/backup-20260520T120000Z.tar.gz.age",
        "--allow-drop-target",
        "--verify",
        "--dry-run",
      ],
    });
  });
});

class FakeBackupAdminService implements BackupAdminService {
  readonly backupCalls: { readonly backupId?: string | undefined }[] = [];
  readonly restoreCalls: { readonly backupId: string; readonly encrypted?: boolean }[] = [];

  async createBackup(input: {
    readonly backupId?: string | undefined;
  }): Promise<BackupOperationResult> {
    this.backupCalls.push(input);
    return operationResult("backup-1", ["backup"]);
  }

  async restoreBackup(input: {
    readonly backupId: string;
    readonly encrypted?: boolean;
  }): Promise<BackupOperationResult> {
    this.restoreCalls.push(input);
    return operationResult("restore-1", ["restore"]);
  }
}

function operationResult(operationId: string, command: readonly string[]): BackupOperationResult {
  return {
    status: "completed",
    operationId,
    command,
    stdout: "",
    stderr: "",
  };
}

function adminHeaders(scopes = "admin.config.write"): Record<string, string> {
  return {
    "x-helix-actor-id": actorId,
    "x-helix-org-id": orgId,
    "x-helix-scopes": scopes,
  };
}
