import { Socket } from "node:net";
import { once } from "node:events";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { JsonObject } from "@helix/sdk-types";

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
const CLAMD_CHUNK_SIZE = 64 * 1024;

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

  constructor(options: ClamavScannerOptions) {
    this.#host = options.host;
    this.#port = options.port;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_CLAMAV_TIMEOUT_MS;
    this.#maxMessageBytes = options.maxMessageBytes ?? DEFAULT_CLAMAV_MAX_BYTES;
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
    const response = await this.#requestStream(raw, byteSize);
    const verdict = parseClamavResponse(response);
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
  }

  #instream(body: Buffer): Promise<string> {
    return this.#request("zINSTREAM\0", body);
  }

  #request(command: string, body?: Buffer): Promise<string> {
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
        if (body !== undefined) {
          // INSTREAM: each chunk is a 4-byte big-endian length prefix followed by
          // that many bytes; a zero-length chunk terminates the stream.
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
        }
      });
    });
  }

  #requestStream(body: AsyncIterable<Uint8Array>, expectedBytes: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const responseChunks: Buffer[] = [];
      let settled = false;
      const finish = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error === null) resolve(Buffer.concat(responseChunks).toString("utf8"));
        else reject(error);
      };
      socket.setTimeout(this.#timeoutMs);
      socket.once("timeout", () =>
        finish(new Error(`clamd request timed out after ${String(this.#timeoutMs)}ms`)),
      );
      socket.once("error", finish);
      socket.on("data", (chunk: Buffer) => responseChunks.push(chunk));
      socket.once("end", () => finish(null));
      socket.connect(this.#port, this.#host, () => {
        void (async () => {
          await writeSocket(socket, Buffer.from("zINSTREAM\0"));
          let written = 0;
          for await (const input of body) {
            for (let offset = 0; offset < input.byteLength; offset += CLAMD_CHUNK_SIZE) {
              const chunk = input.subarray(offset, offset + CLAMD_CHUNK_SIZE);
              written += chunk.byteLength;
              if (written > expectedBytes || written > this.#maxMessageBytes) {
                throw new Error("ClamAV stream exceeded its declared size");
              }
              const prefix = Buffer.allocUnsafe(4);
              prefix.writeUInt32BE(chunk.byteLength);
              await writeSocket(socket, prefix);
              await writeSocket(socket, chunk);
            }
          }
          if (written !== expectedBytes) {
            throw new Error("ClamAV stream size did not match its declared size");
          }
          await writeSocket(socket, Buffer.alloc(4));
        })().catch((error: unknown) =>
          finish(error instanceof Error ? error : new Error(String(error))),
        );
      });
    });
  }
}

async function writeSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  if (!socket.write(bytes)) await once(socket, "drain");
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
