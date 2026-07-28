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
 * Inbound ingest scans every received message; an infected verdict routes the
 * message to the Spam folder and records the signature on the message
 * metadata. The hook is config-gated via `MAIL_CLAMAV_ENABLED` — when unset the
 * scanner is never constructed and ingest skips scanning.
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

const DEFAULT_CLAMAV_TIMEOUT_MS = 30_000;
const DEFAULT_CLAMAV_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_CLAMAV_PORT = 3310;

/**
 * Antivirus scanner backed by a ClamAV `clamd` daemon over TCP.
 *
 * Best-effort from ingest's point of view: a daemon outage surfaces as a
 * thrown error the ingest pipeline catches and treats as "unscanned".
 */
export class ClamavScanner implements AntivirusScanner {
  readonly #client: ClamdInstreamClient;
  readonly #tier: SecurityTier;
  readonly #metrics: SecurityScanningMetrics | undefined;

  constructor(options: ClamavScannerOptions) {
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

  async scan(raw: Buffer | string): Promise<AntivirusScanResult> {
    return trace.getTracer("helix.mail").startActiveSpan("clamav.instream", async (span) => {
      try {
        const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
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

/**
 * Resolve a {@link ClamavScanner} from the environment. Returns `undefined`
 * (scanning disabled) unless `MAIL_CLAMAV_ENABLED` is truthy.
 *
 *   MAIL_CLAMAV_ENABLED    enable inbound antivirus scanning
 *   MAIL_CLAMAV_HOST       clamd host (default `clamav`)
 *   MAIL_CLAMAV_PORT       clamd port (default 3310)
 *   MAIL_CLAMAV_TIMEOUT_MS per-scan socket timeout (default 30000)
 */
/**
 * @deprecated Prefer `mailConfig(env).clamav` from `./config.js` (G3).
 * Kept for unit tests that pass a plain env record.
 */
export function getClamavScannerConfig(
  env: Readonly<Record<string, string | undefined>>,
): ClamavScannerOptions | undefined {
  if (!envFlag(env.MAIL_CLAMAV_ENABLED)) {
    return undefined;
  }
  const host = env.MAIL_CLAMAV_HOST ?? "clamav";
  const port = parsePositiveInt(env.MAIL_CLAMAV_PORT) ?? DEFAULT_CLAMAV_PORT;
  const timeoutMs = parsePositiveInt(env.MAIL_CLAMAV_TIMEOUT_MS);
  return {
    host,
    port,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function envFlag(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
