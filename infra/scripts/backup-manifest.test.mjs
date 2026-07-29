import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKUP_MANIFEST_SCHEMA,
  createBackupManifest,
  verifyBackupManifest,
} from "./backup-manifest.mjs";

describe("backup manifest contract", () => {
  it("binds database and object artifacts into one checksummed recovery set", async () => {
    const root = await fixture();
    const manifest = await createBackupManifest(root, validOptions());

    expect(manifest.schema).toBe(BACKUP_MANIFEST_SCHEMA);
    expect(manifest.recoverySet.id).toMatch(/^[a-f0-9]{64}$/u);
    expect(manifest.objects.sampledCorpus).toHaveLength(1);
    expect(manifest.artifacts.map(({ path }) => path)).toEqual([
      "consistency/database.tsv",
      "objects/helix-objects.versioning.json",
      "objects/helix-objects.versions.json",
      "objects/helix-objects/object-1.bin",
      "postgres.dump",
    ]);
    await expect(
      verifyBackupManifest(root, { integrityKey: validOptions().integrityKey }),
    ).resolves.toMatchObject({
      backupId: "backup-1",
      artifactCount: 5,
      encrypted: true,
      objectsIncluded: true,
    });
  });

  it("detects artifact tampering before restore", async () => {
    const root = await fixture();
    await createBackupManifest(root, validOptions());
    await writeFile(resolve(root, "postgres.dump"), "tampered\n", "utf8");

    await expect(
      verifyBackupManifest(root, { integrityKey: validOptions().integrityKey }),
    ).rejects.toThrow("artifact checksum mismatch");
  });

  it("rejects forged encryption and resilience claims even when artifacts are unchanged", async () => {
    const root = await fixture();
    await createBackupManifest(root, {
      ...validOptions(),
      tier: "personal",
      encryption: "none",
      keyCustodyRef: "",
      offHostUri: "",
      retentionDays: 0,
      objectVersioning: "Unavailable",
      objectReplication: "not-applicable",
    });
    const path = resolve(root, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.tier = "business";
    manifest.encryption.method = "age";
    manifest.encryption.keyCustodyRef = "vault://backup/forged";
    manifest.resilience.offHostUri = "s3://off-host/forged";
    manifest.resilience.retentionDays = 35;
    manifest.objects.versioning = "Enabled";
    manifest.objects.replication = "configured";
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(
      verifyBackupManifest(root, { integrityKey: validOptions().integrityKey }),
    ).rejects.toThrow("manifest integrity MAC mismatch");
  });

  it("fails closed when a production backup omits resilience or key-custody controls", async () => {
    const root = await fixture();
    await expect(
      createBackupManifest(root, {
        ...validOptions(),
        encryption: "none",
        keyCustodyRef: "",
        offHostUri: "",
        retentionDays: 0,
      }),
    ).rejects.toThrow("business backup must be encrypted");
  });

  it("writes no plaintext key material into the manifest", async () => {
    const root = await fixture();
    await createBackupManifest(root, validOptions());
    const serialized = await readFile(resolve(root, "manifest.json"), "utf8");

    expect(serialized).toContain('"plaintextKeyMaterialIncluded": false');
    expect(serialized).not.toContain("private-key");
  });

  it("rejects plaintext recovery keys masquerading as custody references", async () => {
    await expect(
      createBackupManifest(await fixture(), {
        ...validOptions(),
        keyCustodyRef: "AGE-SECRET-KEY-1EXAMPLE",
      }),
    ).rejects.toThrow("must be a non-secret URI or ARN");
  });
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "helix-backup-manifest-"));
  await Promise.all([
    mkdir(resolve(root, "consistency"), { recursive: true }),
    mkdir(resolve(root, "objects/helix-objects"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(resolve(root, "postgres.dump"), "postgres\n", "utf8"),
    writeFile(resolve(root, "consistency/database.tsv"), "objects\t1\n", "utf8"),
    writeFile(resolve(root, "objects/helix-objects/object-1.bin"), "object\n", "utf8"),
    writeFile(resolve(root, "objects/helix-objects.versions.json"), '{"Versions":[]}\n', "utf8"),
    writeFile(
      resolve(root, "objects/helix-objects.versioning.json"),
      '{"Status":"Enabled"}\n',
      "utf8",
    ),
  ]);
  return root;
}

function validOptions() {
  return {
    backupId: "backup-1",
    tier: "business",
    createdAt: "2026-07-28T20:00:00.000Z",
    databaseCapturedAt: "2026-07-28T20:00:02.000Z",
    objectsCapturedAt: "2026-07-28T20:00:03.000Z",
    databaseMode: "logical-dump",
    objectsIncluded: true,
    objectBucket: "helix-objects",
    objectVersioning: "Enabled",
    objectReplication: "configured",
    encryption: "age",
    keyCustodyRef: "vault://backup/age-recipient",
    offHostUri: "s3://off-host/helix",
    retentionDays: 35,
    integrityKey: "manifest-integrity-test-key-at-least-32-bytes",
    integrityKeyRef: "vault://backup/manifest-hmac",
  };
}
