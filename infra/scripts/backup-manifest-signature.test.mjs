import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const manifestScript = fileURLToPath(new URL("./backup-manifest.mjs", import.meta.url));
describe("Ed25519 backup manifests", () => {
  it("verifies signatures, contents, missing files, and application versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "helix-manifest-test-"));
    try {
      const backup = join(root, "backup");
      await mkdir(join(backup, "objects"), { recursive: true });
      await writeFile(join(backup, "postgres.dump"), "database");
      await writeFile(join(backup, "objects", "one.bin"), "object");
      await writeFile(
        join(backup, "manifest.json"),
        `${JSON.stringify({ schema_version: 3, app_version: "build-1", postgres: { end_lsn: "0/123", migrations: [] } })}\n`,
      );
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const privatePath = join(root, "private.pem");
      const publicPath = join(root, "public.pem");
      await writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }));
      await writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }));
      run("sign", backup, join(backup, "manifest.json"), privatePath);
      run("verify", backup, join(backup, "manifest.json"), publicPath, "build-1");
      // The same signed inventory also carries production recovery-set evidence.
      await mkdir(join(backup, "consistency"));
      await writeFile(join(backup, "consistency", "database.tsv"), "objects.count\t1\n");
      await writeFile(
        join(backup, "objects", "inventory.json"),
        JSON.stringify({
          objects: [
            {
              file: "one.bin",
              key: "drive/test/one.bin",
              sha256: createHash("sha256").update("object").digest("hex"),
            },
          ],
        }),
      );
      const upgraded = JSON.parse(await readFile(join(backup, "manifest.json"), "utf8"));
      Object.assign(upgraded, {
        backup_id: "backup-1",
        created_at: "2026-09-09T12:00:00Z",
        tier: "business",
        postgres: { ...upgraded.postgres, snapshot_boundary: "2026-09-09T12:00:00Z" },
        objects: {
          included: true,
          bucket: "helix",
          versionInventoryArtifact: "objects/inventory.json",
        },
        encryption: {
          method: "age",
          keyCustodyRef: "vault://backup/recovery",
          plaintextKeyMaterialIncluded: false,
        },
        resilience: { offHostUri: "s3://backup/helix", retentionDays: 30 },
      });
      await writeFile(join(backup, "manifest.json"), JSON.stringify(upgraded));
      run("sign", backup, join(backup, "manifest.json"), privatePath);
      run("verify", backup, join(backup, "manifest.json"), publicPath, "build-1");
      const signed = JSON.parse(await readFile(join(backup, "manifest.json"), "utf8"));
      expect(signed.schema).toBe("helix.backup-manifest.v3");
      expect(signed.recoverySet.id).toMatch(/^[a-f0-9]{64}$/u);
      expect(signed.recoverySet.maximumCaptureSkewSeconds).toBe(0);
      expect(signed.objects.sampledCorpus[0]).toMatchObject({
        path: "objects/one.bin",
        key: "drive/test/one.bin",
        bytes: 6,
      });
      await writeFile(join(backup, "objects", "one.bin"), "tampered");
      mustFail("verify", backup, join(backup, "manifest.json"), publicPath, "build-1");
      await writeFile(join(backup, "objects", "one.bin"), "object");
      await rm(join(backup, "objects", "one.bin"));
      mustFail("verify", backup, join(backup, "manifest.json"), publicPath, "build-1");
      await writeFile(join(backup, "objects", "one.bin"), "object");
      await symlink(join(root, "private.pem"), join(backup, "linked-key.pem"));
      mustFail("verify", backup, join(backup, "manifest.json"), publicPath, "build-1");
      mustFail("sign", backup, join(backup, "manifest.json"), privatePath);
      await rm(join(backup, "linked-key.pem"));
      mustFail("verify", backup, join(backup, "manifest.json"), publicPath, "wrong-build");
      const manifest = JSON.parse(await readFile(join(backup, "manifest.json"), "utf8"));
      manifest.app_version = "forged";
      await writeFile(join(backup, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      mustFail("verify", backup, join(backup, "manifest.json"), publicPath, "forged");
      process.stdout.write("backup manifest tests passed\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
function run(...args) {
  const result = spawnSync(process.execPath, [manifestScript, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "manifest command failed");
  }
}
function mustFail(...args) {
  const result = spawnSync(process.execPath, [manifestScript, ...args], {
    encoding: "utf8",
  });
  if (result.status === 0) {
    throw new Error("manifest verification unexpectedly succeeded");
  }
}
