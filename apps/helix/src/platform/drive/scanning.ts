/**
 * MIME sniffing + pluggable antivirus hooks for Drive finalize.
 * ClamAV (or other engines) plug in via VirusScanner; default is no-op.
 */

import type { SecurityScanResult } from "@helix/contracts";
import type { SecurityTier } from "@helix/sdk-types";
import {
  ClamdInstreamClient,
  resolveTerminalSecurityScanPolicy,
  type SecurityScanningMetrics,
  type SecurityScanDisposition,
  type SecurityScanInput,
} from "../security/scanning/index.js";

export interface VirusScanResult {
  /** True only when a real scanner returned the clean terminal verdict. */
  readonly clean: boolean;
  readonly signature?: string;
  /** Shared content-free evidence when a real scanner ran. */
  readonly securityScan?: SecurityScanResult;
  /** Tier-specific availability decision; consumers must not infer it from `clean`. */
  readonly disposition?: SecurityScanDisposition;
}

export interface VirusScanner {
  /** Identifies whether production is backed by a real scanning engine. */
  readonly kind?: "noop" | "clamav";
  scan(bytes: SecurityScanInput): Promise<VirusScanResult>;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const GIF87 = Buffer.from("GIF87a", "ascii");
const GIF89 = Buffer.from("GIF89a", "ascii");
const PDF_MAGIC = Buffer.from("%PDF", "ascii");
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const MP4_FTYP = Buffer.from("ftyp", "ascii");

/** Client mimes that are unsafe to trust when sniff disagrees. */
const UNTRUSTED_CLIENT_PREFIXES = [
  "application/x-msdownload",
  "application/x-msdos-program",
  "application/x-executable",
  "application/x-sh",
  "application/javascript",
  "text/html",
  "application/xhtml+xml",
] as const;

/**
 * Detect MIME from magic bytes. Returns null when inconclusive.
 * Zip-family OOXML is reported as application/zip; callers may refine via name.
 */
export function sniffMimeType(bytes: Buffer | Uint8Array): string | null {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < 4) {
    return null;
  }
  if (startsWith(buf, PNG_MAGIC)) {
    return "image/png";
  }
  if (startsWith(buf, JPEG_MAGIC)) {
    return "image/jpeg";
  }
  if (startsWith(buf, GIF87) || startsWith(buf, GIF89)) {
    return "image/gif";
  }
  if (startsWith(buf, PDF_MAGIC)) {
    return "application/pdf";
  }
  if (startsWith(buf, WEBM_MAGIC)) {
    return "video/webm";
  }
  // ISO BMFF (mp4/m4a/mov): size(4) + 'ftyp'
  if (buf.length >= 12 && buf.subarray(4, 8).equals(MP4_FTYP)) {
    return "video/mp4";
  }
  if (startsWith(buf, ZIP_MAGIC)) {
    return "application/zip";
  }
  // SVG heuristic: leading whitespace + "<svg" or "<?xml" containing svg later.
  const head = buf
    .subarray(0, Math.min(buf.length, 256))
    .toString("utf8")
    .trimStart()
    .toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) {
    return "image/svg+xml";
  }
  return null;
}

/**
 * Prefer sniffed type when it disagrees with the client, especially when the
 * client claimed an image/office type but bytes say otherwise, or client
 * claimed an executable-ish type.
 */
export function resolveEffectiveMime(clientMime: string, sniffed: string | null): string {
  const client = clientMime.trim().toLowerCase() || "application/octet-stream";
  if (sniffed === null) {
    return client;
  }
  if (client === sniffed) {
    return client;
  }
  // Sniff is zip and client is a known OOXML type — keep client refinement.
  if (sniffed === "application/zip" && client.includes("openxmlformats")) {
    return client;
  }
  // Always trust sniff when client mime is security-sensitive.
  if (UNTRUSTED_CLIENT_PREFIXES.some((p) => client === p || client.startsWith(`${p};`))) {
    return sniffed;
  }
  // Client claims image/pdf/text/office but sniff disagrees → trust sniff.
  if (
    client.startsWith("image/") ||
    client === "application/pdf" ||
    client.startsWith("text/") ||
    client.includes("officedocument") ||
    client.includes("openxmlformats")
  ) {
    return sniffed;
  }
  // Default: prefer sniff when present for disposition/preview safety.
  return sniffed;
}

export function createNoopVirusScanner(): VirusScanner {
  return {
    kind: "noop",
    async scan(): Promise<VirusScanResult> {
      return { clean: true };
    },
  };
}

export interface DriveClamAvVirusScannerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly chunkSizeBytes?: number;
  readonly scannerVersion?: string;
  /**
   * Business and higher tiers quarantine scanner failures. Defaults to
   * `business` so an omitted policy cannot silently fail open.
   */
  readonly tier?: SecurityTier;
  readonly metrics?: SecurityScanningMetrics;
}

/**
 * Real Drive adapter over the shared, streaming clamd client.
 *
 * `server.ts` wires this when `driveConfig.malwareScanner` is present
 * (`createClamAvVirusScanner` + `assertDriveMalwareScannerReady` on production
 * boots). Business/higher tiers reject a missing or no-op scanner at startup;
 * personal may omit the adapter. Store/worker code never invents a silent
 * no-op in production Business configuration.
 */
export function createClamAvVirusScanner(
  options: DriveClamAvVirusScannerOptions = {},
): VirusScanner {
  const tier = options.tier ?? "business";
  const metrics = options.metrics;
  const client = new ClamdInstreamClient({
    host: options.host ?? "clamav",
    port: options.port ?? 3310,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.chunkSizeBytes === undefined ? {} : { chunkSizeBytes: options.chunkSizeBytes }),
    ...(options.scannerVersion === undefined ? {} : { scannerVersion: options.scannerVersion }),
    ...(metrics === undefined ? {} : { metrics }),
  });

  return {
    kind: "clamav",
    async scan(bytes: SecurityScanInput): Promise<VirusScanResult> {
      const securityScan = await client.scan(bytes);
      const disposition = resolveTerminalSecurityScanPolicy(tier, securityScan, metrics);
      return {
        clean: securityScan.state === "clean",
        ...(securityScan.state === "infected"
          ? { signature: securityScan.evidence.signature }
          : {}),
        securityScan,
        disposition,
      };
    },
  };
}

export function assertDriveMalwareScannerReady(
  tier: SecurityTier,
  scanner: VirusScanner | undefined,
): void {
  if (tier !== "personal" && (scanner === undefined || scanner.kind !== "clamav")) {
    throw new Error(
      "Business Drive requires the real streaming ClamAV adapter; the no-op scanner is forbidden.",
    );
  }
}

function startsWith(buf: Buffer, magic: Buffer): boolean {
  if (buf.length < magic.length) {
    return false;
  }
  return buf.subarray(0, magic.length).equals(magic);
}
