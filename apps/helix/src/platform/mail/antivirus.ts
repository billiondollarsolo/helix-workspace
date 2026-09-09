import { Socket } from "node:net";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { SecurityScanResult } from "@helix/contracts";
import type { JsonObject, SecurityTier } from "@helix/sdk-types";
import {
  ClamdInstreamClient,
  parseClamdInstreamResponse,
  resolveTerminalSecurityScanPolicy,
  type SecurityScanningMetrics,
  type SecurityScanDisposition,
} from "../security/scanning/index.js";

/**
 * ClamAV `clamd` antivirus integration.
 *
 * `clamd` exposes an `INSTREAM` request over a TCP socket: the client sends the
 * message in length-prefixed chunks terminated by a zero-length chunk, and
 * clamd replies with either `stream: OK` or `stream: <Signature> FOUND`.
 *
 * Inbound SMTP ingest scans every received message; an infected verdict moves
 * the original bytes into the inaccessible mail quarantine before any mailbox
 * message or attachment is created. The hook is config-gated via
 * `MAIL_CLAMAV_ENABLED` — when unset the scanner is never constructed.
 */

/** Verdict from a single antivirus scan. */
export interface AntivirusScanResult {
  /** True when clamd reported a virus signature. */
  readonly infected: boolean;
  /** Matched signature name when {@link infected}, otherwise `null`. */
  readonly signature: string | null;
  /** Whether the message was actually scanned (false when skipped/oversized). */
  readonly scanned: boolean;
  /** Structured evidence persisted on the message metadata. */
  readonly evidence: JsonObject;
  /** Shared content-free result from the real scanner, when configured. */
  readonly securityScan?: SecurityScanResult;
  /** Domain policy decision for the organization security tier. */
  readonly disposition?: SecurityScanDisposition;
}

/** Pluggable antivirus scanner. Inbound ingest calls {@link AntivirusScanner.scan}. */
export interface AntivirusScanner {
  scan(raw: Buffer | string): Promise<AntivirusScanResult>;
}

export interface ClamavScannerOptions {
  readonly host: string;
  readonly port: number;
  /** Per-scan socket timeout in milliseconds. Defaults to 30s. */
  readonly timeoutMs?: number;
  /** Maximum message size sent to clamd, in bytes. Defaults to 25 MiB. */
  readonly maxMessageBytes?: number;
  /** Engine/definition version discovered by deployment health checks. */
  readonly scannerVersion?: string;
  /** Defaults to Personal's explicitly unscanned failure behavior. */
  readonly tier?: SecurityTier;
  readonly metrics?: SecurityScanningMetrics;
}

export interface ClamavVersionInfo {
  readonly engineVersion: string;
  readonly signatureVersion: number;
  readonly signatureUpdatedAt: Date;
}

export interface ClamavReadinessOptions {
  readonly maxSignatureAgeMs: number;
  readonly now?: Date;
}

const DEFAULT_CLAMAV_TIMEOUT_MS = 30_000;
const DEFAULT_CLAMAV_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Antivirus scanner backed by a ClamAV `clamd` daemon over TCP.
 *
 * Daemon outages surface as errors; ingest applies the receiving tenant's
 * explicit delivery or temporary-deferral policy.
 */
export class ClamavScanner implements AntivirusScanner {
  readonly #host: string;
  readonly #port: number;
  readonly #timeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #client: ClamdInstreamClient;
  readonly #tier: SecurityTier;
  readonly #metrics: SecurityScanningMetrics | undefined;

  constructor(options: ClamavScannerOptions) {
    this.#host = options.host;
    this.#port = options.port;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_CLAMAV_TIMEOUT_MS;
    this.#maxMessageBytes = options.maxMessageBytes ?? DEFAULT_CLAMAV_MAX_BYTES;
    this.#tier = options.tier ?? "personal";
    this.#metrics = options.metrics;
    this.#client = new ClamdInstreamClient({
      host: options.host,
      port: options.port,
      timeoutMs: options.timeoutMs ?? DEFAULT_CLAMAV_TIMEOUT_MS,
      maxBytes: options.maxMessageBytes ?? DEFAULT_CLAMAV_MAX_BYTES,
      ...(options.scannerVersion === undefined ? {} : { scannerVersion: options.scannerVersion }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    });
  }

  async checkHealth(): Promise<void> {
    const response = await this.#request("zPING\0");
    if (response.replace(/\0/gu, "").trim() !== "PONG") {
      throw new Error("clamd health check returned an invalid response");
    }
  }

  /** PING plus a fail-closed freshness check of clamd's loaded signature database. */
  async checkReadiness(options: ClamavReadinessOptions): Promise<ClamavVersionInfo> {
    await this.checkHealth();
    const version = parseClamavVersion(await this.#request("zVERSION\0"));
    const now = options.now ?? new Date();
    const ageMs = now.getTime() - version.signatureUpdatedAt.getTime();
    if (ageMs < -5 * 60_000) {
      throw new Error("clamd signature timestamp is unexpectedly in the future");
    }
    if (ageMs > options.maxSignatureAgeMs) {
      throw new Error("clamd signatures are stale");
    }
    return version;
  }

  async scan(raw: Buffer | string): Promise<AntivirusScanResult> {
    return this.scanInput(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
  }

  private async scanInput(body: Buffer | AsyncIterable<Uint8Array>): Promise<AntivirusScanResult> {
    return trace.getTracer("helix.mail").startActiveSpan("clamav.instream", async (span) => {
      try {
        const result = await this.#client.scan(body);
        const disposition = resolveTerminalSecurityScanPolicy(this.#tier, result, this.#metrics);
        if (result.state === "unsupported" || result.state === "scan_failed") {
          span.setAttribute("helix.mail.av_scanned", false);
          return {
            infected: false,
            signature: null,
            scanned: false,
            evidence: safeEvidence(result.evidence),
            securityScan: result,
            disposition,
          } satisfies AntivirusScanResult;
        }
        const infected = result.state === "infected";
        const signature = result.state === "infected" ? result.evidence.signature : null;
        span.setAttribute("helix.mail.av_infected", infected);
        if (signature !== null) {
          span.setAttribute("helix.mail.av_signature", signature);
        }
        return {
          infected,
          signature,
          scanned: true,
          evidence: safeEvidence(result.evidence),
          securityScan: result,
          disposition,
        };
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async scanStream(raw: AsyncIterable<Uint8Array>, byteSize: number): Promise<AntivirusScanResult> {
    if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
      throw new TypeError("ClamAV stream size must be a non-negative safe integer");
    }
    if (byteSize > this.#maxMessageBytes) {
      return {
        infected: false,
        signature: null,
        scanned: false,
        evidence: { scanned: false, reason: "message exceeds clamd max size", byteSize },
      };
    }
    async function* checkedChunks(): AsyncIterable<Uint8Array> {
      let observed = 0;
      for await (const chunk of raw) {
        observed += chunk.byteLength;
        if (observed > byteSize) throw new Error("ClamAV stream exceeded its declared size");
        yield chunk;
      }
      if (observed !== byteSize)
        throw new Error("ClamAV stream size did not match its declared size");
    }
    return this.scanInput(checkedChunks());
  }

  #request(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      let settled = false;

      const finish = (error: Error | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (error !== null) {
          reject(error);
        } else {
          resolve(Buffer.concat(chunks).toString("utf8"));
        }
      };

      socket.setTimeout(this.#timeoutMs);
      socket.once("timeout", () => {
        finish(new Error(`clamd request timed out after ${String(this.#timeoutMs)}ms`));
      });
      socket.once("error", (error: Error) => {
        finish(error);
      });
      socket.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      socket.once("end", () => {
        finish(null);
      });

      socket.connect(this.#port, this.#host, () => {
        socket.write(command);
      });
    });
  }
}

interface ClamavVerdict {
  readonly infected: boolean;
  readonly signature: string | null;
}

/**
 * Parse a clamd `INSTREAM` reply.
 *
 *   `stream: OK`                          -> clean
 *   `stream: Eicar-Test-Signature FOUND`  -> infected
 *   `INSTREAM size limit exceeded. ERROR` -> error
 */
export function parseClamavResponse(response: string): ClamavVerdict {
  try {
    return parseClamdInstreamResponse(response);
  } catch {
    const trimmed = response.replace(/\0/gu, "").trim();
    if (/\bERROR$/u.test(trimmed)) {
      throw new Error(`clamd returned an error: ${trimmed}`);
    }
    throw new Error(`Unparseable clamd response: ${trimmed.slice(0, 120)}`);
  }
}

function safeEvidence(evidence: {
  readonly scannerName: string;
  readonly scannerVersion: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly byteSize: number;
  readonly signature?: string;
}): JsonObject {
  return {
    scannerName: evidence.scannerName,
    scannerVersion: evidence.scannerVersion,
    startedAt: evidence.startedAt,
    completedAt: evidence.completedAt,
    byteSize: evidence.byteSize,
    ...(evidence.signature === undefined ? {} : { signature: evidence.signature }),
  };
}

/** Parse `ClamAV <engine>/<database>/<updated>` returned by clamd VERSION. */
export function parseClamavVersion(response: string): ClamavVersionInfo {
  const trimmed = response.replace(/\0/gu, "").trim();
  const match = /^ClamAV\s+(?<engine>[^/\s]+)\/(?<signatures>\d+)\/(?<updated>.+)$/u.exec(trimmed);
  const engineVersion = match?.groups?.engine;
  const signatureVersion = Number(match?.groups?.signatures);
  const updatedText = match?.groups?.updated;
  const signatureUpdatedAt =
    updatedText === undefined ? new Date(Number.NaN) : new Date(`${updatedText} UTC`);
  if (
    engineVersion === undefined ||
    !Number.isSafeInteger(signatureVersion) ||
    signatureVersion <= 0 ||
    Number.isNaN(signatureUpdatedAt.getTime())
  ) {
    throw new Error("clamd VERSION response did not include parseable signature freshness");
  }
  return { engineVersion, signatureVersion, signatureUpdatedAt };
}
