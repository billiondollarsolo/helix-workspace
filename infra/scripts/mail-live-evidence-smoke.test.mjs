import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  MAIL_EXTERNAL_TARGETS,
  MAIL_LIVE_EVIDENCE_SCHEMA,
  MAIL_LIVE_SCENARIOS,
  addressEvidence,
  assertEvidenceContainsNoSecrets,
  createEvidenceSkeleton,
  validateMailLiveEvidence,
} from "./mail-live-evidence-smoke.mjs";

const execFileAsync = promisify(execFile);

describe("mail live evidence contract", () => {
  it("represents every local and external scenario as explicitly not run in static mode", () => {
    const evidence = validateMailLiveEvidence(
      createEvidenceSkeleton(new Date("2026-07-28T12:00:00.000Z")),
    );
    expect(evidence.schema).toBe(MAIL_LIVE_EVIDENCE_SCHEMA);
    expect(Object.keys(evidence.local)).toEqual(MAIL_LIVE_SCENARIOS);
    expect(Object.keys(evidence.external)).toEqual(MAIL_EXTERNAL_TARGETS);
    expect(Object.values(evidence.local).every((result) => result.status === "not_run")).toBe(true);
    expect(Object.values(evidence.external).every((result) => result.status === "not_run")).toBe(
      true,
    );
  });

  it("records only recipient domain and a one-way address hash", () => {
    const result = addressEvidence("Probe.User@Gmail.COM");
    expect(result).toEqual({
      domain: "gmail.com",
      addressHash: expect.stringMatching(/^[a-f0-9]{20}$/u),
    });
    expect(JSON.stringify(result)).not.toContain("Probe.User");
  });

  it("rejects secrets, message bodies, and direct recipient address fields", () => {
    for (const unsafe of [
      { token: "secret" },
      { messageBody: "content" },
      { recipientAddress: "person@example.com" },
      { webhookSecret: "secret" },
    ]) {
      expect(() => assertEvidenceContainsNoSecrets({ evidence: unsafe })).toThrow(
        "sensitive evidence field is forbidden",
      );
    }
  });

  it("does not accept a bare passed status as local evidence", () => {
    const evidence = createEvidenceSkeleton(new Date("2026-07-28T12:00:00.000Z"));
    evidence.local.eicar_quarantine = { status: "passed" };
    expect(() => validateMailLiveEvidence(evidence)).toThrow("invalid EICAR quarantine evidence");
  });

  it("emits valid machine-readable JSON without claiming live evidence", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["infra/scripts/mail-live-evidence-smoke.mjs", "--static"],
      { cwd: process.cwd() },
    );
    const evidence = JSON.parse(stdout);
    expect(() => validateMailLiveEvidence(evidence)).not.toThrow();
    expect(evidence.status).toBe("static_validated");
    expect(JSON.stringify(evidence)).not.toMatch(/"status":\s*"passed"/u);
  });

  it("emits a failed, non-fabricated report when a live run cannot start", async () => {
    let failure;
    try {
      await execFileAsync(
        process.execPath,
        ["infra/scripts/mail-live-evidence-smoke.mjs", "--local"],
        {
          cwd: process.cwd(),
          env: {},
        },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeDefined();
    const evidence = JSON.parse(failure.stdout);
    expect(() => validateMailLiveEvidence(evidence)).not.toThrow();
    expect(evidence).toMatchObject({
      mode: "local",
      status: "failed",
      failure: { code: "mail_live_smoke_failed" },
    });
    expect(JSON.stringify(evidence)).not.toMatch(/"status":\s*"passed"/u);
  });

  it("validates real external result hooks without inventing missing evidence", () => {
    const evidence = createEvidenceSkeleton(new Date("2026-07-28T12:00:00.000Z"));
    evidence.external.provider_sandbox = {
      status: "passed",
      provider: "approved-sandbox",
      events: [
        { type: "hard_bounce", eventIdHash: "a".repeat(20), suppressed: true },
        { type: "complaint", eventIdHash: "b".repeat(20), suppressed: true },
      ],
    };
    evidence.external.gmail = {
      status: "passed",
      provider: "approved-sandbox",
      recipientDomain: "gmail.com",
      messageIdHash: "c".repeat(20),
      latencyMs: 1200,
      placement: "inbox",
      finalStatus: "delivered",
      authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
    };
    expect(() => validateMailLiveEvidence(evidence)).not.toThrow();

    evidence.external.microsoft365 = {
      status: "passed",
      provider: "approved-sandbox",
    };
    expect(() => validateMailLiveEvidence(evidence)).toThrow(
      "invalid microsoft365 external delivery evidence",
    );
  });
});
