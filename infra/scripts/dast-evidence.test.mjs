import { describe, expect, it } from "vitest";
import {
  DAST_MAX_TIMEOUT_SECONDS,
  ZAP_STABLE_IMAGE,
  buildDastEvidence,
  buildZapDockerArgs,
  classifyZapExecution,
  createStaticDastEvidence,
  parseDastArgs,
  summarizeZapReport,
  validateDastEvidence,
  validateDastTarget,
} from "./dast-evidence.mjs";
import { createReleaseEvidenceBinding } from "./release-evidence-binding.mjs";

const binding = createReleaseEvidenceBinding({
  workspaceSha: "a".repeat(40),
  editorsSha: "b".repeat(40),
  applicationImageDigest: `sha256:${"c".repeat(64)}`,
  webImageDigest: `sha256:${"d".repeat(64)}`,
});

describe("V5 DAST evidence contract", () => {
  it("pins the official stable ZAP image by immutable multiarch digest", () => {
    expect(ZAP_STABLE_IMAGE).toBe(
      "ghcr.io/zaproxy/zaproxy:2.17.0@sha256:8d387b1a63e3425beef4846e39719f5af2a787753af2d8b6558c6257d7a577a2",
    );
    expect(
      buildZapDockerArgs({
        workDirectory: "/tmp/dast",
        targetUrl: "https://staging.example.test",
        timeoutSeconds: 900,
      }),
    ).toEqual(
      expect.arrayContaining([
        ZAP_STABLE_IMAGE,
        "zap-baseline.py",
        "-t",
        "https://staging.example.test",
        "-J",
        "/zap/wrk/zap-report.json",
      ]),
    );
  });

  it("requires explicit disposable-target confirmation and a bounded timeout", () => {
    expect(() =>
      parseDastArgs(["--target", "https://staging.example.test", "--output", "report.json"]),
    ).toThrow("--confirm-disposable-target");
    expect(() =>
      parseDastArgs([
        "--target",
        "https://staging.example.test",
        "--output",
        "report.json",
        "--confirm-disposable-target",
        "--timeout-seconds",
        String(DAST_MAX_TIMEOUT_SECONDS + 1),
      ]),
    ).toThrow("between 60 and");
  });

  it("fails closed on Docker failures, timeouts, and missing or unparseable reports", () => {
    expect(classifyZapExecution({ status: 0, reportParsed: true })).toMatchObject({
      outcome: "completed",
    });
    for (const status of [3, 125, 137, null]) {
      expect(classifyZapExecution({ status, reportParsed: true })).toMatchObject({
        outcome: "scanner_error",
      });
    }
    expect(classifyZapExecution({ status: 0, reportParsed: false })).toMatchObject({
      outcome: "scanner_error",
    });
    expect(
      classifyZapExecution({ status: null, errorCode: "ETIMEDOUT", reportParsed: false }),
    ).toMatchObject({
      outcome: "timed_out",
    });
  });

  it("accepts HTTPS or loopback origins and rejects secret-bearing or expansive URLs", () => {
    expect(validateDastTarget("https://staging.example.test")).toMatchObject({ kind: "https" });
    expect(validateDastTarget("http://127.0.0.1:3000")).toMatchObject({ kind: "loopback" });
    expect(() => validateDastTarget("http://staging.example.test")).toThrow("HTTPS");
    expect(() => validateDastTarget("https://user:password@staging.example.test")).toThrow(
      "userinfo",
    );
    expect(() => validateDastTarget("https://staging.example.test?token=secret")).toThrow(
      "query string",
    );
    expect(() => validateDastTarget("https://staging.example.test/admin")).toThrow(
      "without a path",
    );
  });

  it("sanitizes ZAP output to bounded finding metadata without persisting URLs or instances", () => {
    expect(() => summarizeZapReport({})).toThrow("site array");
    const findings = summarizeZapReport({
      site: [
        {
          "@name": "https://staging.example.test",
          alerts: [
            {
              alertRef: "10020",
              alert: "Missing anti-clickjacking header",
              riskcode: "2",
              count: "2",
              instances: [
                { uri: "https://staging.example.test/?token=must-not-persist" },
                { uri: "https://staging.example.test/private" },
              ],
            },
          ],
        },
      ],
    });

    expect(findings).toEqual([
      {
        alertRef: "10020",
        name: "Missing anti-clickjacking header",
        severity: "medium",
        count: 2,
      },
    ]);
    expect(JSON.stringify(findings)).not.toContain("staging.example.test");
    expect(JSON.stringify(findings)).not.toContain("must-not-persist");
  });

  it("fails High/Critical findings and requires owned Medium/Low dispositions", () => {
    const high = liveEvidence({
      findings: [{ alertRef: "40001", name: "Injection", severity: "high", count: 1 }],
    });
    expect(high.status).toBe("failed");
    expect(() => validateDastEvidence(high, { requirePass: true })).toThrow(
      "final DAST evidence must be passed",
    );

    const undisposed = liveEvidence({
      findings: [{ alertRef: "10020", name: "Header gap", severity: "medium", count: 1 }],
    });
    expect(undisposed.status).toBe("failed");
    expect(() => validateDastEvidence(undisposed, { requirePass: true })).toThrow(
      "lacks a disposition",
    );

    const disposed = liveEvidence({
      findings: [{ alertRef: "10020", name: "Header gap", severity: "medium", count: 1 }],
      dispositions: [
        {
          alertRef: "10020",
          severity: "medium",
          decision: "mitigated",
          owner: "Security Engineering",
          deadline: "2026-08-15",
          rationale: "Compensating response-header policy verified at the edge.",
        },
      ],
    });
    expect(disposed.status).toBe("passed");
    expect(validateDastEvidence(disposed, { requirePass: true, expectedBinding: binding })).toBe(
      disposed,
    );

    const expired = clone(disposed);
    expired.dispositions[0].deadline = "2026-07-27";
    expect(() => validateDastEvidence(expired, { requirePass: true })).toThrow(
      "already expired at scan completion",
    );

    const impossible = clone(disposed);
    impossible.dispositions[0].deadline = "2026-02-30";
    expect(() => validateDastEvidence(impossible)).toThrow("deadline is invalid");

    const unsafeUrl = clone(disposed);
    unsafeUrl.dispositions[0].rationale = "See https://example.test/?token=must-not-persist";
    expect(() => validateDastEvidence(unsafeUrl)).toThrow("must not contain a URL");
  });

  it("rejects static, not_run, failed, unbound, mismatched, and secret-bearing final evidence", () => {
    expect(() => validateDastEvidence(createStaticDastEvidence(), { requirePass: true })).toThrow(
      "cannot be static",
    );

    const unbound = liveEvidence();
    delete unbound.releaseBinding;
    expect(() => validateDastEvidence(unbound, { requirePass: true })).toThrow(
      "requires a release binding",
    );

    const mismatch = liveEvidence();
    expect(() =>
      validateDastEvidence(mismatch, {
        requirePass: true,
        expectedBinding: { ...binding, workspaceSha: "e".repeat(40) },
      }),
    ).toThrow("does not match");

    const secretBearing = { ...liveEvidence(), apiToken: "must-not-persist" };
    expect(() => validateDastEvidence(secretBearing)).toThrow(
      "unexpected, missing, or secret-like",
    );
  });
});

function liveEvidence({ findings = [], dispositions = [] } = {}) {
  return buildDastEvidence({
    started: new Date("2026-07-28T20:00:00.000Z"),
    completed: new Date("2026-07-28T20:15:00.000Z"),
    timeoutSeconds: 900,
    target: {
      kind: "https",
      originSha256: `sha256:${"f".repeat(64)}`,
    },
    execution: { outcome: "completed", exitCode: 0, reportParsed: true },
    findings,
    dispositions,
    binding,
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
