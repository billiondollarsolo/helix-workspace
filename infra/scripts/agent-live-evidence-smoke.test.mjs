import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  AGENT_LIVE_EVIDENCE_SCHEMA,
  AGENT_LIVE_SCENARIOS,
  assertAgentEvidenceContainsNoSecrets,
  createAgentEvidenceSkeleton,
  runAgentLiveEvidence,
  validateAgentLiveEvidence,
} from "./agent-live-evidence-smoke.mjs";

const execFileAsync = promisify(execFile);
const hash = "a".repeat(20);

describe("agent live evidence contract", () => {
  it("represents every live scenario as explicitly not run in static mode", () => {
    const evidence = validateAgentLiveEvidence(
      createAgentEvidenceSkeleton(new Date("2026-07-28T20:00:00.000Z")),
    );

    expect(evidence.schema).toBe(AGENT_LIVE_EVIDENCE_SCHEMA);
    expect(Object.keys(evidence.scenarios)).toEqual(AGENT_LIVE_SCENARIOS);
    expect(Object.values(evidence.scenarios).every((result) => result.status === "not_run")).toBe(
      true,
    );
  });

  it("never promotes missing services or credentials to live success", async () => {
    const evidence = await runAgentLiveEvidence({}, { fetch: forbiddenFetch });

    expect(evidence.status).toBe("failed");
    expect(evidence.failure).toEqual({
      code: "agent_live_smoke_failed",
      stage: "configuration",
    });
    expect(Object.values(evidence.scenarios).every((result) => result.status === "not_run")).toBe(
      true,
    );
  });

  it("rejects sensitive evidence fields and incomplete passed reports", () => {
    expect(() =>
      assertAgentEvidenceContainsNoSecrets({
        schema: AGENT_LIVE_EVIDENCE_SCHEMA,
        accessToken: "do-not-store",
      }),
    ).toThrow("sensitive Agent evidence field is forbidden");

    const incomplete = createAgentEvidenceSkeleton(new Date("2026-07-28T20:00:00.000Z"));
    incomplete.status = "passed";
    expect(() => validateAgentLiveEvidence(incomplete)).toThrow(
      "passed Agent live evidence requires every scenario to pass",
    );
  });

  it("accepts a complete content-free passed report", () => {
    const evidence = passedEvidence();
    expect(validateAgentLiveEvidence(evidence)).toBe(evidence);
  });

  it("emits machine-readable static JSON without claiming a live run", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["infra/scripts/agent-live-evidence-smoke.mjs", "--static"],
      { cwd: process.cwd() },
    );
    const evidence = JSON.parse(stdout);

    expect(evidence).toMatchObject({
      schema: AGENT_LIVE_EVIDENCE_SCHEMA,
      mode: "static",
      status: "static_validated",
    });
    expect(Object.values(evidence.scenarios).every((result) => result.status === "not_run")).toBe(
      true,
    );
  });
});

function passedEvidence() {
  return {
    schema: AGENT_LIVE_EVIDENCE_SCHEMA,
    runId: "run-1",
    mode: "live",
    status: "passed",
    startedAt: "2026-07-28T20:00:00.000Z",
    completedAt: "2026-07-28T20:01:00.000Z",
    scenarios: {
      oauth_least_privilege: {
        status: "passed",
        grant: "client_credentials",
        exactScopes: true,
        scopes: ["mail.read", "drive.read", "chat.read", "chat.post"],
        clientHash: hash,
      },
      mcp_permitted_resources: {
        status: "passed",
        listedCount: 3,
        reads: resourceKinds("resourceHash", { byteSize: 100 }),
      },
      mcp_forbidden_resources: {
        status: "passed",
        allDenied: true,
        guesses: [1, 2, 3].map(() => ({ resourceHash: hash, errorCode: -32004 })),
      },
      chat_send_approval_once: {
        status: "passed",
        pendingHash: hash,
        markerHash: hash,
        separateHumanApproval: true,
        duplicateApprovalDenied: true,
        observedMessageCount: 1,
      },
      mail_send_denied: {
        status: "passed",
        absentFromEnumeration: true,
        directCallDenied: true,
        outboundQueueRecordsCreated: 0,
        errorCode: -32003,
      },
      prompt_injection_resistance: {
        status: "passed",
        fixtures: resourceKinds("fixtureHash", {
          fixtureBytes: 100,
          forbiddenMutationDenied: true,
        }),
        toolVisibilityUnchanged: true,
        forbiddenMutationDenied: true,
      },
      credential_revoked_pending_action: {
        status: "passed",
        pendingHash: hash,
        clientHash: hash,
        revokeExecuted: true,
        approvalDenied: true,
        errorStatus: 403,
      },
      audit_correlation_redaction: {
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
      },
    },
  };
}

function resourceKinds(hashKey, rest) {
  return Object.fromEntries(
    ["mail", "drive", "chat"].map((kind) => [kind, { [hashKey]: hash, ...rest }]),
  );
}

async function forbiddenFetch() {
  throw new Error("network should not be used without valid live configuration");
}

export { passedEvidence };
