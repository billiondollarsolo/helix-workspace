import type { SecurityScanRecord, SecurityScanResult } from "@helix/contracts";
import type { SecurityTier } from "@helix/sdk-types";
import { safelyRecordSecurityMetric, type SecurityScanningMetrics } from "./metrics.js";

export type SecurityScanDisposition = "allow" | "allow_unscanned" | "quarantine";

/**
 * Personal permits an unavailable/unsupported scanner to leave content marked
 * as unscanned. Business and higher tiers fail closed. Infection is never
 * allowed, and non-terminal content is never made available at any tier.
 */
export function securityScanDisposition(
  tier: SecurityTier,
  scan: SecurityScanRecord,
): SecurityScanDisposition {
  switch (scan.state) {
    case "clean":
      return "allow";
    case "scan_failed":
    case "unsupported":
      return tier === "personal" ? "allow_unscanned" : "quarantine";
    case "pending":
    case "scanning":
    case "infected":
      return "quarantine";
  }
}

/**
 * Resolve a terminal verdict and emit only an additive quarantined-byte
 * metric. The policy result remains deterministic even if metrics fail.
 */
export function resolveTerminalSecurityScanPolicy(
  tier: SecurityTier,
  scan: SecurityScanResult,
  metrics?: SecurityScanningMetrics,
): SecurityScanDisposition {
  const disposition = securityScanDisposition(tier, scan);
  if (disposition === "quarantine") {
    safelyRecordSecurityMetric(() => {
      metrics?.recordSecurityQuarantinedBytes({
        scannerName: scan.evidence.scannerName,
        byteSize: scan.evidence.byteSize,
      });
    });
  }
  return disposition;
}
