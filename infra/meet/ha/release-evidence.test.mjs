import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath, URL } from "node:url";
import { loadReleasePolicy, validateReleaseEvidence } from "./release-evidence.mjs";

const policy = await loadReleasePolicy();

function passingEvidence() {
  const profiles = policy.regions.flatMap((region) => [
    { region, kind: "two_party", peakConcurrentParticipants: 10 },
    { region, kind: "small", peakConcurrentParticipants: 20 },
    { region, kind: "large", peakConcurrentParticipants: 30 },
    { region, kind: "screen_share", peakConcurrentParticipants: 10 },
    { region, kind: "recorded", peakConcurrentParticipants: 10 },
  ]);
  return {
    report: {
      schemaVersion: 1,
      release: "candidate-1",
      startedAt: "2026-09-02T00:00:00.000Z",
      endedAt: "2026-09-02T00:30:00.000Z",
      workload: { profiles },
      observations: {
        participantMinutes: 7_200,
        joinAttempts: 240,
        joinSuccessPercent: 100,
        joinP95Ms: 2_000,
        healthyMediaPercent: 100,
        qualitySamples: 2_400,
        packetLossP95Percent: 1,
        jitterP95Ms: 20,
        rttP95Ms: 100,
        recordingAttempts: 3,
        recordingSuccessPercent: 100,
        recordingReadyP95Ms: 60_000,
      },
    },
    recovery: {
      schemaVersion: 1,
      measuredAt: "2026-09-02T00:15:00.000Z",
      mode: "bridge",
      observationSeconds: 180,
      maxOutageSeconds: 4,
    },
  };
}

test("accepts sustained private mixed-call evidence within every SLO", () => {
  const { report, recovery } = passingEvidence();
  assert.deepEqual(validateReleaseEvidence(report, recovery, policy), []);
});

test("rejects short, degraded, single-profile, and identifying evidence", () => {
  const { report, recovery } = passingEvidence();
  report.endedAt = "2026-09-02T00:05:00.000Z";
  report.workload.profiles = report.workload.profiles.filter(({ kind }) => kind === "two_party");
  report.observations.packetLossP95Percent = 12;
  report.roomId = "must-not-be-retained";
  recovery.maxOutageSeconds = 31;
  const errors = validateReleaseEvidence(report, recovery, policy);
  assert.ok(errors.some((error) => error.includes("at least 1800s")));
  assert.ok(errors.some((error) => error.includes("missing recorded")));
  assert.ok(errors.includes("packet-loss SLO missed"));
  assert.ok(errors.includes("failure recovery SLO missed"));
  assert.ok(errors.some((error) => error.includes("roomId is forbidden")));
});

test("failover drill emits machine-readable aggregate recovery evidence", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "helix-meet-evidence-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const curl = join(directory, "curl");
  const kubectl = join(directory, "kubectl");
  const evidence = join(directory, "recovery.json");
  await Promise.all([
    writeFile(curl, "#!/bin/sh\nexit 0\n"),
    writeFile(kubectl, '#!/bin/sh\ncase "$*" in *"get pod"*) printf "jvb-test";; esac\nexit 0\n'),
  ]);
  await Promise.all([chmod(curl, 0o700), chmod(kubectl, 0o700)]);
  const result = spawnSync(
    "bash",
    [fileURLToPath(new URL("failover-drill.sh", import.meta.url)), "--confirm", "bridge"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        HELIX_MEET_CANARY_URL: "https://canary.test/health",
        HELIX_MEET_DRILL_SECONDS: "1",
        HELIX_MEET_RECOVERY_EVIDENCE: evidence,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(await readFile(evidence, "utf8"));
  assert.equal(output.schemaVersion, 1);
  assert.match(output.measuredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(output.mode, "bridge");
  assert.equal(output.observationSeconds, 1);
  assert.equal(output.maxOutageSeconds, 0);
});
