import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RESTORE_DRILL_EVIDENCE_SCHEMA,
  RESTORE_DRILL_SCENARIOS,
  assertContainsNoSecrets,
  createLiveEvidence,
  createStaticEvidence,
  validateRestoreDrillEvidence,
} from "./restore-drill-evidence.mjs";

describe("restore drill evidence contract", () => {
  it("keeps every live scenario explicitly not-run in static mode", () => {
    const evidence = createStaticEvidence(new Date("2026-07-28T20:00:00.000Z"));
    expect(validateRestoreDrillEvidence(evidence)).toBe(evidence);
    expect(evidence.schema).toBe(RESTORE_DRILL_EVIDENCE_SCHEMA);
    expect(Object.keys(evidence.scenarios)).toEqual(RESTORE_DRILL_SCENARIOS);
    expect(Object.values(evidence.scenarios).every(({ status }) => status === "not_run")).toBe(
      true,
    );
  });

  it("accepts a fully observed encrypted disposable drill within RD-6", async () => {
    const manifest = await writeManifest();
    const evidence = await createLiveEvidence({
      ...passedOptions(manifest),
      startedAt: "2026-07-29T19:00:00.000Z",
      completedAt: "2026-07-29T20:30:00.000Z",
    });

    expect(validateRestoreDrillEvidence(evidence)).toBe(evidence);
    expect(evidence.status).toBe("passed");
    expect(evidence.metrics).toMatchObject({ rpoHours: 23, rtoHours: 1.5 });
  });

  it("does not claim success for plaintext, shared-target, stale, slow, or incomplete drills", async () => {
    const manifest = await writeManifest({
      encryption: { method: "none", plaintextKeyMaterialIncluded: false },
    });
    const evidence = await createLiveEvidence({
      ...passedOptions(manifest),
      startedAt: "2026-07-30T22:00:00.000Z",
      completedAt: "2026-07-31T03:00:00.000Z",
      targetDb: "helix",
      targetObjectBucket: "source-objects",
      sampleMatches: "1",
      searchReindex: "not_run",
    });

    expect(evidence.status).toBe("failed");
    expect(evidence.scenarios.encrypted_restore.status).toBe("failed");
    expect(evidence.scenarios.disposable_environment.status).toBe("failed");
    expect(evidence.scenarios.sampled_corpus_hashes.status).toBe("failed");
    expect(evidence.scenarios.search_reindex.status).toBe("not_run");
    expect(evidence.scenarios.rpo.status).toBe("failed");
    expect(evidence.scenarios.rto.status).toBe("failed");
  });

  it("rejects secret-bearing or falsely promoted reports", () => {
    expect(() => assertContainsNoSecrets({ accessToken: "do-not-store" })).toThrow(
      "sensitive restore evidence field is forbidden",
    );
    const evidence = createStaticEvidence();
    evidence.mode = "live";
    evidence.status = "passed";
    expect(() => validateRestoreDrillEvidence(evidence)).toThrow(
      "passed restore evidence requires every scenario",
    );
  });

  it("rejects passed labels without supporting observations", async () => {
    const evidence = await createLiveEvidence(passedOptions(await writeManifest()));
    evidence.scenarios.database_consistency.expectedSnapshotSha256 = "";

    expect(() => validateRestoreDrillEvidence(evidence)).toThrow(
      "requires database/object/queue/audit observations",
    );
  });
});

async function writeManifest(overrides = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), "helix-restore-evidence-"));
  const path = resolve(directory, "manifest.json");
  const manifest = {
    schema: "helix.backup-manifest.v3",
    backupId: "backup-1",
    tier: "business",
    recoverySet: {
      id: "a".repeat(64),
      databaseCapturedAt: "2026-07-28T20:00:00.000Z",
    },
    database: { consistencyArtifact: "consistency/database.tsv" },
    objects: {
      included: true,
      bucket: "source-objects",
      versionInventoryArtifact: "objects/source-objects.versions.json",
    },
    encryption: {
      method: "age",
      keyCustodyRef: "vault://backup/age-recipient",
      plaintextKeyMaterialIncluded: false,
    },
    resilience: { offHostUri: "s3://off-host/helix", retentionDays: 35 },
    artifacts: [
      {
        path: "consistency/database.tsv",
        bytes: 10,
        sha256: "b".repeat(64),
      },
      {
        path: "objects/source-objects.versions.json",
        bytes: 10,
        sha256: "c".repeat(64),
      },
    ],
    ...overrides,
  };
  await writeFile(path, `${JSON.stringify(manifest)}\n`, "utf8");
  return path;
}

function passedOptions(manifest) {
  return {
    manifest,
    startedAt: "2026-07-29T19:00:00.000Z",
    completedAt: "2026-07-29T20:00:00.000Z",
    sourceDb: "helix",
    targetDb: "helix_restore_drill",
    targetObjectBucket: "helix-objects-restore-drill",
    manifestIntegrity: "passed",
    databaseConsistency: "passed",
    objectVersionConsistency: "passed",
    outboundQueueConsistency: "passed",
    auditChain: "passed",
    sampleCount: "2",
    sampleMatches: "2",
    searchReindex: "passed",
  };
}
