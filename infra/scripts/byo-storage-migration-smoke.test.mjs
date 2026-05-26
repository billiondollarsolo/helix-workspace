import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMockByoStorageMigrationSmokeServer,
  runSmokeChild,
} from "./byo-storage-migration-smoke.mjs";

const workspaceRoot = resolve(new URL("../..", import.meta.url).pathname);
const smokeScript = join(workspaceRoot, "infra/scripts/byo-storage-migration-smoke.mjs");

describe("byo-storage-migration-smoke", () => {
  it("supports static validation", () => {
    const result = spawnSync(process.execPath, [smokeScript, "--static"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("static validation complete");
  });

  it("runs dry-run by default and redacts storage secrets in evidence", async () => {
    const { server, requests } = createMockByoStorageMigrationSmokeServer();
    const tempDir = await mkdtemp(join(tmpdir(), "helix-byo-migration-smoke-"));
    const outputPath = join(tempDir, "evidence.json");
    const targetStorage = JSON.stringify({
      kind: "byo",
      provider: "aws-s3",
      bucket: "helix-smoke",
      credentials_vault_path: "tenants/acme/byo-storage/aws",
      accessKeyId: "should-redact",
      secretAccessKey: "should-redact-secret",
    });
    try {
      const baseUrl = await listen(server);
      const result = await runSmokeChild(smokeScript, {
        cwd: workspaceRoot,
        args: [],
        env: {
          ...process.env,
          HELIX_BASE_URL: baseUrl,
          AUTH_TOKEN: "test-token",
          HELIX_BYO_STORAGE_MIGRATION_SMOKE_TARGET_STORAGE_JSON: targetStorage,
          HELIX_BYO_STORAGE_MIGRATION_SMOKE_OUTPUT: outputPath,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain('"status": "passed"');
      expect(result.stdout).not.toContain("should-redact");
      const evidence = JSON.parse(await readFile(outputPath, "utf8"));
      expect(evidence.dryRun.status).toBe("dry_run");
      expect(evidence.live).toBeNull();
      expect(evidence.targetStorage.accessKeyId).toBe("[redacted]");
      expect(evidence.targetStorage.secretAccessKey).toBe("[redacted]");
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "POST /api/admin/tenant-config/byo-storage/migrations",
        "GET /api/admin/tenant-config/byo-storage/migrations/00000000-0000-4000-8000-000000000001",
      ]);
      expect(requests[0]?.body).toMatchObject({
        target: "byo",
        dryRun: true,
      });
    } finally {
      await close(server);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("requires explicit confirmation for live migration and cutover", async () => {
    const { server, requests } = createMockByoStorageMigrationSmokeServer();
    try {
      const baseUrl = await listen(server);
      const targetStorage = JSON.stringify({
        kind: "byo",
        provider: "aws-s3",
        bucket: "helix-smoke",
        credentials_vault_path: "tenants/acme/byo-storage/aws",
      });
      const result = await runSmokeChild(smokeScript, {
        cwd: workspaceRoot,
        args: [
          "--live",
          "--confirm",
          "LIVE",
          "--cutover",
          "--confirm-cutover",
          "CUTOVER",
          "--target-storage",
          targetStorage,
        ],
        env: {
          ...process.env,
          HELIX_BASE_URL: baseUrl,
          AUTH_TOKEN: "test-token",
          HELIX_BYO_STORAGE_MIGRATION_SMOKE_POLL_MS: "1",
        },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('"live"');
      expect(result.stdout).toContain('"cutover"');
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "POST /api/admin/tenant-config/byo-storage/migrations",
        "GET /api/admin/tenant-config/byo-storage/migrations/00000000-0000-4000-8000-000000000001",
        "POST /api/admin/tenant-config/byo-storage/migrations",
        "GET /api/admin/tenant-config/byo-storage/migrations/00000000-0000-4000-8000-000000000002",
        "POST /api/admin/tenant-config/byo-storage/migrations/00000000-0000-4000-8000-000000000002/cutover",
      ]);
      expect(requests[2]?.body).toMatchObject({
        dryRun: false,
        target: "byo",
      });
      expect(requests[4]?.body).toEqual({ confirm: "CUTOVER" });
    } finally {
      await close(server);
    }
  });
});

async function listen(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
}
