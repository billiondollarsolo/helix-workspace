import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  CHAT_LIVE_EVIDENCE_SCHEMA,
  CHAT_LIVE_SCENARIOS,
  CHAT_RELEASE_LOAD_MINIMUMS,
  assertNoSensitiveChatEvidence,
  createChatEvidenceSkeleton,
  runChatLiveEvidence,
  validateChatLiveEvidence,
} from "./chat-live-evidence-smoke.mjs";

const execFileAsync = promisify(execFile);
const timestamp = "2026-07-28T12:00:00.000Z";
const hash = "a".repeat(24);
const secondHash = "b".repeat(24);

describe("Chat C6/V3 live evidence contract", () => {
  it("emits a complete, truthful not-run report when no live fixture was supplied", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["infra/scripts/chat-live-evidence-smoke.mjs"],
      { cwd: process.cwd() },
    );
    const evidence = validateChatLiveEvidence(JSON.parse(stdout));

    expect(evidence.schema).toBe(CHAT_LIVE_EVIDENCE_SCHEMA);
    expect(evidence.status).toBe("not_run");
    expect(Object.keys(evidence.scenarios)).toEqual(CHAT_LIVE_SCENARIOS);
    expect(Object.values(evidence.scenarios).every((result) => result.status === "not_run")).toBe(
      true,
    );
    expect(stdout).not.toMatch(/"status":\s*"passed"/u);
  });

  it("requires every named live assertion and two verified WSS replicas", () => {
    const evidence = passedEvidence();
    expect(() =>
      validateChatLiveEvidence(evidence, { requirePass: true, requireReleaseLoad: true }),
    ).not.toThrow();

    delete evidence.scenarios.non_member_denials;
    expect(() => validateChatLiveEvidence(evidence)).toThrow(
      "every required scenario exactly once",
    );

    const insecure = passedEvidence();
    insecure.environment.tlsVerified = false;
    expect(() => validateChatLiveEvidence(insecure)).toThrow("verified WSS transport");
  });

  it("fails closed on unevidenced pass claims and inconsistent aggregate status", () => {
    const evidence = createChatEvidenceSkeleton(new Date(timestamp));
    evidence.mode = "live";
    evidence.status = "passed";
    evidence.scenarios.authenticated_browser_fanout = {
      status: "passed",
      startedAt: timestamp,
      completedAt: timestamp,
      evidence: {},
    };
    expect(() => validateChatLiveEvidence(evidence)).toThrow(
      "authenticated_browser_fanout must be true",
    );

    const inconsistent = createChatEvidenceSkeleton(new Date(timestamp));
    inconsistent.status = "failed";
    expect(() => validateChatLiveEvidence(inconsistent)).toThrow("does not match scenario status");
  });

  it("enforces the release pilot profile and measured thresholds", () => {
    const tooSmall = passedEvidence();
    tooSmall.profile.users = CHAT_RELEASE_LOAD_MINIMUMS.users - 1;
    tooSmall.scenarios.pilot_load.evidence.actualUsers = CHAT_RELEASE_LOAD_MINIMUMS.users - 1;
    expect(() => validateChatLiveEvidence(tooSmall, { requireReleaseLoad: true })).toThrow(
      "at least 50 users",
    );

    const tooBrief = passedEvidence();
    tooBrief.profile.durationSeconds = CHAT_RELEASE_LOAD_MINIMUMS.durationSeconds - 1;
    tooBrief.scenarios.pilot_load.evidence.durationSeconds =
      CHAT_RELEASE_LOAD_MINIMUMS.durationSeconds - 1;
    expect(() => validateChatLiveEvidence(tooBrief, { requireReleaseLoad: true })).toThrow(
      "at least 1800 seconds",
    );

    const slow = passedEvidence();
    slow.scenarios.pilot_load.evidence.p95LatencyMs = CHAT_RELEASE_LOAD_MINIMUMS.p95LatencyMs + 1;
    expect(() => validateChatLiveEvidence(slow, { requireReleaseLoad: true })).toThrow(
      "p95 must be at most 2000 ms",
    );
  });

  it("rejects credentials and credential-shaped URLs from evidence", () => {
    for (const unsafe of [
      { accessToken: "value" },
      { nested: { sessionCookie: "value" } },
      { requestUrl: "https://chat.example/ws?access_token=value" },
      { message: "Authorization: Bearer value" },
    ]) {
      expect(() => assertNoSensitiveChatEvidence(unsafe)).toThrow("sensitive Chat evidence");
    }
  });

  it("makes --require-pass fail for static evidence", async () => {
    await expect(
      execFileAsync(
        process.execPath,
        ["infra/scripts/chat-live-evidence-smoke.mjs", "--require-pass"],
        { cwd: process.cwd() },
      ),
    ).rejects.toMatchObject({ code: 1 });
  });

  it("reports a missing protected live fixture as failed, never passed", async () => {
    const evidence = await runChatLiveEvidence(
      "/definitely-not-present/helix-chat-live-evidence.json",
    );
    expect(evidence.mode).toBe("live");
    expect(evidence.status).toBe("failed");
    expect(Object.values(evidence.scenarios).every((result) => result.status === "failed")).toBe(
      true,
    );
    expect(() => validateChatLiveEvidence(evidence)).not.toThrow();
    expect(() => validateChatLiveEvidence(evidence, { requirePass: true })).toThrow(
      "required Chat live evidence did not pass",
    );
  });
});

function passedEvidence() {
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
    authenticated_browser_fanout: passed({
      twoAuthenticatedBrowserContexts: true,
      bidirectionalMessagesObserved: true,
      realWebSockets: true,
      roomHash: hash,
      messagesObserved: 2,
    }),
    non_member_denials: passed({
      roomAbsentFromList: true,
      restListDenied: true,
      restSearchDenied: true,
      restSendDenied: true,
      websocketSubscribeDenied: true,
      websocketSendDenied: true,
    }),
    multi_replica_nats_fanout: passed({
      distinctReplicaEndpoints: 2,
      replicaAToB: true,
      replicaBToA: true,
      replicaAHash: hash,
      replicaBHash: secondHash,
    }),
    app_restart_reconnect_durability: restartResult(),
    redis_restart_reconnect_durability: restartResult(),
    nats_restart_reconnect_durability: restartResult(),
    clean_drive_attachment: passed({
      driveStateActive: true,
      chatMessageObserved: true,
      objectHash: hash,
      messageHash: hash,
    }),
    eicar_drive_attachment_denied: passed({
      driveStateQuarantined: true,
      chatSendDenied: true,
      messageNotObserved: true,
      objectHash: hash,
    }),
    invalid_origin_and_token_leakage: passed({
      invalidOriginDenied: true,
      invalidOriginCloseCode: 4403,
      browserSocketUrlsClean: true,
      browserNetworkUrlsClean: true,
      authFailureResponseRedacted: true,
      applicationLogsRedacted: true,
      logLinesInspected: 10,
    }),
    pilot_load: passed({
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

function restartResult() {
  return passed({
    restartHookSucceeded: true,
    reconnectsObserved: 2,
    preRestartMessageDurable: true,
    postRestartFanoutObserved: true,
    recoveryMs: 250,
  });
}

function passed(scenarioEvidence) {
  return {
    status: "passed",
    startedAt: timestamp,
    completedAt: timestamp,
    evidence: scenarioEvidence,
  };
}
