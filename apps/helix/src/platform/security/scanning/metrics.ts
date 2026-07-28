import type { SecurityScanState } from "@helix/contracts";

/**
 * Narrow, privacy-safe metric surface for scanner clients and queue workers.
 * Implementations must not add filenames, addresses, tenant names, signatures,
 * or other content-derived values as labels.
 */
export interface SecurityScanningMetrics {
  recordSecurityScan(input: {
    readonly scannerName: string;
    readonly state: Extract<
      SecurityScanState,
      "clean" | "infected" | "scan_failed" | "unsupported"
    >;
    readonly durationSeconds: number;
    readonly byteSize: number;
  }): void;
  setSecurityScannerAvailable(input: {
    readonly scannerName: string;
    readonly available: boolean;
  }): void;
  setSecurityScanBacklog(input: {
    readonly scannerName: string;
    readonly pendingItems: number;
  }): void;
  recordSecurityQuarantinedBytes(input: {
    readonly scannerName: string;
    readonly byteSize: number;
  }): void;
}

/** Metrics must never turn a scanner verdict into an application failure. */
export function safelyRecordSecurityMetric(record: () => void): void {
  try {
    record();
  } catch {
    // Observability is deliberately best-effort on this low-level path.
  }
}
