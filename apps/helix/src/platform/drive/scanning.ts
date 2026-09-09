/** MIME sniffing + pluggable antivirus hooks for Drive finalize. */

import { ClamavScanner } from "../mail/antivirus.js";

export interface VirusScanResult {
  readonly clean: boolean;
  readonly signature?: string;
}

export interface VirusScanner {
  readonly kind?: "clamav" | "noop";
  scan(bytes: Buffer | Uint8Array): Promise<VirusScanResult>;
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
const RIFF_MAGIC = Buffer.from("RIFF", "ascii");
const WEBP_MAGIC = Buffer.from("WEBP", "ascii");
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
  if (startsWith(buf, RIFF_MAGIC) && buf.length >= 12 && buf.subarray(8, 12).equals(WEBP_MAGIC)) {
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

/** Reuse the bounded clamd INSTREAM client already used by mail ingestion. */
export function createClamAvVirusScanner(
  options: {
    readonly host?: string;
    readonly port?: number;
    readonly timeoutMs?: number;
    readonly maxFileBytes?: number;
    readonly archiveLimits?: Partial<ArchiveScanLimits>;
  } = {},
): VirusScanner {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_DRIVE_MAX_SCAN_BYTES;
  const scanner = new ClamavScanner({
    host: options.host ?? "clamav",
    port: options.port ?? 3310,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    maxMessageBytes: maxFileBytes,
  });
  return {
    kind: "clamav",
    async scan(bytes): Promise<VirusScanResult> {
      if (bytes.byteLength > maxFileBytes) {
        return { clean: false, signature: "Heuristics.Limits.Exceeded" };
      }
      try {
        assertArchiveWithinLimits(bytes, {
          ...DEFAULT_ARCHIVE_LIMITS,
          ...options.archiveLimits,
        });
      } catch (error) {
        if (error instanceof UnsafeArchiveError) {
          return { clean: false, signature: "Heuristics.ArchiveBomb" };
        }
        throw error;
      }
      const verdict = await scanner.scan(Buffer.from(bytes));
      if (!verdict.scanned) {
        throw new Error("Drive file was not scanned by ClamAV.");
      }
      return {
        clean: !verdict.infected,
        ...(verdict.signature === null ? {} : { signature: verdict.signature }),
      };
    },
    async scanStream(bytes, byteSize): Promise<VirusScanResult> {
      if (byteSize > maxFileBytes) {
        return { clean: false, signature: "Heuristics.Limits.Exceeded" };
      }
      const verdict = await scanner.scanStream(bytes, byteSize);
      if (!verdict.scanned) throw new Error("Drive file was not scanned by ClamAV.");
      return {
        clean: !verdict.infected,
        ...(verdict.signature === null ? {} : { signature: verdict.signature }),
      };
    },
  };
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
