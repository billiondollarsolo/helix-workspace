import { Socket } from "node:net";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { JsonObject } from "@helix/sdk-types";

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
}

const DEFAULT_CLAMAV_TIMEOUT_MS = 30_000;
const DEFAULT_CLAMAV_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_CLAMAV_PORT = 3310;
const CLAMD_CHUNK_SIZE = 64 * 1024;

/**
 * Antivirus scanner backed by a ClamAV `clamd` daemon over TCP.
 *
 * Best-effort from ingest's point of view: a daemon outage surfaces as a
 * thrown error the ingest pipeline catches and treats as "unscanned".
 */
export class ClamavScanner implements AntivirusScanner {
  readonly #host: string;
  readonly #port: number;
  readonly #timeoutMs: number;
  readonly #maxMessageBytes: number;

  constructor(options: ClamavScannerOptions) {
    this.#host = options.host;
    this.#port = options.port;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_CLAMAV_TIMEOUT_MS;
    this.#maxMessageBytes = options.maxMessageBytes ?? DEFAULT_CLAMAV_MAX_BYTES;
  }

  async scan(raw: Buffer | string): Promise<AntivirusScanResult> {
    return trace.getTracer("helix.mail").startActiveSpan("clamav.instream", async (span) => {
      try {
        const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (body.byteLength > this.#maxMessageBytes) {
          span.setAttribute("helix.mail.av_scanned", false);
          return {
            infected: false,
            signature: null,
            scanned: false,
            evidence: {
              scanned: false,
              reason: "message exceeds clamd max size",
              byteSize: body.byteLength,
            },
          } satisfies AntivirusScanResult;
        }
        const response = await this.#instream(body);
        const verdict = parseClamavResponse(response);
        span.setAttribute("helix.mail.av_infected", verdict.infected);
        if (verdict.signature !== null) {
          span.setAttribute("helix.mail.av_signature", verdict.signature);
        }
        return {
          infected: verdict.infected,
          signature: verdict.signature,
          scanned: true,
          evidence: {
            scanned: true,
            infected: verdict.infected,
            signature: verdict.signature,
            host: this.#host,
            port: this.#port,
          },
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

  #instream(body: Buffer): Promise<string> {
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
        // INSTREAM: each chunk is a 4-byte big-endian length prefix followed by
        // that many bytes; a zero-length chunk terminates the stream.
        socket.write("zINSTREAM\0");
        for (let offset = 0; offset < body.byteLength; offset += CLAMD_CHUNK_SIZE) {
          const slice = body.subarray(offset, offset + CLAMD_CHUNK_SIZE);
          const prefix = Buffer.alloc(4);
          prefix.writeUInt32BE(slice.byteLength, 0);
          socket.write(prefix);
          socket.write(slice);
        }
        const terminator = Buffer.alloc(4);
        terminator.writeUInt32BE(0, 0);
        socket.write(terminator);
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
  const trimmed = response.replace(/\0/gu, "").trim();
  if (/\bERROR$/u.test(trimmed)) {
    throw new Error(`clamd returned an error: ${trimmed}`);
  }
  if (/\bOK$/u.test(trimmed)) {
    return { infected: false, signature: null };
  }
  const found = /:\s*(.+?)\s+FOUND$/u.exec(trimmed);
  if (found !== null) {
    return { infected: true, signature: found[1] ?? "unknown" };
  }
  throw new Error(`Unparseable clamd response: ${trimmed.slice(0, 120)}`);
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
export function getClamavScannerConfig(env: NodeJS.ProcessEnv): ClamavScannerOptions | undefined {
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
