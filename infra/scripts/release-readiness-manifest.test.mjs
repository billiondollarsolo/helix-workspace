import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { link, mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReleaseReadinessManifest,
  parseArgs,
  redactSensitive,
  writeManifestOutput,
} from "./release-readiness-manifest.mjs";
import { MAIL_LIVE_SCENARIOS, createEvidenceSkeleton } from "./mail-live-evidence-smoke.mjs";
import { AGENT_LIVE_SCENARIOS, createAgentEvidenceSkeleton } from "./agent-live-evidence-smoke.mjs";
import {
  RESTORE_DRILL_EVIDENCE_SCHEMA,
  createStaticEvidence as createStaticRestoreEvidence,
} from "./restore-drill-evidence.mjs";
import { CHAT_LIVE_SCENARIOS, createChatEvidenceSkeleton } from "./chat-live-evidence-contract.mjs";
import {
  DRIVE_EVIDENCE_CASES,
  DRIVE_EVIDENCE_SCHEMA_VERSION,
  notRunDriveEvidence,
} from "./drive-live-evidence-smoke.mjs";
import {
  DATA_PLANE_SCENARIOS,
  createDataPlaneEvidenceSkeleton,
} from "./data-plane-live-evidence-contract.mjs";
import {
  FAILURE_RECOVERY_OBSERVATION_SCHEMA,
  FAILURE_RECOVERY_SCENARIOS,
  createLiveFailureRecoveryEvidence,
  createStaticFailureRecoveryEvidence,
  finalizeFailureRecoveryEvidence,
} from "./failure-recovery-contract.mjs";
import { buildDastEvidence, createStaticDastEvidence } from "./dast-evidence.mjs";
import {
  attachReleaseEvidenceBinding,
  createReleaseEvidenceBinding,
} from "./release-evidence-binding.mjs";
import {
  APPROVED_MVP_CORE_APPS,
  APPROVED_MVP_WEB_SURFACES,
  ARTIFACT_SCHEMAS,
  DISABLED_MVP_SURFACES,
  FINAL_ARTIFACT_SCHEMAS,
  REQUIRED_PRODUCTION_IMAGES,
  REQUIRED_PRODUCTION_IMAGE_SUBJECTS,
  REQUIRED_WORKSPACE_GATES,
  canonicalJson,
  evidenceSetDigest,
  registerArtifactIdentity,
} from "./final-release-artifacts.mjs";

const FINAL_NOW = "2026-07-30T00:00:00.000Z";
const WORKSPACE_REPOSITORY = "billiondollarsolo/helix-workspace";
const EDITORS_REPOSITORY = "billiondollarsolo/helix-editors";
const SOURCE_REF = "refs/heads/main";
const WORKFLOW_IDENTITY =
  "https://github.com/billiondollarsolo/helix-workspace/.github/workflows/production-image-security.yml@refs/heads/main";

describe("release-readiness manifest", () => {
  it("redacts sensitive keys recursively and case-insensitively", () => {
    expect(
      redactSensitive({
        nested: {
          Password: "one",
          apiTOKENValue: "two",
          safe: [{ authorizationHeader: "three" }, { status: "ok" }],
        },
        Cookie: "four",
        publicKey: "five",
      }),
    ).toEqual({
      nested: {
        Password: "[REDACTED]",
        apiTOKENValue: "[REDACTED]",
        safe: [{ authorizationHeader: "[REDACTED]" }, { status: "ok" }],
      },
      Cookie: "[REDACTED]",
      publicKey: "[REDACTED]",
    });
  });

  it("creates a deterministic manifest for clean paired repositories", async () => {
    const fixture = await createFixture();
    const options = parseArgs(
      [
        "--workspace-dir",
        fixture.workspace,
        "--editors-dir",
        fixture.editors,
        "--evidence-dir",
        fixture.evidence,
        "--require-evidence",
        "tests/unit.json",
        "--timestamp",
        "2026-07-28T20:00:00.000Z",
        "--image-digest",
        `sha256:${"a".repeat(64)}`,
        "--web-image-digest",
        `sha256:${"b".repeat(64)}`,
      ],
      fixture.root,
      {
        HELIX_MODE: "single-tenant",
        HELIX_SECURITY_TIER: "business",
        HELIX_ENABLED_APPS: "drive,mail,chat,drive",
        HELIX_ENABLED_FEATURES: "agent-approvals,malware-scan",
      },
    );

    const first = await buildReleaseReadinessManifest(options);
    const second = await buildReleaseReadinessManifest(options);

    expect(second).toEqual(first);
    expect(first.generatedAt).toBe("2026-07-28T20:00:00.000Z");
    expect(first.release).toEqual({ mode: "preflight", requiredGates: [] });
    expect(first.repositories.workspace.dirty).toBe(false);
    expect(first.repositories.editors.dirty).toBe(false);
    expect(first.database.migrationHead).toBe("0002_second.sql");
    expect(first.deployment).toMatchObject({
      mode: "single-tenant",
      securityTier: "business",
      enabledApps: ["chat", "drive", "mail"],
      images: {
        application: `sha256:${"a".repeat(64)}`,
        web: `sha256:${"b".repeat(64)}`,
      },
    });
    expect(first.evidence.files).toEqual([
      {
        path: "tests/unit.json",
        bytes: 12,
        sha256: "e5f1eb4d806641698a35efe20e098efd20d7d57a9b90ee69079d5bb650920726",
      },
    ]);
  });

  it("keeps manifest output outside source evidence and refuses existing links", async () => {
    const fixture = await createFixture();
    const baseArgs = [
      "--workspace-dir",
      fixture.workspace,
      "--editors-dir",
      fixture.editors,
      "--evidence-dir",
      fixture.evidence,
      "--image-digest",
      `sha256:${"a".repeat(64)}`,
      "--web-image-digest",
      `sha256:${"b".repeat(64)}`,
    ];
    await expect(
      buildReleaseReadinessManifest(
        parseArgs(
          [...baseArgs, "--output", resolve(fixture.evidence, "manifest.json")],
          fixture.root,
          {},
        ),
      ),
    ).rejects.toThrow("output must be outside the source evidence directory");

    const evidenceTarget = resolve(fixture.evidence, "tests/unit.json");
    const originalEvidence = await readFile(evidenceTarget, "utf8");
    const symlinkOutput = resolve(fixture.root, "manifest-symlink.json");
    await symlink(evidenceTarget, symlinkOutput);
    await expect(
      writeManifestOutput(symlinkOutput, '{"safe":true}\n', fixture.evidence),
    ).rejects.toThrow("must not already exist or be a symbolic/hard link");
    expect(await readFile(evidenceTarget, "utf8")).toBe(originalEvidence);

    const hardLinkOutput = resolve(fixture.root, "manifest-hardlink.json");
    await link(evidenceTarget, hardLinkOutput);
    await expect(
      writeManifestOutput(hardLinkOutput, '{"safe":true}\n', fixture.evidence),
    ).rejects.toThrow("must not already exist or be a symbolic/hard link");
    expect(await readFile(evidenceTarget, "utf8")).toBe(originalEvidence);

    const aliasedEvidence = resolve(fixture.root, "evidence-alias");
    await symlink(fixture.evidence, aliasedEvidence);
    await expect(
      writeManifestOutput(
        resolve(aliasedEvidence, "manifest.json"),
        '{"safe":true}\n',
        fixture.evidence,
      ),
    ).rejects.toThrow("output must be outside the source evidence directory");

    const newOutput = resolve(fixture.root, "manifest-new.json");
    await writeManifestOutput(newOutput, '{"safe":true}\n', fixture.evidence);
    expect(await readFile(newOutput, "utf8")).toBe('{"safe":true}\n');
  });

  it("fails closed for dirty repositories and missing required evidence", async () => {
    const dirtyFixture = await createFixture();
    await writeFile(resolve(dirtyFixture.workspace, "dirty.txt"), "dirty\n", "utf8");
    await expect(
      buildReleaseReadinessManifest(
        parseArgs(
          [
            "--workspace-dir",
            dirtyFixture.workspace,
            "--editors-dir",
            dirtyFixture.editors,
            "--evidence-dir",
            dirtyFixture.evidence,
            "--image-digest",
            `sha256:${"b".repeat(64)}`,
            "--web-image-digest",
            `sha256:${"c".repeat(64)}`,
          ],
          dirtyFixture.root,
          {},
        ),
      ),
    ).rejects.toThrow("repository worktree must be clean: helix-workspace");

    const missingFixture = await createFixture();
    await expect(
      buildReleaseReadinessManifest(
        parseArgs(
          [
            "--workspace-dir",
            missingFixture.workspace,
            "--editors-dir",
            missingFixture.editors,
            "--evidence-dir",
            missingFixture.evidence,
            "--require-evidence",
            "restore/report.json",
            "--image-digest",
            `sha256:${"c".repeat(64)}`,
            "--web-image-digest",
            `sha256:${"d".repeat(64)}`,
          ],
          missingFixture.root,
          {},
        ),
      ),
    ).rejects.toThrow("required evidence missing: restore/report.json");
  });

  it("requires a valid immutable image digest", async () => {
    const fixture = await createFixture();
    const baseArgs = [
      "--workspace-dir",
      fixture.workspace,
      "--editors-dir",
      fixture.editors,
      "--evidence-dir",
      fixture.evidence,
    ];
    await expect(
      buildReleaseReadinessManifest(parseArgs(baseArgs, fixture.root, {})),
    ).rejects.toThrow("--application-image-digest");
    await expect(
      buildReleaseReadinessManifest(
        parseArgs(
          [
            ...baseArgs,
            "--image-digest",
            "latest",
            "--web-image-digest",
            `sha256:${"a".repeat(64)}`,
          ],
          fixture.root,
          {},
        ),
      ),
    ).rejects.toThrow("application image digest must be an OCI sha256 digest");
    await expect(
      buildReleaseReadinessManifest(
        parseArgs(
          [...baseArgs, "--application-image-digest", `sha256:${"a".repeat(64)}`],
          fixture.root,
          {},
        ),
      ),
    ).rejects.toThrow("--web-image-digest or HELIX_WEB_IMAGE_DIGEST is required");
    await expect(
      buildReleaseReadinessManifest(
        parseArgs(
          [
            ...baseArgs,
            "--application-image-digest",
            `sha256:${"a".repeat(64)}`,
            "--web-image-digest",
            "latest",
          ],
          fixture.root,
          {},
        ),
      ),
    ).rejects.toThrow("web image digest must be an OCI sha256 digest");
  });

  it("requires passed local Mail evidence and optionally fails closed on external not-run hooks", async () => {
    const fixture = await createFixture();
    const evidence = createEvidenceSkeleton(new Date("2026-07-28T20:00:00.000Z"));
    evidence.mode = "local";
    evidence.status = "passed";
    for (const scenario of MAIL_LIVE_SCENARIOS) {
      evidence.local[scenario] = passedLocalResult(scenario);
    }
    await writeFile(
      resolve(fixture.evidence, "mail-live-evidence.json"),
      `${JSON.stringify(evidence)}\n`,
      "utf8",
    );
    const args = [
      "--workspace-dir",
      fixture.workspace,
      "--editors-dir",
      fixture.editors,
      "--evidence-dir",
      fixture.evidence,
      "--mail-live-evidence",
      "mail-live-evidence.json",
      "--image-digest",
      `sha256:${"a".repeat(64)}`,
      "--web-image-digest",
      `sha256:${"b".repeat(64)}`,
    ];

    const manifest = await buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}));
    expect(manifest.evidence.mail).toMatchObject({
      path: "mail-live-evidence.json",
      status: "passed",
      external: {
        provider_sandbox: "not_run",
        gmail: "not_run",
        microsoft365: "not_run",
      },
    });

    await expect(
      buildReleaseReadinessManifest(
        parseArgs([...args, "--require-external-mail-evidence"], fixture.root, {}),
      ),
    ).rejects.toThrow(
      "external Mail evidence is incomplete: provider_sandbox, gmail, microsoft365",
    );
  });

  it("fails closed unless every required Agent live scenario passed", async () => {
    const fixture = await createFixture();
    const evidence = createAgentEvidenceSkeleton(new Date("2026-07-28T20:00:00.000Z"));
    await writeFile(
      resolve(fixture.evidence, "agent-live-evidence.json"),
      `${JSON.stringify(evidence)}\n`,
      "utf8",
    );
    const args = [
      "--workspace-dir",
      fixture.workspace,
      "--editors-dir",
      fixture.editors,
      "--evidence-dir",
      fixture.evidence,
      "--agent-live-evidence",
      "agent-live-evidence.json",
      "--image-digest",
      `sha256:${"a".repeat(64)}`,
      "--web-image-digest",
      `sha256:${"b".repeat(64)}`,
    ];

    await expect(buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}))).rejects.toThrow(
      "Agent live evidence is incomplete",
    );

    evidence.mode = "live";
    evidence.status = "passed";
    for (const scenario of AGENT_LIVE_SCENARIOS) {
      evidence.scenarios[scenario] = passedAgentResult(scenario);
    }
    await writeFile(
      resolve(fixture.evidence, "agent-live-evidence.json"),
      `${JSON.stringify(evidence)}\n`,
      "utf8",
    );
    const manifest = await buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}));
    expect(manifest.evidence.agent).toMatchObject({
      path: "agent-live-evidence.json",
      status: "passed",
      scenarios: AGENT_LIVE_SCENARIOS.map((scenario) => ({
        name: scenario,
        status: "passed",
      })),
    });
  });

  it("requires passed Chat C6 evidence at the full release pilot-load profile", async () => {
    const fixture = await createFixture();
    const evidencePath = resolve(fixture.evidence, "chat-live-evidence.json");
    await writeFile(
      evidencePath,
      `${JSON.stringify(createChatEvidenceSkeleton(new Date("2026-07-28T20:00:00.000Z")))}\n`,
      "utf8",
    );
    const args = [
      "--workspace-dir",
      fixture.workspace,
      "--editors-dir",
      fixture.editors,
      "--evidence-dir",
      fixture.evidence,
      "--chat-live-evidence",
      "chat-live-evidence.json",
      "--image-digest",
      `sha256:${"a".repeat(64)}`,
      "--web-image-digest",
      `sha256:${"b".repeat(64)}`,
    ];
    await expect(buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}))).rejects.toThrow(
      "invalid or incomplete Chat live evidence",
    );

    const tooBrief = passedChatEvidence();
    tooBrief.profile.durationSeconds = 1_799;
    tooBrief.scenarios.pilot_load.evidence.durationSeconds = 1_799;
    await writeFile(evidencePath, `${JSON.stringify(tooBrief)}\n`, "utf8");
    await expect(buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}))).rejects.toThrow(
      "release Chat load requires at least 1800 seconds",
    );

    await writeFile(evidencePath, `${JSON.stringify(passedChatEvidence())}\n`, "utf8");
    const manifest = await buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}));
    expect(manifest.evidence.chat).toMatchObject({
      path: "chat-live-evidence.json",
      status: "passed",
      profile: {
        users: 50,
        sockets: 100,
        durationSeconds: 1_800,
        p95LatencyMs: 100,
        p99LatencyMs: 200,
        errorRate: 0,
        memoryGrowthBytes: 10,
        eventLoopLagPeakMs: 10,
        dbPoolPendingPeak: 0,
        redisBacklogPeak: 0,
        natsBacklogPeak: 0,
      },
      scenarios: CHAT_LIVE_SCENARIOS.map((name) => ({ name, status: "passed" })),
    });
  });

  it("requires genuine passed Drive D7 evidence and publishes bounded measurements", async () => {
    const fixture = await createFixture();
    const evidencePath = resolve(fixture.evidence, "drive-live-evidence.json");
    await writeFile(
      evidencePath,
      `${JSON.stringify(notRunDriveEvidence(new Date("2026-07-28T20:00:00.000Z")))}\n`,
      "utf8",
    );
    const args = liveEvidenceArgs(fixture, "--drive-live-evidence", "drive-live-evidence.json");
    await expect(buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}))).rejects.toThrow(
      "invalid or incomplete Drive live evidence",
    );

    await writeFile(evidencePath, `${JSON.stringify(passedDriveEvidence())}\n`, "utf8");
    const manifest = await buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}));
    expect(manifest.evidence.drive).toMatchObject({
      path: "drive-live-evidence.json",
      status: "passed",
      durationMs: 1_000,
      cases: DRIVE_EVIDENCE_CASES.map((name) => ({
        name,
        status: "pass",
        durationMs: 1_000,
        metrics: driveMetrics()[name],
      })),
    });
  });

  it("requires genuine passed O2 data-plane evidence and publishes timings", async () => {
    const fixture = await createFixture();
    const evidencePath = resolve(fixture.evidence, "data-plane-live-evidence.json");
    await writeFile(
      evidencePath,
      `${JSON.stringify(createDataPlaneEvidenceSkeleton(new Date("2026-07-28T20:00:00.000Z")))}\n`,
      "utf8",
    );
    const args = liveEvidenceArgs(
      fixture,
      "--data-plane-live-evidence",
      "data-plane-live-evidence.json",
    );
    await expect(buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}))).rejects.toThrow(
      "invalid or incomplete data-plane live evidence",
    );

    await writeFile(evidencePath, `${JSON.stringify(passedDataPlaneEvidence())}\n`, "utf8");
    const manifest = await buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}));
    expect(manifest.evidence.dataPlane).toMatchObject({
      path: "data-plane-live-evidence.json",
      status: "passed",
      durationMs: 1_000,
      scenarios: DATA_PLANE_SCENARIOS.map((name) => ({
        name,
        status: "passed",
        durationMs: 1,
      })),
    });
  });

  it("requires genuine passed V4 failure/recovery evidence and publishes safe metrics", async () => {
    const fixture = await createFixture();
    const evidencePath = resolve(fixture.evidence, "failure-recovery-evidence.json");
    await writeFile(
      evidencePath,
      `${JSON.stringify(
        createStaticFailureRecoveryEvidence(new Date("2026-07-28T20:00:00.000Z")),
      )}\n`,
      "utf8",
    );
    const args = liveEvidenceArgs(
      fixture,
      "--failure-recovery-evidence",
      "failure-recovery-evidence.json",
      "--dast-evidence",
      "dast-evidence.json",
    );
    await expect(buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}))).rejects.toThrow(
      "invalid or incomplete failure/recovery evidence",
    );

    await writeFile(evidencePath, `${JSON.stringify(passedFailureRecoveryEvidence())}\n`, "utf8");
    const manifest = await buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}));
    expect(manifest.evidence.failureRecovery).toMatchObject({
      path: "failure-recovery-evidence.json",
      status: "passed",
      durationMs: 180_000,
      scenarios: FAILURE_RECOVERY_SCENARIOS.map(({ id, faultCount, minLogicalOperations }) => ({
        name: id,
        status: "passed",
        durationMs: 180_000,
        faultToRecoveryMs: 60_000,
        faultInjectionCount: faultCount,
        logicalOperationCount: minLogicalOperations,
        attemptCount: minLogicalOperations + faultCount,
        duplicateCount: 0,
        alertCount: FAILURE_RECOVERY_SCENARIOS.find(({ id: candidate }) => candidate === id).alerts
          .length,
      })),
    });
    expect(JSON.stringify(manifest.evidence.failureRecovery)).not.toContain("resourceId");
    expect(JSON.stringify(manifest.evidence.failureRecovery)).not.toContain("ref");
  });

  it("requires genuine passed and release-bound V5 DAST evidence", async () => {
    const fixture = await createFixture();
    const evidencePath = resolve(fixture.evidence, "dast-evidence.json");
    await writeFile(
      evidencePath,
      `${JSON.stringify(createStaticDastEvidence(new Date("2026-07-28T20:00:00.000Z")))}\n`,
      "utf8",
    );
    const args = liveEvidenceArgs(fixture, "--dast-evidence", "dast-evidence.json");
    await expect(buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}))).rejects.toThrow(
      "invalid or incomplete V5 DAST evidence",
    );

    const passed = passedDastEvidence();
    delete passed.releaseBinding;
    await writeFile(evidencePath, `${JSON.stringify(passed)}\n`, "utf8");
    await expect(buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}))).rejects.toThrow(
      "requires a release binding",
    );

    const binding = createReleaseEvidenceBinding({
      workspaceSha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fixture.workspace,
        encoding: "utf8",
      }).trim(),
      editorsSha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fixture.editors,
        encoding: "utf8",
      }).trim(),
      applicationImageDigest: `sha256:${"a".repeat(64)}`,
      webImageDigest: `sha256:${"b".repeat(64)}`,
    });
    await writeFile(evidencePath, `${JSON.stringify(passedDastEvidence(binding))}\n`, "utf8");
    const manifest = await buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}));
    expect(manifest.evidence.dast).toMatchObject({
      path: "dast-evidence.json",
      status: "passed",
      durationMs: 900_000,
      targetKind: "https",
      summary: {
        informational: 0,
        low: 0,
        medium: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
      dispositions: 0,
    });
  });

  it("requires live passed restore evidence and publishes measured RPO/RTO", async () => {
    const fixture = await createFixture();
    const evidencePath = resolve(fixture.evidence, "restore-drill-evidence.json");
    await writeFile(
      evidencePath,
      `${JSON.stringify(createStaticRestoreEvidence(new Date("2026-07-28T20:00:00.000Z")))}\n`,
      "utf8",
    );
    const args = [
      "--workspace-dir",
      fixture.workspace,
      "--editors-dir",
      fixture.editors,
      "--evidence-dir",
      fixture.evidence,
      "--restore-drill-evidence",
      "restore-drill-evidence.json",
      "--image-digest",
      `sha256:${"a".repeat(64)}`,
      "--web-image-digest",
      `sha256:${"b".repeat(64)}`,
    ];
    await expect(buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}))).rejects.toThrow(
      "restore drill evidence is incomplete",
    );

    const passed = passedRestoreEvidence();
    await writeFile(evidencePath, `${JSON.stringify(passed)}\n`, "utf8");
    const manifest = await buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}));
    expect(manifest.evidence.restore).toMatchObject({
      path: "restore-drill-evidence.json",
      status: "passed",
      rpoHours: 23,
      rtoHours: 1.5,
    });
  });

  it("requires every revision-bound live gate together in final-release mode", async () => {
    const fixture = await createFixture();
    const workspaceSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.workspace,
      encoding: "utf8",
    }).trim();
    const editorsSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.editors,
      encoding: "utf8",
    }).trim();
    const binding = createReleaseEvidenceBinding({
      workspaceSha,
      editorsSha,
      applicationImageDigest: `sha256:${"a".repeat(64)}`,
      webImageDigest: `sha256:${"b".repeat(64)}`,
    });
    const args = [
      "--final-release",
      ...liveEvidenceArgs(fixture, "--mail-live-evidence", "mail-live-evidence.json").slice(0, -4),
      "--drive-live-evidence",
      "drive-live-evidence.json",
      "--chat-live-evidence",
      "chat-live-evidence.json",
      "--agent-live-evidence",
      "agent-live-evidence.json",
      "--data-plane-live-evidence",
      "data-plane-live-evidence.json",
      "--restore-drill-evidence",
      "restore-drill-evidence.json",
      "--failure-recovery-evidence",
      "failure-recovery-evidence.json",
      "--dast-evidence",
      "dast-evidence.json",
      "--image-digest",
      binding.applicationImageDigest,
      "--web-image-digest",
      binding.webImageDigest,
      ...finalSupportingArgs(fixture),
    ];

    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "required Mail live evidence missing",
    );
    await writeFinalReleaseEvidence(fixture, undefined);
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "missing its required release binding",
    );

    await writeFinalReleaseEvidence(fixture, binding);
    await writeFinalSupportingEvidence(fixture, binding);
    const manifest = await buildFinalManifest(fixture, args);
    expect(manifest).toMatchObject({
      schemaVersion: 6,
      release: {
        mode: "final",
        requiredGates: [
          "M7",
          "D7",
          "C6",
          "A7",
          "O2",
          "O4",
          "V4",
          "V5",
          "V6",
          "R0",
          "R1",
          "R2",
          "R3",
        ],
      },
      repositories: {
        workspace: { sha: workspaceSha },
        editors: { sha: editorsSha },
      },
      deployment: {
        images: {
          application: binding.applicationImageDigest,
          web: binding.webImageDigest,
        },
      },
      evidence: {
        mail: { status: "passed" },
        drive: { status: "passed" },
        chat: { status: "passed" },
        agent: { status: "passed" },
        dataPlane: { status: "passed" },
        restore: { status: "passed" },
        failureRecovery: { status: "passed" },
        dast: { status: "passed" },
        fullGates: { status: "passed" },
        migration: { status: "deployed" },
        productionConfig: { status: "passed", mvpOnly: true },
        sloSoak: { status: "passed", durationHours: 24 },
        securityReview: { status: "passed" },
        supportReadiness: { status: "passed" },
        businessReadiness: { status: "passed", maximumUsers: 50 },
        productionDecision: { decision: "go" },
      },
    });
  });

  it("fails final-release mode on missing gates, binding mismatches, and external Mail gaps", async () => {
    const fixture = await createFixture();
    const base = [
      "--workspace-dir",
      fixture.workspace,
      "--editors-dir",
      fixture.editors,
      "--evidence-dir",
      fixture.evidence,
      "--final-release",
      "--image-digest",
      `sha256:${"a".repeat(64)}`,
      "--web-image-digest",
      `sha256:${"b".repeat(64)}`,
    ];
    await expect(buildFinalManifest(fixture, base)).rejects.toThrow(
      "--final-release requires all release evidence inputs",
    );

    const workspaceSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.workspace,
      encoding: "utf8",
    }).trim();
    const editorsSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.editors,
      encoding: "utf8",
    }).trim();
    const binding = createReleaseEvidenceBinding({
      workspaceSha,
      editorsSha,
      applicationImageDigest: `sha256:${"a".repeat(64)}`,
      webImageDigest: `sha256:${"b".repeat(64)}`,
    });
    await writeFinalReleaseEvidence(fixture, binding);
    const args = [
      ...base,
      "--mail-live-evidence",
      "mail-live-evidence.json",
      "--drive-live-evidence",
      "drive-live-evidence.json",
      "--chat-live-evidence",
      "chat-live-evidence.json",
      "--agent-live-evidence",
      "agent-live-evidence.json",
      "--data-plane-live-evidence",
      "data-plane-live-evidence.json",
      "--restore-drill-evidence",
      "restore-drill-evidence.json",
      "--failure-recovery-evidence",
      "failure-recovery-evidence.json",
      "--dast-evidence",
      "dast-evidence.json",
      ...finalSupportingArgs(fixture),
    ];

    const mailPath = resolve(fixture.evidence, "mail-live-evidence.json");
    const mail = JSON.parse(await readFile(mailPath, "utf8"));
    mail.external.gmail = {
      status: "not_run",
      reason: "external account unavailable",
    };
    await writeFile(mailPath, `${JSON.stringify(mail)}\n`, "utf8");
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "external Mail evidence is incomplete: gmail",
    );

    await writeFinalReleaseEvidence(fixture, binding);
    const drivePath = resolve(fixture.evidence, "drive-live-evidence.json");
    const drive = JSON.parse(await readFile(drivePath, "utf8"));
    drive.releaseBinding.workspaceSha = "d".repeat(40);
    await writeFile(drivePath, `${JSON.stringify(drive)}\n`, "utf8");
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "does not match the promoted release",
    );

    await writeFinalReleaseEvidence(fixture, binding);
    const editorsMismatch = JSON.parse(await readFile(drivePath, "utf8"));
    editorsMismatch.releaseBinding.editorsSha = "f".repeat(40);
    await writeFile(drivePath, `${JSON.stringify(editorsMismatch)}\n`, "utf8");
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "editorsSha does not match the promoted release",
    );

    await writeFinalReleaseEvidence(fixture, binding);
    const imageMismatch = JSON.parse(await readFile(drivePath, "utf8"));
    imageMismatch.releaseBinding.applicationImageDigest = `sha256:${"e".repeat(64)}`;
    await writeFile(drivePath, `${JSON.stringify(imageMismatch)}\n`, "utf8");
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "applicationImageDigest does not match the promoted release",
    );

    await writeFinalReleaseEvidence(fixture, binding);
    const secretBearing = JSON.parse(await readFile(drivePath, "utf8"));
    secretBearing.releaseBinding.signingSecret = "must-not-persist";
    await writeFile(drivePath, `${JSON.stringify(secretBearing)}\n`, "utf8");
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "unexpected, missing, or secret-like fields",
    );
  });

  it("fails final promotion on incomplete, stale, unsafe, or unsigned R0-R3 artifacts", async () => {
    const fixture = await createFixture();
    const binding = createReleaseEvidenceBinding({
      workspaceSha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fixture.workspace,
        encoding: "utf8",
      }).trim(),
      editorsSha: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fixture.editors,
        encoding: "utf8",
      }).trim(),
      applicationImageDigest: `sha256:${"a".repeat(64)}`,
      webImageDigest: `sha256:${"b".repeat(64)}`,
    });
    await writeFinalReleaseEvidence(fixture, binding);
    await writeFinalSupportingEvidence(fixture, binding);
    const args = [
      "--final-release",
      ...liveEvidenceArgs(fixture, "--mail-live-evidence", "mail-live-evidence.json").slice(0, -4),
      "--drive-live-evidence",
      "drive-live-evidence.json",
      "--chat-live-evidence",
      "chat-live-evidence.json",
      "--agent-live-evidence",
      "agent-live-evidence.json",
      "--data-plane-live-evidence",
      "data-plane-live-evidence.json",
      "--restore-drill-evidence",
      "restore-drill-evidence.json",
      "--failure-recovery-evidence",
      "failure-recovery-evidence.json",
      "--dast-evidence",
      "dast-evidence.json",
      "--image-digest",
      binding.applicationImageDigest,
      "--web-image-digest",
      binding.webImageDigest,
      ...finalSupportingArgs(fixture),
    ];
    await expect(buildFinalManifest(fixture, args)).resolves.toMatchObject({
      evidence: { productionDecision: { decision: "go" } },
    });

    const cases = [
      {
        path: "full-gates-evidence.json",
        mutate: (report) => report.workspace.commands.pop(),
        error: "required V6 command set",
      },
      {
        path: "full-gates-evidence.json",
        mutate: (report) => {
          report.workspace.commands[0].report.sha256 = `sha256:${"f".repeat(64)}`;
        },
        error: "path/digest is not retained",
      },
      {
        path: "full-gates-evidence.json",
        mutate: (report) => {
          report.workspace.commands[1].report = report.workspace.commands[0].report;
        },
        error: "does not cover the exact command",
      },
      {
        path: "migration-status-evidence.json",
        mutate: (report) => {
          report.migrationHead = "9999_not_deployed.sql";
        },
        error: "deployed migration head",
      },
      {
        path: "migration-status-evidence.json",
        mutate: (report) => {
          report.deployedAt = "2026-07-30T00:00:00.000Z";
        },
        error: "occurs after its evidence was generated",
      },
      {
        path: "production-config-evidence.json",
        mutate: (report) => {
          report.resolved = false;
        },
        error: "must be resolved",
      },
      {
        path: "production-config-evidence.json",
        mutate: (report) => {
          report.databasePassword = "should-never-be-in-evidence";
        },
        error: "secret-like field",
      },
      {
        path: "production-config-evidence.json",
        mutate: (report) => {
          report.coreApps.push("docs");
        },
        error: "approved MVP boundary",
      },
      {
        path: "production-config-evidence.json",
        mutate: (report) => {
          report.productionImages.application = `sha256:${"0".repeat(64)}`;
        },
        error: "does not match the promoted release",
      },
      {
        path: "production-config-evidence.json",
        mutate: (report) => {
          report.productionImages.redis = `sha256:${"0".repeat(64)}`;
        },
        error: "does not cover the resolved production image",
      },
      {
        path: "slo-soak-evidence.json",
        mutate: (report) => {
          report.window.durationHours = 23;
        },
        error: "at least 24 hours",
      },
      {
        path: "slo-soak-evidence.json",
        mutate: (report) => {
          report.profile.users = "50";
        },
        error: "must be positive",
      },
      {
        path: "slo-soak-evidence.json",
        mutate: (report) => {
          report.objectives.availabilityPercent = 101;
        },
        error: "does not meet the release objective",
      },
      {
        path: "security-review-evidence.json",
        mutate: (report) => {
          report.findings[0].severity = "critical";
        },
        error: "only Medium/Low",
      },
      {
        path: "security-review-evidence.json",
        mutate: (report) => {
          report.findings[0].expiresAt = "2026-07-29T00:00:00.000Z";
        },
        error: "is expired",
      },
      {
        path: "security-review-evidence.json",
        mutate: (report) => {
          delete report.containerScans.clamav;
        },
        error: "unexpected or missing fields",
      },
      {
        path: "security-review-evidence.json",
        mutate: (report) => {
          report.sboms.postgres.imageDigest = `sha256:${"0".repeat(64)}`;
        },
        error: "does not cover the resolved production image",
      },
      {
        path: "security-review-evidence.json",
        mutate: (report) => {
          report.sensitiveDataScan.scope = "repository-only";
        },
        error: "complete release packet",
      },
      {
        path: "support-readiness-evidence.json",
        mutate: (report) => {
          report.privatePilot.durationDays = 27;
        },
        error: "at least 28 days",
      },
      {
        path: "support-readiness-evidence.json",
        mutate: (report) => {
          report.privatePilot.startedAt = "2026-05-14T00:00:00.000Z";
        },
        error: "must start after the dogfood exit review",
      },
      {
        path: "support-readiness-evidence.json",
        mutate: (report) => {
          report.incidentHistory.startedAt = "2026-06-11T00:00:00.000Z";
        },
        error: "must cover the complete dogfood",
      },
      {
        path: "full-gates-evidence.json",
        mutate: (report) => {
          report.editors.changed = true;
        },
        error: "trusted previous release revision",
      },
      {
        path: "business-readiness-evidence.json",
        mutate: (report) => {
          report.limits.nativeEditorsEnabled = true;
        },
        error: "approved MVP decisions",
      },
      {
        path: "business-readiness-evidence.json",
        mutate: (report) => {
          report.generatedAt = "2026-07-01T00:00:00.000Z";
        },
        error: "stale for final release",
      },
      {
        path: "production-decision-evidence.json",
        mutate: (report) => {
          report.decision = "no_go";
        },
        error: "decision is no_go",
      },
      {
        path: "production-decision-evidence.json",
        mutate: (report) => {
          report.evidenceSetSha256 = `sha256:${"f".repeat(64)}`;
        },
        error: "exact release evidence set",
      },
      {
        path: "production-decision-evidence.json",
        mutate: (report) => {
          report.signature.value = Buffer.alloc(64).toString("base64");
        },
        error: "signature is invalid",
      },
      {
        path: "production-decision-evidence.json",
        mutate: (report) => {
          report.signature.signer = "impersonated-release-board@example.invalid";
        },
        error: "signature is invalid",
      },
      {
        path: "production-decision-evidence.json",
        mutate: (report) => {
          report.decidedAt = "2026-07-28T00:00:00.000Z";
        },
        error: "older than 24 hours",
      },
    ];
    for (const testCase of cases) {
      const path = resolve(fixture.evidence, testCase.path);
      const original = await readFile(path, "utf8");
      const report = JSON.parse(original);
      testCase.mutate(report);
      await writeFile(path, `${JSON.stringify(report)}\n`, "utf8");
      await expect(buildFinalManifest(fixture, args)).rejects.toThrow(testCase.error);
      await writeFile(path, original, "utf8");
    }

    const alternate = generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    });
    const alternatePath = resolve(fixture.root, "alternate-decision-public.pem");
    await writeFile(alternatePath, alternate, "utf8");
    await expect(
      buildFinalManifest(fixture, args, {
        HELIX_RELEASE_TRUSTED_DECISION_PUBLIC_KEY: alternatePath,
      }),
    ).rejects.toThrow("fingerprint does not match");
  });

  it("keeps final-release clock and signer trust under verifier control", async () => {
    const fixture = await createFixture();
    const binding = fixtureBinding(fixture);
    const args = completeFinalArgs(fixture, binding);
    await writeFinalReleaseEvidence(fixture, binding);
    await writeFinalSupportingEvidence(fixture, binding);

    expect(() =>
      parseArgs([...args, "--timestamp", FINAL_NOW], fixture.root, finalEnvironment(fixture)),
    ).toThrow("--timestamp is prohibited");
    expect(() =>
      parseArgs(
        [...args, "--decision-public-key", fixture.decisionPublicKeyPath],
        fixture.root,
        finalEnvironment(fixture),
      ),
    ).toThrow("unknown argument: --decision-public-key");
    expect(() =>
      parseArgs(
        [...args, "--rekor-public-key", fixture.rekorPublicKeyPath],
        fixture.root,
        finalEnvironment(fixture),
      ),
    ).toThrow("unknown argument: --rekor-public-key");
    await expect(
      buildFinalManifest(fixture, args, {
        HELIX_RELEASE_TRUSTED_REKOR_PUBLIC_KEY: undefined,
      }),
    ).rejects.toThrow("HELIX_RELEASE_TRUSTED_REKOR_PUBLIC_KEY");
    await expect(
      buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}), {
        now: () => new Date(FINAL_NOW),
      }),
    ).rejects.toThrow("HELIX_RELEASE_TRUSTED_DECISION_PUBLIC_KEY");

    const mailPath = resolve(fixture.evidence, "mail-live-evidence.json");
    const mail = JSON.parse(await readFile(mailPath, "utf8"));
    mail.completedAt = "2026-07-31T00:00:00.000Z";
    await writeFile(mailPath, `${JSON.stringify(mail)}\n`, "utf8");
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "Mail live evidence cannot be generated in the future",
    );
  });

  it("fails if source evidence changes after its validation snapshot", async () => {
    const fixture = await createFixture();
    const binding = fixtureBinding(fixture);
    const args = completeFinalArgs(fixture, binding);
    await writeFinalReleaseEvidence(fixture, binding);
    await writeFinalSupportingEvidence(fixture, binding);
    const options = parseArgs(args, fixture.root, finalEnvironment(fixture));
    const configurationPath = resolve(fixture.evidence, "production-config-evidence.json");

    await expect(
      buildReleaseReadinessManifest(options, {
        now: () => new Date(FINAL_NOW),
        afterEvidenceSnapshot: async () => {
          await writeFile(configurationPath, '{"tampered":true}\n', "utf8");
        },
      }),
    ).rejects.toThrow("source evidence changed while the release packet was being validated");
  });

  it("binds every referenced artifact to its retained path, hash, and document schema", async () => {
    const fixture = await createFixture();
    const binding = fixtureBinding(fixture);
    const args = completeFinalArgs(fixture, binding);
    await writeFinalReleaseEvidence(fixture, binding);
    await writeFinalSupportingEvidence(fixture, binding);
    const fullGatesPath = resolve(fixture.evidence, "full-gates-evidence.json");
    const fullGates = JSON.parse(await readFile(fullGatesPath, "utf8"));
    const reference = fullGates.workspace.commands[0].report;
    const replacement = '{"schema":"helix.evidence.wrong.v1","status":"passed"}\n';
    await writeFile(resolve(fixture.evidence, reference.path), replacement, "utf8");
    reference.sha256 = `sha256:${createHash("sha256").update(replacement).digest("hex")}`;
    await writeFile(fullGatesPath, `${JSON.stringify(fullGates)}\n`, "utf8");

    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "retained document does not match its declared artifact schema",
    );
  });

  it("rejects byte-identical artifacts reused through distinct retained paths", () => {
    const artifactDigests = new Map();
    const context = { artifactPaths: new Map(), artifactDigests };
    const digest = `sha256:${"a".repeat(64)}`;
    registerArtifactIdentity({ path: "artifacts/first.json", sha256: digest }, "first", context);
    expect(() =>
      registerArtifactIdentity(
        { path: "artifacts/copied.json", sha256: digest },
        "copied",
        context,
      ),
    ).toThrow("reuses byte-identical retained artifact assigned to first");
  });

  it("binds generic retained artifacts to their exact release role and risk", async () => {
    const fixture = await createFixture();
    const binding = fixtureBinding(fixture);
    const args = completeFinalArgs(fixture, binding);
    await writeFinalReleaseEvidence(fixture, binding);
    await writeFinalSupportingEvidence(fixture, binding);
    await mutateReferencedArtifact(
      fixture,
      "business-readiness-evidence.json",
      (report) => report.risks[0].mitigation,
      (artifact) => {
        artifact.riskId = "RISK-COPIED";
      },
    );

    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "riskId does not match its accepted risk",
    );
  });

  it("validates the security meaning of retained command, scan, and SBOM artifacts", async () => {
    const fixture = await createFixture();
    const binding = fixtureBinding(fixture);
    const args = completeFinalArgs(fixture, binding);
    await writeFinalReleaseEvidence(fixture, binding);

    await writeFinalSupportingEvidence(fixture, binding);
    await mutateReferencedArtifact(
      fixture,
      "full-gates-evidence.json",
      (report) => report.workspace.commands[0].report,
      (artifact) => {
        artifact.command = "pnpm unreviewed-command";
      },
    );
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "does not cover the exact command",
    );

    await writeFinalSupportingEvidence(fixture, binding);
    await mutateReferencedArtifact(
      fixture,
      "security-review-evidence.json",
      (report) => report.containerScans.application.artifact,
      (artifact) => {
        artifact.critical = 1;
      },
    );
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "reports blocking High/Critical vulnerabilities",
    );

    await writeFinalSupportingEvidence(fixture, binding);
    await mutateReferencedArtifact(
      fixture,
      "security-review-evidence.json",
      (report) => report.sboms.application.artifact,
      (artifact) => {
        artifact.imageDigest = `sha256:${"9".repeat(64)}`;
      },
    );
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "image digest does not match its summary",
    );

    await writeFinalSupportingEvidence(fixture, binding);
    await mutateReferencedArtifact(
      fixture,
      "security-review-evidence.json",
      (report) => report.sboms.application.artifact,
      (artifact) => {
        delete artifact.spdxArtifact;
      },
    );
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow("unexpected or missing fields");

    await writeFinalSupportingEvidence(fixture, binding);
    await substituteSpdxArtifact(fixture, "application", "web");
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "name does not bind the exact image subject and digest",
    );

    await writeFinalSupportingEvidence(fixture, binding);
    await mutateSpdxArtifact(fixture, "application", (document) => {
      document.packages[0].checksums[0].checksumValue = "9".repeat(64);
    });
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "does not contain the exact image SHA-256",
    );
  });

  it("verifies offline image provenance against the trusted issuer and paired revisions", async () => {
    const fixture = await createFixture();
    const binding = fixtureBinding(fixture);
    const args = completeFinalArgs(fixture, binding);
    await writeFinalReleaseEvidence(fixture, binding);

    await writeFinalSupportingEvidence(fixture, binding);
    await mutateImageProvenance(fixture, "application", (document) => {
      document.subjectDigest = `sha256:${"9".repeat(64)}`;
    });
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "provenance subject does not match the promoted image",
    );

    await writeFinalSupportingEvidence(fixture, binding);
    await mutateImageProvenance(fixture, "application", (document) => {
      const payload = JSON.parse(
        Buffer.from(document.bundle.dsseEnvelope.payload, "base64").toString("utf8"),
      );
      payload.predicate.editors.sha = "9".repeat(40);
      resignProvenancePayload(fixture, document, payload);
    });
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "does not bind the exact workspace and editor revisions",
    );

    await writeFinalSupportingEvidence(fixture, binding);
    await mutateImageProvenance(fixture, "application", (document) => {
      const current = document.bundle.dsseEnvelope.signatures[0].sig;
      document.bundle.dsseEnvelope.signatures[0].sig = `${current.startsWith("A") ? "B" : "A"}${current.slice(1)}`;
    });
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "provenance DSSE signature is invalid",
    );

    await writeFinalSupportingEvidence(fixture, binding);
    await mutateImageProvenance(fixture, "application", (document) => {
      document.bundle.verificationMaterial.tlogEntries = [];
    });
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "must contain exactly one transparency-log entry",
    );

    await writeFinalSupportingEvidence(fixture, binding);
    await mutateImageProvenance(fixture, "application", (document) => {
      const entry = document.bundle.verificationMaterial.tlogEntries[0];
      const current = entry.inclusionPromise.signedEntryTimestamp;
      entry.inclusionPromise.signedEntryTimestamp = `${current.startsWith("A") ? "B" : "A"}${current.slice(1)}`;
    });
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "Rekor signed entry timestamp is invalid",
    );

    await writeFinalSupportingEvidence(fixture, binding);
    await mutateImageProvenance(fixture, "application", (document) => {
      const payload = Buffer.from(document.bundle.dsseEnvelope.payload, "base64");
      document.bundle.verificationMaterial.tlogEntries = [
        createTestRekorEntry(fixture, document.bundle.dsseEnvelope, payload, {
          integratedAt: "2026-07-28T23:00:00.000Z",
        }),
      ];
      document.generatedAt = "2026-07-29T21:00:00.000Z";
    });
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "authenticated Rekor integration is stale for final release",
    );

    await writeFinalSupportingEvidence(fixture, binding);
    await mutateImageProvenance(fixture, "application", (document) => {
      const entry = document.bundle.verificationMaterial.tlogEntries[0];
      entry.inclusionProof.rootHash = Buffer.alloc(32, 7).toString("base64");
    });
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "Rekor inclusion proof does not bind the logged body",
    );

    await writeFinalSupportingEvidence(fixture, binding);
    await mutateImageProvenance(fixture, "application", (document) => {
      const entry = document.bundle.verificationMaterial.tlogEntries[0];
      const checkpoint = entry.inclusionProof.checkpoint.envelope;
      entry.inclusionProof.checkpoint.envelope = checkpoint.replace(
        / ([A-Za-z0-9+/=]+)\n$/u,
        (_match, signature) => ` ${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}\n`,
      );
    });
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "Rekor checkpoint signature is invalid",
    );

    await writeFinalSupportingEvidence(fixture, binding);
    await expect(
      buildFinalManifest(fixture, args, {
        HELIX_RELEASE_TRUSTED_REKOR_LOG_ID: `sha256:${"9".repeat(64)}`,
      }),
    ).rejects.toThrow("Rekor log identity does not match protected trust");

    await writeFinalSupportingEvidence(fixture, binding);
    await expect(
      buildFinalManifest(fixture, args, {
        HELIX_RELEASE_TRUSTED_GITHUB_WORKFLOW_IDENTITY:
          "https://github.com/billiondollarsolo/helix-workspace/.github/workflows/untrusted.yml@refs/heads/main",
      }),
    ).rejects.toThrow("provenance certificate workflow identity is not trusted");

    await writeFinalSupportingEvidence(fixture, binding);
    await expect(
      buildFinalManifest(fixture, args, {
        HELIX_RELEASE_TRUSTED_FULCIO_ISSUER_CERTIFICATE: fixture.fulcioLeafCertificatePath,
      }),
    ).rejects.toThrow("provenance certificate is not issued by the trusted Fulcio issuer");
  });

  it("binds the signed decision to the complete safe release packet and protected Git state", async () => {
    const fixture = await createFixture();
    const binding = fixtureBinding(fixture);
    const args = completeFinalArgs(fixture, binding);
    await writeFinalReleaseEvidence(fixture, binding);
    await writeFile(
      resolve(fixture.evidence, "operator-review.json"),
      '{"schema":"helix.evidence.operator-review.v1","status":"passed"}\n',
      "utf8",
    );
    await writeFinalSupportingEvidence(fixture, binding);
    await writeFile(
      resolve(fixture.evidence, "operator-review.json"),
      '{"schema":"helix.evidence.operator-review.v1","status":"changed"}\n',
      "utf8",
    );
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow("exact release evidence set");

    await writeFinalSupportingEvidence(fixture, binding);
    execFileSync("git", ["tag", "-d", "release-fixture"], { cwd: fixture.workspace });
    await expect(buildFinalManifest(fixture, args)).resolves.toMatchObject({
      evidence: {
        protectedRepositoryState: {
          status: "passed",
          workspaceSha: binding.workspaceSha,
        },
      },
    });

    await writeFinalSupportingEvidence(fixture, binding);
    const protectedStatePath = resolve(
      fixture.evidence,
      "protected-repository-state-evidence.json",
    );
    const mismatchedState = JSON.parse(await readFile(protectedStatePath, "utf8"));
    mismatchedState.repositories.workspace.tagSha = "9".repeat(40);
    signProtectedRepositoryState(fixture, mismatchedState);
    await writeFile(protectedStatePath, `${JSON.stringify(mismatchedState)}\n`, "utf8");
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "protected branch/tag state does not match the promoted release",
    );

    await writeFinalSupportingEvidence(fixture, binding);
    const invalidSignature = JSON.parse(await readFile(protectedStatePath, "utf8"));
    invalidSignature.signature.value =
      `${invalidSignature.signature.value.startsWith("A") ? "B" : "A"}` +
      invalidSignature.signature.value.slice(1);
    await writeFile(protectedStatePath, `${JSON.stringify(invalidSignature)}\n`, "utf8");
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow(
      "protected repository state signature is invalid",
    );

    await writeFinalSupportingEvidence(fixture, binding);
    const staleState = JSON.parse(await readFile(protectedStatePath, "utf8"));
    staleState.generatedAt = "2026-07-29T22:00:00.000Z";
    staleState.observedAt = "2026-07-29T22:00:00.000Z";
    signProtectedRepositoryState(fixture, staleState);
    await writeFile(protectedStatePath, `${JSON.stringify(staleState)}\n`, "utf8");
    await expect(buildFinalManifest(fixture, args)).rejects.toThrow("stale for final release");
  });

  it("rejects unsafe evidence filenames before they can leak into the manifest", async () => {
    const fixture = await createFixture();
    await writeFile(resolve(fixture.evidence, "customer token.json"), "{}\n", "utf8");
    const args = liveEvidenceArgs(fixture, "--mail-live-evidence", "mail-live-evidence.json");
    await writeFile(
      resolve(fixture.evidence, "mail-live-evidence.json"),
      `${JSON.stringify(passedMailEvidence())}\n`,
      "utf8",
    );
    await expect(buildReleaseReadinessManifest(parseArgs(args, fixture.root, {}))).rejects.toThrow(
      "evidence path must be relative and stay inside",
    );
  });
});

function liveEvidenceArgs(fixture, flag, path) {
  return [
    "--workspace-dir",
    fixture.workspace,
    "--editors-dir",
    fixture.editors,
    "--evidence-dir",
    fixture.evidence,
    flag,
    path,
    "--image-digest",
    `sha256:${"a".repeat(64)}`,
    "--web-image-digest",
    `sha256:${"b".repeat(64)}`,
  ];
}

function finalSupportingArgs() {
  return [
    "--full-gates-evidence",
    "full-gates-evidence.json",
    "--migration-status-evidence",
    "migration-status-evidence.json",
    "--production-config-evidence",
    "production-config-evidence.json",
    "--slo-soak-evidence",
    "slo-soak-evidence.json",
    "--security-review-evidence",
    "security-review-evidence.json",
    "--support-readiness-evidence",
    "support-readiness-evidence.json",
    "--business-readiness-evidence",
    "business-readiness-evidence.json",
    "--protected-repository-state-evidence",
    "protected-repository-state-evidence.json",
    "--production-decision-evidence",
    "production-decision-evidence.json",
  ];
}

function fixtureBinding(fixture) {
  return createReleaseEvidenceBinding({
    workspaceSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.workspace,
      encoding: "utf8",
    }).trim(),
    editorsSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture.editors,
      encoding: "utf8",
    }).trim(),
    applicationImageDigest: `sha256:${"a".repeat(64)}`,
    webImageDigest: `sha256:${"b".repeat(64)}`,
  });
}

function completeFinalArgs(fixture, binding) {
  return [
    "--final-release",
    ...liveEvidenceArgs(fixture, "--mail-live-evidence", "mail-live-evidence.json").slice(0, -4),
    "--drive-live-evidence",
    "drive-live-evidence.json",
    "--chat-live-evidence",
    "chat-live-evidence.json",
    "--agent-live-evidence",
    "agent-live-evidence.json",
    "--data-plane-live-evidence",
    "data-plane-live-evidence.json",
    "--restore-drill-evidence",
    "restore-drill-evidence.json",
    "--failure-recovery-evidence",
    "failure-recovery-evidence.json",
    "--dast-evidence",
    "dast-evidence.json",
    "--image-digest",
    binding.applicationImageDigest,
    "--web-image-digest",
    binding.webImageDigest,
    ...finalSupportingArgs(),
  ];
}

function finalEnvironment(fixture, overrides = {}) {
  return {
    HELIX_RELEASE_TRUSTED_DECISION_PUBLIC_KEY: fixture.decisionPublicKeyPath,
    HELIX_RELEASE_TRUSTED_DECISION_SIGNER_FINGERPRINT: fixture.decisionSignerFingerprint,
    HELIX_RELEASE_TRUSTED_GIT_STATE_PUBLIC_KEY: fixture.gitStatePublicKeyPath,
    HELIX_RELEASE_TRUSTED_GIT_STATE_SIGNER_FINGERPRINT: fixture.gitStateSignerFingerprint,
    HELIX_RELEASE_TRUSTED_GIT_STATE_SIGNER: "protected-git-state-verifier@example.invalid",
    HELIX_RELEASE_TRUSTED_FULCIO_ISSUER_CERTIFICATE: fixture.fulcioIssuerCertificatePath,
    HELIX_RELEASE_TRUSTED_REKOR_PUBLIC_KEY: fixture.rekorPublicKeyPath,
    HELIX_RELEASE_TRUSTED_REKOR_LOG_ID: fixture.rekorLogId,
    HELIX_RELEASE_TRUSTED_REKOR_CHECKPOINT_ORIGIN: fixture.rekorCheckpointOrigin,
    HELIX_RELEASE_TRUSTED_GITHUB_REPOSITORY: WORKSPACE_REPOSITORY,
    HELIX_RELEASE_TRUSTED_EDITORS_REPOSITORY: EDITORS_REPOSITORY,
    HELIX_RELEASE_TRUSTED_GITHUB_WORKFLOW_IDENTITY: WORKFLOW_IDENTITY,
    HELIX_RELEASE_TRUSTED_APPLICATION_SUBJECT: "ghcr.io/billiondollarsolo/helix-workspace",
    HELIX_RELEASE_TRUSTED_WEB_SUBJECT: "ghcr.io/billiondollarsolo/helix-workspace-web",
    HELIX_RELEASE_PREVIOUS_EDITORS_SHA: fixture.editorsSha,
    HELIX_RELEASE_REQUIRED_BRANCH: "main",
    HELIX_RELEASE_WORKSPACE_TAG: "release-fixture",
    HELIX_RELEASE_EDITORS_TAG: "release-fixture",
    ...overrides,
  };
}

function buildFinalManifest(fixture, args, environmentOverrides = {}) {
  const options = parseArgs(args, fixture.root, finalEnvironment(fixture, environmentOverrides));
  return buildReleaseReadinessManifest(options, { now: () => new Date(FINAL_NOW) });
}

async function listRelativeFiles(root, directory = root) {
  const paths = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await listRelativeFiles(root, absolute)));
    } else if (entry.isFile()) {
      paths.push(
        absolute
          .slice(root.length + 1)
          .split("\\")
          .join("/"),
      );
    }
  }
  return paths.sort();
}

async function writeFinalReleaseEvidence(fixture, binding) {
  const reports = {
    "mail-live-evidence.json": passedMailEvidence(),
    "drive-live-evidence.json": passedDriveEvidence(),
    "chat-live-evidence.json": passedChatEvidence(),
    "agent-live-evidence.json": passedAgentEvidence(),
    "data-plane-live-evidence.json": passedDataPlaneEvidence(),
    "restore-drill-evidence.json": passedRestoreEvidence(),
    "failure-recovery-evidence.json": passedFailureRecoveryEvidence(),
    "dast-evidence.json": passedDastEvidence(),
  };
  await Promise.all(
    Object.entries(reports).map(([name, report]) => {
      attachReleaseEvidenceBinding(report, binding);
      return writeFile(resolve(fixture.evidence, name), `${JSON.stringify(report)}\n`, "utf8");
    }),
  );
}

async function writeFinalSupportingEvidence(fixture, binding) {
  const timestamp = "2026-07-28T20:00:00.000Z";
  const gateStartedAt = "2026-07-29T20:00:00.000Z";
  const later = "2026-07-29T21:00:00.000Z";
  const reportAt = "2026-07-29T21:00:00.000Z";
  let artifactNumber = 0;
  const artifact = async (schema, label, overrides = {}) => {
    artifactNumber += 1;
    const path = `artifacts/${String(artifactNumber).padStart(3, "0")}-${label}.json`;
    const document = retainedArtifactDocument(schema, label, {
      releaseBinding: binding,
      ...overrides,
    });
    const content = `${JSON.stringify(document)}\n`;
    await mkdir(dirname(resolve(fixture.evidence, path)), { recursive: true });
    await writeFile(resolve(fixture.evidence, path), content, "utf8");
    return {
      path,
      sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      schema,
    };
  };
  const commandReports = await Promise.all(
    REQUIRED_WORKSPACE_GATES.map((command, index) =>
      artifact(ARTIFACT_SCHEMAS.commandReport, `workspace-command-${index}`, {
        command,
        revision: binding.workspaceSha,
        completedAt: later,
      }),
    ),
  );
  const rollbackPlan = await artifact(ARTIFACT_SCHEMAS.rollbackPlan, "rollback-plan", {
    status: "approved",
    role: "migration-rollback-plan",
  });
  const soakReport = await artifact(ARTIFACT_SCHEMAS.soakReport, "soak-report", {
    role: "production-slo-soak-report",
  });
  const threatModel = await artifact(ARTIFACT_SCHEMAS.threatModel, "threat-model", {
    status: "approved",
    role: "production-threat-model",
  });
  const repositoryScan = await artifact(ARTIFACT_SCHEMAS.repositoryScan, "repository-scan", {
    completedAt: later,
  });
  const dependencyAudit = await artifact(ARTIFACT_SCHEMAS.dependencyAudit, "dependency-audit", {
    completedAt: later,
  });
  const sensitiveDataScan = await artifact(
    ARTIFACT_SCHEMAS.sensitiveDataScan,
    "sensitive-data-scan",
    { completedAt: later, scope: "repository-and-release-packet" },
  );
  const manualReview = await artifact(ARTIFACT_SCHEMAS.manualReview, "manual-review", {
    completedAt: later,
  });
  const findingDisposition = await artifact(
    ARTIFACT_SCHEMAS.findingDisposition,
    "finding-disposition",
    {
      findingIdHash: `sha256:${"f".repeat(64)}`,
      disposition: "accepted",
      owner: "security-owner@example.invalid",
    },
  );
  const runbookIndex = await artifact(ARTIFACT_SCHEMAS.runbookIndex, "runbook-index", {
    role: "production-runbook-index",
  });
  const limitations = await artifact(ARTIFACT_SCHEMAS.limitations, "limitations", {
    role: "production-mvp-limitations",
  });
  const dogfoodObservations = await artifact(
    ARTIFACT_SCHEMAS.rolloutObservations,
    "dogfood-observations",
    { role: "rollout-observations", phase: "dogfood" },
  );
  const dogfoodExit = await artifact(ARTIFACT_SCHEMAS.rolloutExitReview, "dogfood-exit", {
    role: "rollout-exit-review",
    phase: "dogfood",
  });
  const pilotObservations = await artifact(
    ARTIFACT_SCHEMAS.rolloutObservations,
    "pilot-observations",
    { role: "rollout-observations", phase: "private-pilot" },
  );
  const pilotExit = await artifact(ARTIFACT_SCHEMAS.rolloutExitReview, "pilot-exit", {
    role: "rollout-exit-review",
    phase: "private-pilot",
  });
  const independentReview = await artifact(
    ARTIFACT_SCHEMAS.independentSecurityReview,
    "independent-security-review",
    { role: "independent-security-review", phase: "private-pilot" },
  );
  const costModel = await artifact(ARTIFACT_SCHEMAS.costModel, "cost-model", {
    role: "production-cost-model",
  });
  const riskMitigation = await artifact(ARTIFACT_SCHEMAS.riskMitigation, "risk-mitigation", {
    role: "accepted-risk-mitigation",
    riskId: "RISK-1",
  });
  const imageDigests = Object.fromEntries(
    REQUIRED_PRODUCTION_IMAGES.map((name, index) => [
      name,
      name === "application"
        ? binding.applicationImageDigest
        : name === "web"
          ? binding.webImageDigest
          : `sha256:${"23456789"[index - 2].repeat(64)}`,
    ]),
  );
  const imageProvenance = Object.fromEntries(
    await Promise.all(
      [
        ["application", "ghcr.io/billiondollarsolo/helix-workspace"],
        ["web", "ghcr.io/billiondollarsolo/helix-workspace-web"],
      ].map(async ([name, subjectName]) => [
        name,
        await artifact(ARTIFACT_SCHEMAS.imageProvenance, `${name}-image-provenance`, {
          document: createSigstoreProvenanceArtifact(
            fixture,
            binding,
            subjectName,
            imageDigests[name],
          ),
        }),
      ]),
    ),
  );
  const containerScans = Object.fromEntries(
    await Promise.all(
      REQUIRED_PRODUCTION_IMAGES.map(async (name) => [
        name,
        {
          status: "passed",
          completedAt: later,
          imageDigest: imageDigests[name],
          artifact: await artifact(ARTIFACT_SCHEMAS.containerScan, `${name}-container-scan`, {
            completedAt: later,
            imageDigest: imageDigests[name],
          }),
        },
      ]),
    ),
  );
  const sboms = Object.fromEntries(
    await Promise.all(
      REQUIRED_PRODUCTION_IMAGES.map(async (name) => {
        const imageSubject = REQUIRED_PRODUCTION_IMAGE_SUBJECTS[name];
        const spdxArtifact = await artifact(
          ARTIFACT_SCHEMAS.spdxDocument,
          `${name}-spdx-document`,
          {
            document: createSpdxDocument(imageSubject, imageDigests[name]),
          },
        );
        return [
          name,
          {
            status: "passed",
            completedAt: later,
            imageDigest: imageDigests[name],
            artifact: await artifact(ARTIFACT_SCHEMAS.sbom, `${name}-sbom`, {
              completedAt: later,
              imageDigest: imageDigests[name],
              imageSubject,
              spdxArtifact,
            }),
          },
        ];
      }),
    ),
  );
  const check = (artifactReference) => ({
    status: "passed",
    completedAt: later,
    artifact: artifactReference,
  });
  const reports = {
    "full-gates-evidence.json": {
      schema: FINAL_ARTIFACT_SCHEMAS.fullGates,
      generatedAt: reportAt,
      releaseBinding: binding,
      status: "passed",
      implementationTasksComplete: true,
      reviewedPullRequestsMerged: true,
      workspace: {
        revision: binding.workspaceSha,
        commands: REQUIRED_WORKSPACE_GATES.map((command, index) => ({
          command,
          status: "passed",
          startedAt: gateStartedAt,
          completedAt: later,
          report: commandReports[index],
        })),
      },
      editors: { changed: false, revision: binding.editorsSha, commands: [] },
    },
    "migration-status-evidence.json": {
      schema: FINAL_ARTIFACT_SCHEMAS.migration,
      generatedAt: reportAt,
      releaseBinding: binding,
      status: "deployed",
      migrationHead: "0002_second.sql",
      deployedAt: later,
      environmentSha256: `sha256:${"e".repeat(64)}`,
      migrator: { replicas: 1, advisoryLock: true, completedAt: later },
      rollbackPlan: {
        status: "approved",
        owner: "platform-owner@example.invalid",
        approvedAt: timestamp,
        artifact: rollbackPlan,
      },
    },
    "production-config-evidence.json": {
      schema: FINAL_ARTIFACT_SCHEMAS.productionConfig,
      generatedAt: reportAt,
      releaseBinding: binding,
      status: "passed",
      environment: "production",
      resolved: true,
      configurationSha256: `sha256:${"c".repeat(64)}`,
      sourceCount: 3,
      unresolvedCount: 0,
      prohibitedValuesDetected: false,
      mvpOnly: true,
      mode: "single-tenant",
      securityTier: "business",
      coreApps: APPROVED_MVP_CORE_APPS,
      webSurfaces: APPROVED_MVP_WEB_SURFACES,
      disabledSurfaces: DISABLED_MVP_SURFACES,
      featureControls: {
        mvpWebOnly: true,
        editorMigrationsEnabled: false,
        nativeEditorsEnabled: false,
        fileEditingEnabled: false,
        mailEnabled: true,
        driveFileStorageEnabled: true,
        serverReadableSecureChat: true,
        agentWritesConfirmedByDefault: true,
      },
      productionImages: imageDigests,
      imageProvenance,
    },
    "slo-soak-evidence.json": {
      schema: FINAL_ARTIFACT_SCHEMAS.sloSoak,
      generatedAt: "2026-07-29T20:00:00.000Z",
      releaseBinding: binding,
      status: "passed",
      window: {
        startedAt: timestamp,
        completedAt: "2026-07-29T20:00:00.000Z",
        durationHours: 24,
      },
      profile: {
        users: 50,
        browserSockets: 100,
        representativeMail: true,
        driveMaximumObjectBytes: 1_073_741_824,
        concurrentMcpReads: 10,
        pendingAgentWrites: 5,
      },
      objectives: {
        availabilityPercent: 99.9,
        apiReadP95Ms: 400,
        apiMetadataWriteP95Ms: 600,
        chatVisibleP95Ms: 1_500,
        mailAcceptanceP95Ms: 50_000,
      },
      noUnboundedMemoryGrowth: true,
      stuckJobs: 0,
      telemetry: {
        p99LatencyMs: 2_500,
        errorRatePercent: 0.1,
        memoryGrowthBytes: 1_024,
        eventLoopLagP99Ms: 50,
        dbPoolPendingPeak: 1,
        redisBacklogPeak: 0,
        natsBacklogPeak: 0,
        queueAgeP95Ms: 100,
        scanConcurrencyPeak: 4,
      },
      report: soakReport,
    },
    "security-review-evidence.json": {
      schema: FINAL_ARTIFACT_SCHEMAS.securityReview,
      generatedAt: reportAt,
      releaseBinding: binding,
      status: "passed",
      threatModel,
      repositoryScan: check(repositoryScan),
      dependencyAudit: check(dependencyAudit),
      sensitiveDataScan: {
        ...check(sensitiveDataScan),
        scope: "repository-and-release-packet",
      },
      containerScans,
      sboms,
      manualReview: check(manualReview),
      findings: [
        {
          findingIdHash: `sha256:${"f".repeat(64)}`,
          severity: "medium",
          disposition: "accepted",
          owner: "security-owner@example.invalid",
          expiresAt: "2027-07-28T20:00:00.000Z",
          artifact: findingDisposition,
        },
      ],
    },
    "support-readiness-evidence.json": {
      schema: FINAL_ARTIFACT_SCHEMAS.supportReadiness,
      generatedAt: reportAt,
      releaseBinding: binding,
      status: "passed",
      supportOwner: "support-owner@example.invalid",
      incidentOwner: "incident-owner@example.invalid",
      humanRotationAssigned: true,
      runbookIndex,
      limitations,
      dogfood: {
        status: "passed",
        startedAt: "2026-06-10T00:00:00.000Z",
        completedAt: "2026-06-24T00:00:00.000Z",
        durationDays: 14,
        observations: dogfoodObservations,
        exitReview: dogfoodExit,
      },
      privatePilot: {
        status: "passed",
        startedAt: "2026-06-25T00:00:00.000Z",
        completedAt: "2026-07-23T00:00:00.000Z",
        durationDays: 28,
        observations: pilotObservations,
        exitReview: pilotExit,
        independentSecurityReview: independentReview,
      },
      incidentHistory: {
        startedAt: "2026-06-10T00:00:00.000Z",
        completedAt: "2026-07-28T00:00:00.000Z",
        incidentCount: 2,
        openSev1: 0,
        openSev2: 0,
        dataLossEvents: 0,
        crossTenantEvents: 0,
        malwareBypassEvents: 0,
        silentMailLossEvents: 0,
        unapprovedAgentWriteEvents: 0,
      },
    },
    "business-readiness-evidence.json": {
      schema: FINAL_ARTIFACT_SCHEMAS.businessReadiness,
      generatedAt: reportAt,
      releaseBinding: binding,
      status: "passed",
      currency: "USD",
      monthlyEstimate: 500,
      perUserEstimate: 10,
      model: costModel,
      limits: {
        organizations: 1,
        minimumUsers: 5,
        maximumUsers: 50,
        managedOutboundProvider: true,
        directMx: false,
        regulatedData: false,
        agentWritesConfirmedByDefault: true,
        nativeEditorsEnabled: false,
      },
      risks: [
        {
          riskId: "RISK-1",
          summary: "Pilot availability remains below enterprise tier",
          status: "accepted",
          owner: "release-owner@example.invalid",
          expiresAt: "2027-07-28T20:00:00.000Z",
          mitigation: riskMitigation,
        },
      ],
    },
    "protected-repository-state-evidence.json": createProtectedRepositoryStateEvidence(
      fixture,
      binding,
      reportAt,
    ),
  };
  await Promise.all(
    Object.entries(reports).map(([name, report]) =>
      writeFile(resolve(fixture.evidence, name), `${JSON.stringify(report)}\n`, "utf8"),
    ),
  );
  const decisionInputs = (await listRelativeFiles(fixture.evidence)).filter(
    (path) => path !== "production-decision-evidence.json",
  );
  const entries = await Promise.all(
    decisionInputs.map(async (path) => ({
      path,
      sha256: `sha256:${createHash("sha256")
        .update(await readFile(resolve(fixture.evidence, path)))
        .digest("hex")}`,
    })),
  );
  const decision = {
    schema: FINAL_ARTIFACT_SCHEMAS.productionDecision,
    generatedAt: "2026-07-29T23:45:00.000Z",
    releaseBinding: binding,
    decision: "go",
    decidedAt: "2026-07-29T23:45:00.000Z",
    owner: "release-owner@example.invalid",
    rationale: "All R0 through R3 evidence was reviewed and satisfies the approved launch limits.",
    conditions: [],
    evidenceSetSha256: evidenceSetDigest(entries),
  };
  const publicKey = fixture.decisionPublicKey;
  const signerFingerprint = `sha256:${createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  decision.signature = {
    algorithm: "Ed25519",
    signer: "release-board@example.invalid",
    signerFingerprint,
  };
  decision.signature.value = sign(
    null,
    Buffer.from(canonicalJson(decision)),
    fixture.decisionPrivateKey,
  ).toString("base64");
  await writeFile(
    resolve(fixture.evidence, "production-decision-evidence.json"),
    `${JSON.stringify(decision)}\n`,
    "utf8",
  );
}

async function mutateReferencedArtifact(fixture, reportName, selectReference, mutateDocument) {
  const reportPath = resolve(fixture.evidence, reportName);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const reference = selectReference(report);
  const artifactPath = resolve(fixture.evidence, reference.path);
  const document = JSON.parse(await readFile(artifactPath, "utf8"));
  mutateDocument(document);
  const content = `${JSON.stringify(document)}\n`;
  await writeFile(artifactPath, content, "utf8");
  reference.sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  await writeFile(reportPath, `${JSON.stringify(report)}\n`, "utf8");
}

async function mutateImageProvenance(fixture, imageName, mutateDocument) {
  return mutateReferencedArtifact(
    fixture,
    "production-config-evidence.json",
    (report) => report.imageProvenance[imageName],
    mutateDocument,
  );
}

async function substituteSpdxArtifact(fixture, targetImage, sourceImage) {
  const reportPath = resolve(fixture.evidence, "security-review-evidence.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const targetReference = report.sboms[targetImage].artifact;
  const sourceReference = report.sboms[sourceImage].artifact;
  const targetPath = resolve(fixture.evidence, targetReference.path);
  const targetSummary = JSON.parse(await readFile(targetPath, "utf8"));
  const sourceSummary = JSON.parse(
    await readFile(resolve(fixture.evidence, sourceReference.path), "utf8"),
  );
  targetSummary.spdxArtifact = sourceSummary.spdxArtifact;
  targetSummary.documentSha256 = sourceSummary.documentSha256;
  const content = `${JSON.stringify(targetSummary)}\n`;
  await writeFile(targetPath, content, "utf8");
  targetReference.sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  await writeFile(reportPath, `${JSON.stringify(report)}\n`, "utf8");
}

async function mutateSpdxArtifact(fixture, imageName, mutateDocument) {
  const reportPath = resolve(fixture.evidence, "security-review-evidence.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const summaryReference = report.sboms[imageName].artifact;
  const summaryPath = resolve(fixture.evidence, summaryReference.path);
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  const spdxPath = resolve(fixture.evidence, summary.spdxArtifact.path);
  const spdx = JSON.parse(await readFile(spdxPath, "utf8"));
  mutateDocument(spdx);
  const spdxContent = `${JSON.stringify(spdx)}\n`;
  await writeFile(spdxPath, spdxContent, "utf8");
  summary.spdxArtifact.sha256 = `sha256:${createHash("sha256").update(spdxContent).digest("hex")}`;
  summary.documentSha256 = summary.spdxArtifact.sha256;
  const summaryContent = `${JSON.stringify(summary)}\n`;
  await writeFile(summaryPath, summaryContent, "utf8");
  summaryReference.sha256 = `sha256:${createHash("sha256").update(summaryContent).digest("hex")}`;
  await writeFile(reportPath, `${JSON.stringify(report)}\n`, "utf8");
}

function resignProvenancePayload(fixture, document, statement) {
  const payload = Buffer.from(JSON.stringify(statement));
  document.bundle.dsseEnvelope.payload = payload.toString("base64");
  document.bundle.dsseEnvelope.signatures[0].sig = sign(
    "sha256",
    testDssePreAuthEncoding(document.bundle.dsseEnvelope.payloadType, payload),
    fixture.fulcioLeafPrivateKey,
  ).toString("base64");
  document.bundle.verificationMaterial.tlogEntries = [
    createTestRekorEntry(fixture, document.bundle.dsseEnvelope, payload),
  ];
}

function createSpdxDocument(imageSubject, imageDigest) {
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `${imageSubject}@${imageDigest}`,
    documentNamespace: `https://helix.billiondollarsolo.com/spdx/${imageDigest.slice("sha256:".length)}`,
    creationInfo: {
      created: "2026-07-29T21:00:00.000Z",
      creators: ["Tool: syft-1.30.0"],
    },
    documentDescribes: ["SPDXRef-ContainerImage"],
    packages: [
      {
        SPDXID: "SPDXRef-ContainerImage",
        name: imageSubject,
        versionInfo: imageDigest,
        primaryPackagePurpose: "CONTAINER",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        checksums: [
          {
            algorithm: "SHA256",
            checksumValue: imageDigest.slice("sha256:".length),
          },
        ],
      },
    ],
  };
}

function retainedArtifactDocument(schema, label, overrides) {
  if ([ARTIFACT_SCHEMAS.imageProvenance, ARTIFACT_SCHEMAS.spdxDocument].includes(schema)) {
    return overrides.document;
  }
  const completedAt = overrides.completedAt ?? "2026-07-29T21:00:00.000Z";
  if (schema === ARTIFACT_SCHEMAS.commandReport) {
    return {
      schema,
      status: "passed",
      command: overrides.command,
      revision: overrides.revision,
      completedAt,
      exitCode: 0,
    };
  }
  if (schema === ARTIFACT_SCHEMAS.containerScan) {
    return {
      schema,
      status: "passed",
      completedAt,
      imageDigest: overrides.imageDigest,
      scanner: "trivy",
      critical: 0,
      high: 0,
    };
  }
  if (schema === ARTIFACT_SCHEMAS.sbom) {
    return {
      schema,
      status: "passed",
      completedAt,
      imageDigest: overrides.imageDigest,
      imageSubject: overrides.imageSubject,
      format: "spdx-json",
      packageCount: 1,
      documentSha256: overrides.spdxArtifact.sha256,
      spdxArtifact: overrides.spdxArtifact,
    };
  }
  if (
    [
      ARTIFACT_SCHEMAS.repositoryScan,
      ARTIFACT_SCHEMAS.dependencyAudit,
      ARTIFACT_SCHEMAS.manualReview,
    ].includes(schema)
  ) {
    return { schema, status: "passed", completedAt, critical: 0, high: 0, medium: 0, low: 0 };
  }
  if (schema === ARTIFACT_SCHEMAS.sensitiveDataScan) {
    return {
      schema,
      status: "passed",
      completedAt,
      scope: overrides.scope,
      matchCount: 0,
    };
  }
  if (schema === ARTIFACT_SCHEMAS.findingDisposition) {
    return {
      schema,
      status: "passed",
      completedAt,
      findingIdHash: overrides.findingIdHash,
      disposition: overrides.disposition,
      owner: overrides.owner,
    };
  }
  return {
    schema,
    status: overrides.status ?? "passed",
    completedAt,
    owner: `${label}-owner@example.invalid`,
    releaseBinding: overrides.releaseBinding,
    role: overrides.role,
    ...(overrides.phase === undefined ? {} : { phase: overrides.phase }),
    ...(overrides.riskId === undefined ? {} : { riskId: overrides.riskId }),
  };
}

function createSigstoreProvenanceArtifact(fixture, binding, subjectName, subjectDigest) {
  const payload = Buffer.from(
    JSON.stringify({
      _type: "https://in-toto.io/Statement/v1",
      subject: [
        {
          name: subjectName,
          digest: { sha256: subjectDigest.slice("sha256:".length) },
        },
      ],
      predicateType: "https://helix.billiondollarsolo.com/attestations/paired-source/v1",
      predicate: {
        schemaVersion: 1,
        workspace: {
          repository: `https://github.com/${WORKSPACE_REPOSITORY}`,
          sha: binding.workspaceSha,
        },
        editors: {
          repository: `https://github.com/${EDITORS_REPOSITORY}`,
          sha: binding.editorsSha,
        },
      },
    }),
  );
  const payloadType = "application/vnd.in-toto+json";
  const signature = sign(
    "sha256",
    testDssePreAuthEncoding(payloadType, payload),
    fixture.fulcioLeafPrivateKey,
  );
  const dsseEnvelope = {
    payload: payload.toString("base64"),
    payloadType,
    signatures: [{ sig: signature.toString("base64") }],
  };
  return {
    schema: ARTIFACT_SCHEMAS.imageProvenance,
    generatedAt: "2026-07-29T21:00:00.000Z",
    subjectName,
    subjectDigest,
    bundle: {
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {
        certificate: { rawBytes: fixture.fulcioLeafRaw.toString("base64") },
        tlogEntries: [createTestRekorEntry(fixture, dsseEnvelope, payload)],
        timestampVerificationData: {},
      },
      dsseEnvelope,
    },
  };
}

function createTestRekorEntry(fixture, envelope, payload, options = {}) {
  const logIndex = 0;
  const treeSize = 1;
  const integratedTime = Math.floor(
    Date.parse(options.integratedAt ?? "2026-07-29T21:00:00.000Z") / 1_000,
  );
  const canonicalizedBody = Buffer.from(
    JSON.stringify({
      apiVersion: "0.0.1",
      kind: "dsse",
      spec: {
        envelopeHash: {
          algorithm: "sha256",
          value: createHash("sha256").update(JSON.stringify(envelope)).digest("hex"),
        },
        payloadHash: {
          algorithm: "sha256",
          value: createHash("sha256").update(payload).digest("hex"),
        },
        signatures: [
          {
            signature: envelope.signatures[0].sig,
            verifier: Buffer.from(fixture.fulcioLeafPem).toString("base64"),
          },
        ],
      },
    }),
  );
  const canonicalizedBodyBase64 = canonicalizedBody.toString("base64");
  const logId = fixture.rekorLogId.slice("sha256:".length);
  const signedEntryTimestamp = sign(
    "sha256",
    Buffer.from(
      JSON.stringify({
        body: canonicalizedBodyBase64,
        integratedTime,
        logID: logId,
        logIndex,
      }),
    ),
    fixture.rekorPrivateKey,
  );
  const rootHash = createHash("sha256")
    .update(Buffer.concat([Buffer.from([0]), canonicalizedBody]))
    .digest();
  const signedCheckpoint = `${fixture.rekorCheckpointOrigin}\n${String(treeSize)}\n${rootHash.toString("base64")}\n`;
  const noteSignature = Buffer.concat([
    Buffer.from(logId, "hex").subarray(0, 4),
    sign("sha256", Buffer.from(signedCheckpoint), fixture.rekorPrivateKey),
  ]);
  return {
    logIndex: String(logIndex),
    logId: { keyId: Buffer.from(logId, "hex").toString("base64") },
    kindVersion: { kind: "dsse", version: "0.0.1" },
    integratedTime: String(integratedTime),
    inclusionPromise: { signedEntryTimestamp: signedEntryTimestamp.toString("base64") },
    inclusionProof: {
      logIndex: String(logIndex),
      rootHash: rootHash.toString("base64"),
      treeSize: String(treeSize),
      hashes: [],
      checkpoint: {
        envelope: `${signedCheckpoint}\n— rekor.test.invalid ${noteSignature.toString("base64")}\n`,
      },
    },
    canonicalizedBody: canonicalizedBodyBase64,
  };
}

function testDssePreAuthEncoding(payloadType, payload) {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType)} ${payloadType} ${payload.byteLength} `),
    payload,
  ]);
}

function createProtectedRepositoryStateEvidence(fixture, binding) {
  const generatedAt = "2026-07-29T23:30:00.000Z";
  const report = {
    schema: FINAL_ARTIFACT_SCHEMAS.protectedRepositoryState,
    generatedAt,
    releaseBinding: binding,
    status: "passed",
    observedAt: generatedAt,
    repositories: {
      workspace: {
        repository: WORKSPACE_REPOSITORY,
        branch: "main",
        branchSha: binding.workspaceSha,
        tag: "release-fixture",
        tagSha: binding.workspaceSha,
      },
      editors: {
        repository: EDITORS_REPOSITORY,
        branch: "main",
        branchSha: binding.editorsSha,
        tag: "release-fixture",
        tagSha: binding.editorsSha,
      },
    },
    signature: {
      algorithm: "Ed25519",
      signer: "protected-git-state-verifier@example.invalid",
      signerFingerprint: fixture.gitStateSignerFingerprint,
    },
  };
  signProtectedRepositoryState(fixture, report);
  return report;
}

function signProtectedRepositoryState(fixture, report) {
  delete report.signature.value;
  report.signature.value = sign(
    null,
    Buffer.from(canonicalJson(report)),
    fixture.gitStatePrivateKey,
  ).toString("base64");
}

function passedMailEvidence() {
  const evidence = createEvidenceSkeleton(new Date("2026-07-28T20:00:00.000Z"));
  evidence.mode = "local";
  evidence.status = "passed";
  for (const scenario of MAIL_LIVE_SCENARIOS) {
    evidence.local[scenario] = passedLocalResult(scenario);
  }
  evidence.external.provider_sandbox = {
    status: "passed",
    provider: "approved-sandbox",
    events: [
      { type: "hard_bounce", eventIdHash: "a".repeat(20), suppressed: true },
      { type: "complaint", eventIdHash: "b".repeat(20), suppressed: true },
    ],
  };
  evidence.external.gmail = passedExternalMail("gmail.com", "c");
  evidence.external.microsoft365 = passedExternalMail("outlook.com", "d");
  return evidence;
}

function passedExternalMail(recipientDomain, hashCharacter) {
  return {
    status: "passed",
    provider: "approved-sandbox",
    recipientDomain,
    messageIdHash: hashCharacter.repeat(20),
    latencyMs: 100,
    placement: "inbox",
    finalStatus: "delivered",
    authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
  };
}

function passedAgentEvidence() {
  const evidence = createAgentEvidenceSkeleton(new Date("2026-07-28T20:00:00.000Z"));
  evidence.mode = "live";
  evidence.status = "passed";
  for (const scenario of AGENT_LIVE_SCENARIOS) {
    evidence.scenarios[scenario] = passedAgentResult(scenario);
  }
  return evidence;
}

function passedDriveEvidence() {
  const startedAt = "2026-07-28T20:00:00.000Z";
  const completedAt = "2026-07-28T20:00:01.000Z";
  const metrics = driveMetrics();
  return {
    schemaVersion: DRIVE_EVIDENCE_SCHEMA_VERSION,
    generatedAt: completedAt,
    mode: "live",
    status: "passed",
    startedAt,
    completedAt,
    durationMs: 1_000,
    cases: DRIVE_EVIDENCE_CASES.map((name) => ({
      name,
      status: "pass",
      startedAt,
      completedAt,
      durationMs: 1_000,
      metrics: metrics[name],
      evidence: [{ source: "metric", ref: `drive/${name}`, observedAt: completedAt }],
    })),
  };
}

function driveMetrics() {
  return {
    clean_upload_hash: { uploadBytes: 12, scanLatencyMs: 10, hashMatched: true },
    eicar_denied: {
      retrievalSurfacesChecked: 4,
      deniedSurfaces: 4,
      scanLatencyMs: 12,
    },
    multipart_sse: {
      uploadBytes: 12,
      partCount: 2,
      serverSideEncryptionVerified: true,
    },
    gib_bounded_memory: {
      uploadBytes: 1024 ** 3,
      peakRssGrowthBytes: 1_024,
      memoryBoundBytes: 2_048,
      withinMemoryBound: true,
    },
    webdav_quarantine: {
      retrievalSurfacesChecked: 3,
      deniedSurfaces: 3,
      lockCycleVerified: true,
    },
    share_revoke: {
      revokeLatencyMs: 5,
      revokedAccessDenied: true,
      expirationVerified: true,
    },
    restart_recovery: { restartsObserved: 3, recoveryMs: 20, hashMatched: true },
    backup_restore: { restoredFiles: 2, restoredVersions: 3, hashMatched: true },
  };
}

function passedDataPlaneEvidence() {
  const evidence = createDataPlaneEvidenceSkeleton(new Date("2026-07-28T20:00:00.000Z"));
  evidence.mode = "local";
  evidence.status = "passed";
  evidence.completedAt = "2026-07-28T20:00:01.000Z";
  for (const scenario of DATA_PLANE_SCENARIOS) {
    evidence.scenarios[scenario] = { status: "passed", durationMs: 1 };
  }
  return evidence;
}

function passedFailureRecoveryEvidence() {
  const report = createLiveFailureRecoveryEvidence({
    environmentId: "disposable-v4-release-manifest",
    startedAt: new Date("2026-07-28T20:00:00.000Z"),
  });
  for (const contract of FAILURE_RECOVERY_SCENARIOS) {
    report.scenarios[contract.id] = passedFailureRecoveryObservation(contract);
  }
  return finalizeFailureRecoveryEvidence(report, new Date("2026-07-28T20:03:00.000Z"));
}

function passedDastEvidence(releaseBinding) {
  return buildDastEvidence({
    started: new Date("2026-07-28T20:00:00.000Z"),
    completed: new Date("2026-07-28T20:15:00.000Z"),
    timeoutSeconds: 900,
    target: {
      kind: "https",
      originSha256: `sha256:${"f".repeat(64)}`,
    },
    execution: { outcome: "completed", exitCode: 0, reportParsed: true },
    findings: [],
    dispositions: [],
    binding: releaseBinding,
  });
}

function passedFailureRecoveryObservation(contract) {
  const startedAt = "2026-07-28T20:00:00.000Z";
  const faultInjectedAt = "2026-07-28T20:01:00.000Z";
  const recoveredAt = "2026-07-28T20:02:00.000Z";
  const completedAt = "2026-07-28T20:03:00.000Z";
  const observed = (source, suffix) => ({
    source,
    observedAt: recoveredAt,
    ref: `v4/${contract.id}/${suffix}`,
  });
  return {
    schema: FAILURE_RECOVERY_OBSERVATION_SCHEMA,
    scenarioId: contract.id,
    status: "passed",
    startedAt,
    faultInjectedAt,
    recoveredAt,
    completedAt,
    faultInjection: {
      method: contract.faultMethod,
      count: contract.faultCount,
      observed: true,
    },
    assertions: {
      userBehavior: {
        status: "passed",
        code: contract.userBehavior,
        evidence: [observed("api", "user-behavior")],
      },
      noDuplicates: {
        status: "passed",
        code: contract.noDuplicates,
        logicalOperationCount: contract.minLogicalOperations,
        attemptCount: contract.minLogicalOperations + contract.faultCount,
        sideEffectCount: ["audit_destination_failure", "provider_agent_credential_expiry"].includes(
          contract.id,
        )
          ? 0
          : contract.minLogicalOperations,
        distinctIdempotencyKeyCount: contract.minLogicalOperations,
        duplicateCount: 0,
        evidence: [observed("database", "dedupe-query")],
      },
      alert: {
        status: "passed",
        rules: [...contract.alerts],
        firedAt: recoveredAt,
        resourceId: `scenario:${contract.id}`,
        evidence: [observed("alertmanager", "alert")],
      },
      recovery: {
        status: "passed",
        code: contract.recovery,
        healthy: true,
        evidence: [observed("metric", "recovery")],
      },
    },
  };
}

function passedChatEvidence() {
  const timestamp = "2026-07-28T20:00:00.000Z";
  const hash = "a".repeat(24);
  const secondHash = "b".repeat(24);
  const evidence = createChatEvidenceSkeleton(new Date(timestamp));
  evidence.mode = "live";
  evidence.status = "passed";
  evidence.environment = {
    replicaCount: 2,
    transport: "wss",
    tlsVerified: true,
    replicaHashes: [hash, secondHash],
  };
  evidence.scenarios = {
    authenticated_browser_fanout: passedChatScenario(timestamp, {
      twoAuthenticatedBrowserContexts: true,
      bidirectionalMessagesObserved: true,
      realWebSockets: true,
      roomHash: hash,
      messagesObserved: 2,
    }),
    non_member_denials: passedChatScenario(timestamp, {
      roomAbsentFromList: true,
      restListDenied: true,
      restSearchDenied: true,
      restSendDenied: true,
      websocketSubscribeDenied: true,
      websocketSendDenied: true,
    }),
    multi_replica_nats_fanout: passedChatScenario(timestamp, {
      distinctReplicaEndpoints: 2,
      replicaAToB: true,
      replicaBToA: true,
      replicaAHash: hash,
      replicaBHash: secondHash,
    }),
    app_restart_reconnect_durability: passedChatRestart(timestamp),
    redis_restart_reconnect_durability: passedChatRestart(timestamp),
    nats_restart_reconnect_durability: passedChatRestart(timestamp),
    clean_drive_attachment: passedChatScenario(timestamp, {
      driveStateActive: true,
      chatMessageObserved: true,
      objectHash: hash,
      messageHash: hash,
    }),
    eicar_drive_attachment_denied: passedChatScenario(timestamp, {
      driveStateQuarantined: true,
      chatSendDenied: true,
      messageNotObserved: true,
      objectHash: hash,
    }),
    invalid_origin_and_token_leakage: passedChatScenario(timestamp, {
      invalidOriginDenied: true,
      invalidOriginCloseCode: 4403,
      browserSocketUrlsClean: true,
      browserNetworkUrlsClean: true,
      authFailureResponseRedacted: true,
      applicationLogsRedacted: true,
      logLinesInspected: 10,
    }),
    pilot_load: passedChatScenario(timestamp, {
      actualUsers: 50,
      actualSockets: 100,
      durationSeconds: 1_800,
      messagesAttempted: 1_800,
      messagesObserved: 1_800,
      errors: 0,
      errorRate: 0,
      p95LatencyMs: 100,
      p99LatencyMs: 200,
      memoryStartBytes: 100,
      memoryPeakBytes: 120,
      memoryEndBytes: 110,
      memoryGrowthBytes: 10,
      eventLoopLagPeakMs: 10,
      dbPoolPendingPeak: 0,
      redisBacklogPeak: 0,
      natsBacklogPeak: 0,
      steadyTrafficObserved: true,
      burstTrafficObserved: true,
      noUnboundedMemoryGrowth: true,
      backlogsWithinLimits: true,
    }),
  };
  return evidence;
}

function passedChatRestart(timestamp) {
  return passedChatScenario(timestamp, {
    restartHookSucceeded: true,
    dependencyIdentityChanged: true,
    reconnectsObserved: 2,
    preRestartMessageDurable: true,
    postRestartFanoutObserved: true,
    recoveryMs: 250,
  });
}

function passedChatScenario(timestamp, evidence) {
  return {
    status: "passed",
    startedAt: timestamp,
    completedAt: timestamp,
    evidence,
  };
}

function passedRestoreEvidence() {
  const hash = "a".repeat(64);
  return {
    schema: RESTORE_DRILL_EVIDENCE_SCHEMA,
    runId: "restore-test",
    mode: "live",
    status: "passed",
    startedAt: "2026-07-28T20:00:00.000Z",
    completedAt: "2026-07-28T21:30:00.000Z",
    metrics: { rpoHours: 23, rtoHours: 1.5, rpoTargetHours: 24, rtoTargetHours: 4 },
    scenarios: {
      manifest_integrity: {
        status: "passed",
        manifestSha256: hash,
        recoverySetHash: hash,
      },
      encrypted_restore: {
        status: "passed",
        method: "age",
        plaintextKeyMaterialObserved: false,
      },
      off_host_retention_key_custody: {
        status: "passed",
        offHostCopyRecorded: true,
        retentionDays: 35,
        keyCustodyReferenceRecorded: true,
        plaintextKeyMaterialObserved: false,
      },
      disposable_environment: {
        status: "passed",
        databaseIsolated: true,
        objectStoreIsolated: true,
      },
      database_consistency: {
        status: "passed",
        expectedSnapshotSha256: hash,
        exactMatch: true,
      },
      object_version_consistency: {
        status: "passed",
        versionInventorySha256: hash,
        isolatedRestore: true,
      },
      outbound_queue_consistency: { status: "passed", exactMatch: true },
      audit_chain: { status: "passed", invalidLinks: 0 },
      sampled_corpus_hashes: { status: "passed", sampleCount: 2, matchingCount: 2 },
      search_reindex: { status: "passed", rebuiltFromRestoredDatabase: true },
      rpo: { status: "passed", observedHours: 23, targetHours: 24 },
      rto: { status: "passed", observedHours: 1.5, targetHours: 4 },
    },
  };
}

function passedAgentResult(scenario) {
  const hash = "a".repeat(20);
  const resources = Object.fromEntries(
    ["mail", "drive", "chat"].map((kind) => [kind, { resourceHash: hash, byteSize: 10 }]),
  );
  switch (scenario) {
    case "oauth_least_privilege":
      return {
        status: "passed",
        grant: "client_credentials",
        exactScopes: true,
        scopes: ["mail.read", "drive.read", "chat.read", "chat.post"],
        clientHash: hash,
      };
    case "mcp_permitted_resources":
      return { status: "passed", listedCount: 3, reads: resources };
    case "mcp_forbidden_resources":
      return {
        status: "passed",
        allDenied: true,
        guesses: [1, 2, 3].map(() => ({ resourceHash: hash, errorCode: -32004 })),
      };
    case "chat_send_approval_once":
      return {
        status: "passed",
        pendingHash: hash,
        markerHash: hash,
        separateHumanApproval: true,
        duplicateApprovalDenied: true,
        observedMessageCount: 1,
      };
    case "mail_send_denied":
      return {
        status: "passed",
        absentFromEnumeration: true,
        directCallDenied: true,
        outboundQueueRecordsCreated: 0,
        errorCode: -32003,
      };
    case "prompt_injection_resistance":
      return {
        status: "passed",
        fixtures: Object.fromEntries(
          ["mail", "drive", "chat"].map((kind) => [
            kind,
            { fixtureHash: hash, fixtureBytes: 10, forbiddenMutationDenied: true },
          ]),
        ),
        toolVisibilityUnchanged: true,
        forbiddenMutationDenied: true,
      };
    case "credential_revoked_pending_action":
      return {
        status: "passed",
        pendingHash: hash,
        clientHash: hash,
        revokeExecuted: true,
        approvalDenied: true,
        errorStatus: 403,
      };
    case "audit_correlation_redaction":
      return {
        status: "passed",
        recordCount: 4,
        records: [1, 2, 3, 4].map(() => ({
          recordHash: hash,
          verb: "tool.invocation.denied",
          objectType: "tool_invocation",
          traceHash: hash,
        })),
        contentLeakageObserved: false,
        pendingActionsCorrelated: true,
        requiredVerbsObserved: [
          "tool.invocation.pending",
          "tool.invocation.executed",
          "tool.invocation.denied",
          "agent.credential.revoked",
        ],
      };
    default:
      throw new Error(`unknown Agent scenario ${scenario}`);
  }
}

function passedLocalResult(scenario) {
  const hash = "a".repeat(20);
  const recipient = { domain: "example.test", addressHash: hash };
  switch (scenario) {
    case "recipient_aware_routing":
      return {
        status: "passed",
        markerHash: hash,
        orgA: { ...recipient, messageIdHash: hash },
        orgB: { ...recipient, messageIdHash: hash },
        tenantRecipientIsolation: true,
      };
    case "clean_inbound":
      return {
        status: "passed",
        acceptedAt: "2026-07-28T20:00:00.000Z",
        messageIdHashes: [hash, hash],
      };
    case "spam_inbound":
      return { status: "passed", messageIdHash: hash, folder: "spam" };
    case "eicar_quarantine":
      return {
        status: "passed",
        quarantineIdHash: hash,
        reasons: ["malware"],
        rawMessageExposed: false,
      };
    case "outbound_mailpit":
      return {
        status: "passed",
        recipient,
        outboundIdHash: hash,
        providerMessageIdHash: hash,
        mailpitMessageIdHash: hash,
        latencyMs: 10,
      };
    case "provider_hard_bounce":
      return {
        status: "passed",
        recipient,
        eventIdHash: hash,
        duplicateIdempotent: true,
      };
    case "provider_complaint":
      return { status: "passed", recipient, eventIdHash: hash };
    case "suppression":
      return {
        status: "passed",
        outboundIdHash: hash,
        operatorCode: "MAIL_RECIPIENT_SUPPRESSED",
      };
    case "deterministic_retry":
      return {
        status: "passed",
        outboundIdHash: hash,
        preservedIdentity: true,
        finalStatus: "failed",
        operatorCode: "MAIL_RECIPIENT_SUPPRESSED",
      };
    default:
      throw new Error(`unknown scenario ${scenario}`);
  }
}

async function createFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "helix-release-manifest-"));
  const workspace = resolve(root, "helix-workspace");
  const editors = resolve(root, "helix-editors");
  const evidence = resolve(root, "evidence");
  await Promise.all([
    initRepository(workspace, {
      "apps/helix/src/db/migrations/0001_first.sql": "select 1;\n",
      "apps/helix/src/db/migrations/0002_second.sql": "select 2;\n",
    }),
    initRepository(editors, { "README.md": "editors\n" }),
    mkdir(resolve(evidence, "tests"), { recursive: true }),
  ]);
  await writeFile(resolve(evidence, "tests/unit.json"), '{"ok":true}\n', "utf8");
  const { publicKey: decisionPublicKey, privateKey: decisionPrivateKey } =
    generateKeyPairSync("ed25519");
  const decisionPublicKeyPath = resolve(root, "decision-public.pem");
  await writeFile(
    decisionPublicKeyPath,
    decisionPublicKey.export({ type: "spki", format: "pem" }),
    "utf8",
  );
  const decisionSignerFingerprint = `sha256:${createHash("sha256")
    .update(decisionPublicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  const editorsSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: editors,
    encoding: "utf8",
  }).trim();
  const workspaceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  }).trim();
  const { publicKey: gitStatePublicKey, privateKey: gitStatePrivateKey } =
    generateKeyPairSync("ed25519");
  const gitStatePublicKeyPath = resolve(root, "git-state-public.pem");
  await writeFile(
    gitStatePublicKeyPath,
    gitStatePublicKey.export({ type: "spki", format: "pem" }),
    "utf8",
  );
  const gitStateSignerFingerprint = `sha256:${createHash("sha256")
    .update(gitStatePublicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  const { publicKey: rekorPublicKey, privateKey: rekorPrivateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const rekorPublicKeyPath = resolve(root, "rekor-public.pem");
  await writeFile(
    rekorPublicKeyPath,
    rekorPublicKey.export({ type: "spki", format: "pem" }),
    "utf8",
  );
  const rekorLogId = `sha256:${createHash("sha256")
    .update(rekorPublicKey.export({ type: "spki", format: "der" }))
    .digest("hex")}`;
  const fulcio = await createTestFulcioCertificate(root, workspaceSha);
  return {
    root,
    workspace,
    editors,
    evidence,
    decisionPublicKey,
    decisionPrivateKey,
    decisionPublicKeyPath,
    decisionSignerFingerprint,
    editorsSha,
    workspaceSha,
    gitStatePublicKey,
    gitStatePrivateKey,
    gitStatePublicKeyPath,
    gitStateSignerFingerprint,
    rekorPublicKey,
    rekorPrivateKey,
    rekorPublicKeyPath,
    rekorLogId,
    rekorCheckpointOrigin: "rekor.test.invalid - 1",
    ...fulcio,
  };
}

async function initRepository(directory, files) {
  await mkdir(directory, { recursive: true });
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "manifest-test@example.invalid"], {
    cwd: directory,
  });
  execFileSync("git", ["config", "user.name", "Manifest Test"], { cwd: directory });
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = resolve(directory, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  execFileSync("git", ["add", "."], { cwd: directory });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: directory });
  execFileSync("git", ["tag", "release-fixture"], { cwd: directory });
}

async function createTestFulcioCertificate(root, workspaceSha) {
  const caKeyPath = resolve(root, "fulcio-ca.key");
  const caCertificatePath = resolve(root, "fulcio-ca.pem");
  const leafKeyPath = resolve(root, "fulcio-leaf.key");
  const leafRequestPath = resolve(root, "fulcio-leaf.csr");
  const leafCertificatePath = resolve(root, "fulcio-leaf.pem");
  const leafDerPath = resolve(root, "fulcio-leaf.der");
  const extensionPath = resolve(root, "fulcio-extensions.cnf");
  await writeFile(
    extensionPath,
    `[req]
prompt = no
distinguished_name = dn
req_extensions = extensions
[dn]
CN = github-actions-test
[extensions]
subjectAltName = URI:${WORKFLOW_IDENTITY}
1.3.6.1.4.1.57264.1.1 = ASN1:UTF8String:https://token.actions.githubusercontent.com
1.3.6.1.4.1.57264.1.3 = ASN1:UTF8String:${workspaceSha}
1.3.6.1.4.1.57264.1.5 = ASN1:UTF8String:${WORKSPACE_REPOSITORY}
1.3.6.1.4.1.57264.1.6 = ASN1:UTF8String:${SOURCE_REF}
`,
    "utf8",
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKeyPath,
      "-out",
      caCertificatePath,
      "-days",
      "7",
      "-subj",
      "/CN=Helix Test Fulcio Issuer",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-new",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      leafKeyPath,
      "-out",
      leafRequestPath,
      "-config",
      extensionPath,
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      leafRequestPath,
      "-CA",
      caCertificatePath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-out",
      leafCertificatePath,
      "-days",
      "7",
      "-extfile",
      extensionPath,
      "-extensions",
      "extensions",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    ["x509", "-in", leafCertificatePath, "-outform", "DER", "-out", leafDerPath],
    { stdio: "ignore" },
  );
  return {
    fulcioIssuerCertificatePath: caCertificatePath,
    fulcioLeafCertificatePath: leafCertificatePath,
    fulcioLeafRaw: await readFile(leafDerPath),
    fulcioLeafPem: await readFile(leafCertificatePath, "utf8"),
    fulcioLeafPrivateKey: createPrivateKey(await readFile(leafKeyPath, "utf8")),
  };
}
