import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildReleaseReadinessManifest,
  parseArgs,
  redactSensitive,
} from "./release-readiness-manifest.mjs";
import { MAIL_LIVE_SCENARIOS, createEvidenceSkeleton } from "./mail-live-evidence-smoke.mjs";
import { AGENT_LIVE_SCENARIOS, createAgentEvidenceSkeleton } from "./agent-live-evidence-smoke.mjs";
import {
  RESTORE_DRILL_EVIDENCE_SCHEMA,
  createStaticEvidence as createStaticRestoreEvidence,
} from "./restore-drill-evidence.mjs";
import { CHAT_LIVE_SCENARIOS, createChatEvidenceSkeleton } from "./chat-live-evidence-contract.mjs";

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
});

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
  return { root, workspace, editors, evidence };
}

async function initRepository(directory, files) {
  await mkdir(directory, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: directory });
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
}
