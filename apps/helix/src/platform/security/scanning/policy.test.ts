import type { SecurityScanResult } from "@helix/contracts";
import { describe, expect, it } from "vitest";
import type { SecurityScanningMetrics } from "./metrics.js";
import { resolveTerminalSecurityScanPolicy, securityScanDisposition } from "./policy.js";

const evidence = {
  scannerName: "clamav",
  scannerVersion: "unknown",
  startedAt: "2026-07-28T12:00:00.000Z",
  completedAt: "2026-07-28T12:00:01.000Z",
  byteSize: 1024,
};

function result(state: SecurityScanResult["state"]): SecurityScanResult {
  return state === "infected"
    ? {
        state,
        evidence: { ...evidence, signature: "Eicar-Test-Signature" },
      }
    : { state, evidence };
}

describe("securityScanDisposition", () => {
  it("allows only a clean verdict in Business and higher tiers", () => {
    for (const tier of ["business", "enterprise", "sovereign"] as const) {
      expect(securityScanDisposition(tier, result("clean"))).toBe("allow");
      expect(securityScanDisposition(tier, result("infected"))).toBe("quarantine");
      expect(securityScanDisposition(tier, result("scan_failed"))).toBe("quarantine");
      expect(securityScanDisposition(tier, result("unsupported"))).toBe("quarantine");
      expect(securityScanDisposition(tier, { state: "pending" })).toBe("quarantine");
    }
  });

  it("allows Personal content to remain explicitly unscanned on scanner failure", () => {
    expect(securityScanDisposition("personal", result("clean"))).toBe("allow");
    expect(securityScanDisposition("personal", result("scan_failed"))).toBe("allow_unscanned");
    expect(securityScanDisposition("personal", result("unsupported"))).toBe("allow_unscanned");
    expect(securityScanDisposition("personal", result("infected"))).toBe("quarantine");
  });
});

describe("resolveTerminalSecurityScanPolicy", () => {
  it("records quarantined bytes without content-derived metric labels", () => {
    const records: unknown[] = [];
    const metrics: SecurityScanningMetrics = {
      recordSecurityScan: () => undefined,
      setSecurityScannerAvailable: () => undefined,
      setSecurityScanBacklog: () => undefined,
      recordSecurityQuarantinedBytes: (input) => records.push(input),
    };

    expect(resolveTerminalSecurityScanPolicy("business", result("scan_failed"), metrics)).toBe(
      "quarantine",
    );
    expect(records).toEqual([{ scannerName: "clamav", byteSize: 1024 }]);
  });

  it("does not let a broken metrics adapter change the policy result", () => {
    const metrics: SecurityScanningMetrics = {
      recordSecurityScan: () => undefined,
      setSecurityScannerAvailable: () => undefined,
      setSecurityScanBacklog: () => undefined,
      recordSecurityQuarantinedBytes: () => {
        throw new Error("metrics unavailable");
      },
    };

    expect(resolveTerminalSecurityScanPolicy("business", result("infected"), metrics)).toBe(
      "quarantine",
    );
  });
});
