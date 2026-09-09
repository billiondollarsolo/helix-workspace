import console from "node:console";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { pathToFileURL, URL } from "node:url";

const root = new URL("./", import.meta.url);
const requiredProfiles = ["two_party", "small", "large", "screen_share", "recorded"];
const forbiddenKeys = new Set([
  "actorid",
  "email",
  "ipaddress",
  "joinurl",
  "jwt",
  "mediacontent",
  "participantid",
  "recordingurl",
  "roomid",
  "secret",
  "storagekey",
  "token",
  "transcript",
]);

export async function loadReleasePolicy() {
  const values = Object.fromEntries(
    (await readFile(new URL("capacity.env", root), "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split("=", 2)),
  );
  const number = (key) => {
    const value = Number(values[key]);
    if (!Number.isFinite(value)) throw new Error(`Invalid ${key} in capacity.env.`);
    return value;
  };
  return {
    regions: values.REGIONS.split(","),
    plannedParticipantsPerRegion: number("JVB_PLANNED_PARTICIPANTS"),
    minimumLoadPercent: number("RELEASE_LOAD_PERCENT"),
    sustainedSeconds: number("RELEASE_SUSTAINED_SECONDS"),
    joinSuccessPercent: number("JOIN_SUCCESS_SLO_PERCENT"),
    joinP95Ms: number("JOIN_P95_SLO_MS"),
    healthyMediaPercent: number("HEALTHY_MEDIA_SLO_PERCENT"),
    packetLossP95Percent: number("PACKET_LOSS_P95_SLO_PERCENT"),
    jitterP95Ms: number("JITTER_P95_SLO_MS"),
    rttP95Ms: number("RTT_P95_SLO_MS"),
    recordingSuccessPercent: number("RECORDING_SUCCESS_SLO_PERCENT"),
    recordingReadyP95Ms: number("RECORDING_READY_P95_SLO_MS"),
    failureRecoverySeconds: number("FAILURE_RECOVERY_SLO_SECONDS"),
  };
}

export function validateReleaseEvidence(report, recovery, policy) {
  const errors = [];
  const expect = (condition, message) => {
    if (!condition) errors.push(message);
  };
  expect(report?.schemaVersion === 1, "workload schemaVersion must be 1");
  expect(recovery?.schemaVersion === 1, "recovery schemaVersion must be 1");
  expect(
    typeof report?.release === "string" && report.release.trim().length > 0,
    "release identifier is required",
  );
  const started = Date.parse(report?.startedAt);
  const ended = Date.parse(report?.endedAt);
  const measured = Date.parse(recovery?.measuredAt);
  const duration = (ended - started) / 1_000;
  expect(
    Number.isFinite(duration) && duration >= policy.sustainedSeconds,
    `workload must run for at least ${policy.sustainedSeconds}s`,
  );
  expect(
    Number.isFinite(measured) && measured >= started && measured <= ended,
    "recovery drill must occur during the measured workload",
  );

  const profiles = Array.isArray(report?.workload?.profiles) ? report.workload.profiles : [];
  const minimumRegionalLoad = Math.ceil(
    (policy.plannedParticipantsPerRegion * policy.minimumLoadPercent) / 100,
  );
  for (const region of policy.regions) {
    const regional = profiles.filter((profile) => profile?.region === region);
    const kinds = new Set(regional.map((profile) => profile?.kind));
    for (const kind of requiredProfiles) {
      expect(kinds.has(kind), `${region} is missing ${kind} calls`);
      expect(
        regional.some(
          (profile) =>
            profile?.kind === kind && finiteNumber(profile.peakConcurrentParticipants) > 0,
        ),
        `${region} has no active ${kind} participants`,
      );
    }
    const peak = regional.reduce(
      (sum, profile) => sum + finiteNumber(profile?.peakConcurrentParticipants),
      0,
    );
    expect(
      peak >= minimumRegionalLoad,
      `${region} must sustain at least ${minimumRegionalLoad} participants`,
    );
    expect(peak <= policy.plannedParticipantsPerRegion, `${region} exceeds certified N-1 capacity`);
  }

  const observation = report?.observations ?? {};
  const minimumParticipantMinutes =
    minimumRegionalLoad * policy.regions.length * (policy.sustainedSeconds / 60) * 0.95;
  expect(
    atLeast(observation.participantMinutes, minimumParticipantMinutes),
    "participant minutes do not prove sustained regional load",
  );
  expect(
    atLeast(observation.joinAttempts, minimumRegionalLoad * policy.regions.length),
    "too few measured join attempts",
  );
  expect(
    atLeast(observation.joinSuccessPercent, policy.joinSuccessPercent),
    "join success SLO missed",
  );
  expect(atMost(observation.joinP95Ms, policy.joinP95Ms), "join latency SLO missed");
  expect(
    atLeast(observation.healthyMediaPercent, policy.healthyMediaPercent),
    "healthy media-minute SLO missed",
  );
  expect(atLeast(observation.qualitySamples, observation.joinAttempts), "insufficient QoS samples");
  expect(
    atMost(observation.packetLossP95Percent, policy.packetLossP95Percent),
    "packet-loss SLO missed",
  );
  expect(atMost(observation.jitterP95Ms, policy.jitterP95Ms), "jitter SLO missed");
  expect(atMost(observation.rttP95Ms, policy.rttP95Ms), "RTT SLO missed");
  expect(
    atLeast(observation.recordingAttempts, policy.regions.length),
    "recording must be exercised in every region",
  );
  expect(
    atLeast(observation.recordingSuccessPercent, policy.recordingSuccessPercent),
    "recording success SLO missed",
  );
  expect(
    atMost(observation.recordingReadyP95Ms, policy.recordingReadyP95Ms),
    "recording readiness SLO missed",
  );

  expect(["bridge", "node", "zone"].includes(recovery?.mode), "unknown recovery drill mode");
  expect(atLeast(recovery?.observationSeconds, 180), "recovery drill must observe at least 180s");
  expect(
    atMost(recovery?.maxOutageSeconds, policy.failureRecoverySeconds),
    "failure recovery SLO missed",
  );
  rejectSensitiveFields(report, "$", errors);
  rejectSensitiveFields(recovery, "$recovery", errors);
  return errors;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function atLeast(value, minimum) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function atMost(value, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum;
}

function rejectSensitiveFields(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSensitiveFields(item, `${path}[${index}]`, errors));
    return;
  }
  if (typeof value !== "object" || value === null) {
    if (
      typeof value === "string" &&
      /(?:bearer\s+|jwt=|-----BEGIN .*PRIVATE KEY-----)/iu.test(value)
    ) {
      errors.push(`${path} contains a credential`);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key.replaceAll("_", "").toLowerCase())) {
      errors.push(`${path}.${key} is forbidden in aggregate evidence`);
    }
    rejectSensitiveFields(child, `${path}.${key}`, errors);
  }
}

async function main() {
  const [workloadPath, recoveryPath] = process.argv.slice(2);
  if (!workloadPath || !recoveryPath) {
    console.error("Usage: node infra/meet/ha/release-evidence.mjs <workload.json> <recovery.json>");
    process.exitCode = 2;
    return;
  }
  const [report, recovery, policy] = await Promise.all([
    readFile(workloadPath, "utf8").then(JSON.parse),
    readFile(recoveryPath, "utf8").then(JSON.parse),
    loadReleasePolicy(),
  ]);
  const errors = validateReleaseEvidence(report, recovery, policy);
  if (errors.length) throw new Error(`Meet release evidence failed:\n- ${errors.join("\n- ")}`);
  console.log(
    `Meet release evidence passed for ${report.release}: sustained mixed calls and ${recovery.mode} recovery.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
