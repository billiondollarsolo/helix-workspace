import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockByoStorageSmokeServer } from "./byo-storage-credential-rotation-smoke.mjs";

const workspaceRoot = resolve(new URL("../..", import.meta.url).pathname);
const smokeScript = join(workspaceRoot, "infra/scripts/byo-storage-credential-rotation-smoke.mjs");

describe("byo-storage-credential-rotation-smoke", () => {
  it("supports static validation", () => {
    const result = spawnSync(process.execPath, [smokeScript, "--static"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("static validation complete");
  });

  it("rotates credentials twice against a live-compatible admin API without printing secrets", async () => {
    const { server, requests } = createMockByoStorageSmokeServer();
    const tempDir = await mkdtemp(join(tmpdir(), "helix-byo-rotation-smoke-"));
    const outputPath = join(tempDir, "evidence.json");
    try {
      const baseUrl = await listen(server);
      const result = await runSmoke({
        cwd: workspaceRoot,
        env: {
          ...process.env,
          HELIX_BASE_URL: baseUrl,
          AUTH_TOKEN: "test-token",
          HELIX_BYO_STORAGE_SMOKE_ACCESS_KEY_ID: "first-access",
          HELIX_BYO_STORAGE_SMOKE_SECRET_ACCESS_KEY: "first-secret",
          HELIX_BYO_STORAGE_SMOKE_ROTATED_ACCESS_KEY_ID: "rotated-access",
          HELIX_BYO_STORAGE_SMOKE_ROTATED_SECRET_ACCESS_KEY: "rotated-secret",
          HELIX_BYO_STORAGE_SMOKE_OUTPUT: outputPath,
        },
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain('"status": "passed"');
      expect(result.stdout).not.toContain("first-secret");
      expect(result.stdout).not.toContain("rotated-secret");
      const evidence = JSON.parse(await readFile(outputPath, "utf8"));
      expect(evidence.rotations).toHaveLength(2);
      expect(evidence.finalHealth.status).toBe("healthy");
      expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
        "GET /api/admin/tenant-config",
        "POST /api/admin/tenant-config/byo-storage/credentials",
        "POST /api/admin/tenant-config/byo-storage/credentials",
        "POST /api/admin/tenant-config/byo-storage/test",
      ]);
      expect(JSON.stringify(requests)).toContain("first-secret");
      expect(JSON.stringify(requests)).toContain("rotated-secret");
    } finally {
      await close(server);
      await rm(tempDir, { recursive: true, force: true });
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

async function runSmoke(options) {
  const child = spawn(process.execPath, [smokeScript], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((resolveStatus, rejectStatus) => {
    child.once("error", rejectStatus);
    child.once("exit", (code, signal) => {
      resolveStatus({ code, signal });
    });
  });
  return {
    status: status.code,
    signal: status.signal,
    stdout,
    stderr,
  };
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
