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
  scanStream?(bytes: AsyncIterable<Uint8Array>, byteSize: number): Promise<VirusScanResult>;
}

export interface ArchiveScanLimits {
  readonly maxEntries: number;
  readonly maxUncompressedBytes: number;
  readonly maxExpansionRatio: number;
  readonly maxNestedArchives: number;
}

const DEFAULT_ARCHIVE_LIMITS: ArchiveScanLimits = {
  maxEntries: 10_000,
  maxUncompressedBytes: 1024 * 1024 * 1024,
  maxExpansionRatio: 100,
  maxNestedArchives: 20,
};
const DEFAULT_DRIVE_MAX_SCAN_BYTES = 128 * 1024 * 1024;

export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeArchiveError";
  }
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
  if (
    buf.length >= 16 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(buf.toString("ascii", 12, 16))
  ) {
    return "image/webp";
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

export function isNoopVirusScanner(scanner: VirusScanner): boolean {
  return scanner.kind === "noop";
}

export interface DriveClamAvVirusScannerOptions {
  readonly maxFileBytes?: number;
  readonly archiveLimits?: Partial<ArchiveScanLimits>;
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
    maxBytes: options.maxFileBytes ?? options.maxBytes ?? DEFAULT_DRIVE_MAX_SCAN_BYTES,
    ...(options.chunkSizeBytes === undefined ? {} : { chunkSizeBytes: options.chunkSizeBytes }),
    ...(options.scannerVersion === undefined ? {} : { scannerVersion: options.scannerVersion }),
    ...(metrics === undefined ? {} : { metrics }),
  });

  return {
    kind: "clamav",
    async scanStream(bytes, byteSize): Promise<VirusScanResult> {
      if (!Number.isSafeInteger(byteSize) || byteSize < 0)
        throw new TypeError("Invalid scan byte size");
      async function* checkedChunks(): AsyncIterable<Uint8Array> {
        let observed = 0;
        for await (const chunk of bytes) {
          observed += chunk.byteLength;
          if (observed > byteSize) throw new Error("Scan stream exceeded its declared size");
          yield chunk;
        }
        if (observed !== byteSize)
          throw new Error("Scan stream size did not match its declared size");
      }
      return this.scan(checkedChunks());
    },
    async scan(bytes: SecurityScanInput): Promise<VirusScanResult> {
      if (bytes instanceof Uint8Array) {
        try {
          assertArchiveWithinLimits(bytes, { ...DEFAULT_ARCHIVE_LIMITS, ...options.archiveLimits });
        } catch (error) {
          if (error instanceof UnsafeArchiveError)
            return { clean: false, signature: "Heuristics.ArchiveBomb" };
          throw error;
        }
      }
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

/**
 * Reject archive metadata that can force disproportionate decompression work.
 * ClamAV remains authoritative for archive contents and nested formats; this
 * preflight prevents common ZIP/GZIP bombs from ever reaching the daemon.
 */
export function assertArchiveWithinLimits(
  bytes: Buffer | Uint8Array,
  limits: ArchiveScanLimits = DEFAULT_ARCHIVE_LIMITS,
): void {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (startsWith(body, ZIP_MAGIC)) {
    assertZipWithinLimits(body, limits);
  } else if (body.length >= 18 && body[0] === 0x1f && body[1] === 0x8b) {
    const uncompressedBytes = body.readUInt32LE(body.length - 4);
    assertExpansionWithinLimits(1, body.byteLength, uncompressedBytes, 0, limits);
  }
}

function assertZipWithinLimits(body: Buffer, limits: ArchiveScanLimits): void {
  const eocd = findZipEndOfCentralDirectory(body);
  if (eocd === -1) {
    throw new UnsafeArchiveError("ZIP central directory is missing or malformed.");
  }
  const entries = body.readUInt16LE(eocd + 10);
  const centralSize = body.readUInt32LE(eocd + 12);
  const centralOffset = body.readUInt32LE(eocd + 16);
  if (
    body.readUInt16LE(eocd + 4) !== 0 ||
    body.readUInt16LE(eocd + 6) !== 0 ||
    body.readUInt16LE(eocd + 8) !== entries
  ) {
    throw new UnsafeArchiveError("Split ZIP archives are outside the bounded scan policy.");
  }
  if (entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new UnsafeArchiveError("ZIP64 archives are outside the bounded scan policy.");
  }
  if (entries > limits.maxEntries || centralOffset + centralSize > eocd) {
    throw new UnsafeArchiveError("ZIP archive exceeds entry or directory limits.");
  }

  let offset = centralOffset;
  let compressedBytes = 0;
  let uncompressedBytes = 0;
  let nestedArchives = 0;
  for (let entry = 0; entry < entries; entry += 1) {
    if (offset + 46 > eocd || body.readUInt32LE(offset) !== 0x02014b50) {
      throw new UnsafeArchiveError("ZIP central directory is malformed.");
    }
    const compressed = body.readUInt32LE(offset + 20);
    const uncompressed = body.readUInt32LE(offset + 24);
    const nameLength = body.readUInt16LE(offset + 28);
    const extraLength = body.readUInt16LE(offset + 30);
    const commentLength = body.readUInt16LE(offset + 32);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || nextOffset > eocd) {
      throw new UnsafeArchiveError("ZIP entry metadata is outside the bounded scan policy.");
    }
    const name = body.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (/\.(?:7z|bz2|gz|jar|rar|tar|tgz|xz|zip)$/iu.test(name)) {
      nestedArchives += 1;
    }
    compressedBytes += compressed;
    uncompressedBytes += uncompressed;
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) {
    throw new UnsafeArchiveError("ZIP central directory size does not match its entries.");
  }
  assertExpansionWithinLimits(entries, compressedBytes, uncompressedBytes, nestedArchives, limits);
}

function assertExpansionWithinLimits(
  entries: number,
  compressedBytes: number,
  uncompressedBytes: number,
  nestedArchives: number,
  limits: ArchiveScanLimits,
): void {
  const ratio = uncompressedBytes / Math.max(1, compressedBytes);
  if (
    entries > limits.maxEntries ||
    uncompressedBytes > limits.maxUncompressedBytes ||
    ratio > limits.maxExpansionRatio ||
    nestedArchives > limits.maxNestedArchives
  ) {
    throw new UnsafeArchiveError("Archive exceeds safe decompression limits.");
  }
}

function findZipEndOfCentralDirectory(body: Buffer): number {
  const minimumOffset = Math.max(0, body.length - 65_557);
  for (let offset = body.length - 22; offset >= minimumOffset; offset -= 1) {
    if (
      body.readUInt32LE(offset) === 0x06054b50 &&
      offset + 22 + body.readUInt16LE(offset + 20) === body.length
    ) {
      return offset;
    }
  }
  return -1;
}

function startsWith(buf: Buffer, magic: Buffer): boolean {
  if (buf.length < magic.length) {
    return false;
  }
  return buf.subarray(0, magic.length).equals(magic);
}
