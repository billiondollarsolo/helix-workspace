import { Socket } from "node:net";
import { securityScanResultSchema, type SecurityScanResult } from "@helix/contracts";
import { safelyRecordSecurityMetric, type SecurityScanningMetrics } from "./metrics.js";

export type SecurityScanInput = string | Uint8Array | AsyncIterable<Uint8Array>;

export interface ClamdInstreamClientOptions {
  readonly host: string;
  readonly port: number;
  /** Absolute per-scan deadline. Defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /** Maximum bytes accepted from the source. Defaults to 25 MiB. */
  readonly maxBytes?: number;
  /** Maximum INSTREAM frame payload. Defaults to 64 KiB. */
  readonly chunkSizeBytes?: number;
  /** Maximum daemon response retained in memory. Defaults to 8 KiB. */
  readonly maxResponseBytes?: number;
  /** Safe scanner identity persisted with verdict evidence. */
  readonly scannerName?: string;
  /** Definition/engine version supplied by deployment discovery, if known. */
  readonly scannerVersion?: string;
  readonly metrics?: SecurityScanningMetrics;
  /** Injectable clock for deterministic contract tests. */
  readonly now?: () => Date;
}

export interface ClamdParsedVerdict {
  readonly infected: boolean;
  readonly signature: string | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_CHUNK_SIZE_BYTES = 64 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024;
const MAX_INSTREAM_CHUNK_BYTES = 1024 * 1024;
const CLAMD_INSTREAM_COMMAND = Buffer.from("zINSTREAM\0", "ascii");
const CLAMD_STREAM_TERMINATOR = Buffer.alloc(4);

type ClamdFailureCode =
  | "aborted"
  | "configuration"
  | "daemon_error"
  | "input_error"
  | "max_bytes"
  | "protocol_error"
  | "response_too_large"
  | "timeout"
  | "transport_error";

export class ClamdClientError extends Error {
  readonly code: ClamdFailureCode;

  constructor(code: ClamdFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ClamdClientError";
    this.code = code;
  }
}

/**
 * A domain-neutral, bounded implementation of clamd's INSTREAM protocol.
 *
 * Expected scanner and source failures return the shared terminal contract
 * instead of leaking socket details. Programming/configuration errors are
 * rejected in the constructor.
 */
export class ClamdInstreamClient {
  readonly #host: string;
  readonly #port: number;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #chunkSizeBytes: number;
  readonly #maxResponseBytes: number;
  readonly #scannerName: string;
  readonly #scannerVersion: string;
  readonly #metrics: SecurityScanningMetrics | undefined;
  readonly #now: () => Date;

  constructor(options: ClamdInstreamClientOptions) {
    this.#host = nonEmpty(options.host, "host");
    this.#port = positiveInteger(options.port, "port");
    this.#timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.#maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes");
    this.#chunkSizeBytes = positiveInteger(
      options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES,
      "chunkSizeBytes",
    );
    if (this.#chunkSizeBytes > MAX_INSTREAM_CHUNK_BYTES) {
      throw new ClamdClientError(
        "configuration",
        `chunkSizeBytes must be at most ${String(MAX_INSTREAM_CHUNK_BYTES)}.`,
      );
    }
    this.#maxResponseBytes = positiveInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
    this.#scannerName = scannerIdentity(options.scannerName ?? "clamav", "scannerName");
    this.#scannerVersion = scannerIdentity(options.scannerVersion ?? "unknown", "scannerVersion");
    this.#metrics = options.metrics;
    this.#now = options.now ?? (() => new Date());
  }

  async scan(
    input: SecurityScanInput,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<SecurityScanResult> {
    const started = this.#now();
    const startedMonotonic = performance.now();
    let byteSize = 0;
    let available: boolean | undefined;
    let result: SecurityScanResult;

    try {
      const knownByteSize = byteSizeOf(input);
      if (knownByteSize !== undefined && knownByteSize > this.#maxBytes) {
        byteSize = knownByteSize;
        throw new ClamdClientError(
          "max_bytes",
          "Security scan input exceeded the configured byte limit.",
        );
      }
      const response = await this.#request(
        input,
        (observedBytes) => {
          byteSize = observedBytes;
        },
        options.signal,
      );
      const verdict = parseClamdInstreamResponse(response);
      available = true;
      result = verdict.infected
        ? createResult({
            state: "infected",
            scannerName: this.#scannerName,
            scannerVersion: this.#scannerVersion,
            started,
            completed: this.#now(),
            byteSize,
            signature: verdict.signature ?? "unknown",
          })
        : createResult({
            state: "clean",
            scannerName: this.#scannerName,
            scannerVersion: this.#scannerVersion,
            started,
            completed: this.#now(),
            byteSize,
          });
    } catch (error) {
      const failure = normalizeFailure(error);
      available = scannerAvailability(failure.code);
      result = createResult({
        state: failure.code === "max_bytes" ? "unsupported" : "scan_failed",
        scannerName: this.#scannerName,
        scannerVersion: this.#scannerVersion,
        started,
        completed: this.#now(),
        byteSize,
      });
    }

    const durationSeconds = Math.max(0, (performance.now() - startedMonotonic) / 1000);
    safelyRecordSecurityMetric(() => {
      this.#metrics?.recordSecurityScan({
        scannerName: this.#scannerName,
        state: result.state,
        durationSeconds,
        byteSize: result.evidence.byteSize,
      });
    });
    if (available !== undefined) {
      safelyRecordSecurityMetric(() => {
        this.#metrics?.setSecurityScannerAvailable({
          scannerName: this.#scannerName,
          available,
        });
      });
    }
    return result;
  }

  #request(
    input: SecurityScanInput,
    onByteSize: (byteSize: number) => void,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const responseChunks: Buffer[] = [];
      let responseBytes = 0;
      let settled = false;

      const finish = (error: Error | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
        socket.destroy();
        if (error === null) {
          resolve(Buffer.concat(responseChunks).toString("utf8"));
        } else {
          reject(error);
        }
      };

      const abort = (): void => {
        finish(new ClamdClientError("aborted", "clamd scan was aborted."));
      };
      const deadline = setTimeout(() => {
        finish(
          new ClamdClientError(
            "timeout",
            `clamd scan exceeded its ${String(this.#timeoutMs)}ms deadline.`,
          ),
        );
      }, this.#timeoutMs);

      if (signal?.aborted === true) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });

      socket.once("error", (error: Error) => {
        finish(
          new ClamdClientError("transport_error", "clamd transport failed.", {
            cause: error,
          }),
        );
      });
      socket.on("data", (chunk: Buffer) => {
        responseBytes += chunk.byteLength;
        if (responseBytes > this.#maxResponseBytes) {
          finish(
            new ClamdClientError(
              "response_too_large",
              "clamd response exceeded the configured limit.",
            ),
          );
          return;
        }
        responseChunks.push(chunk);
      });
      socket.once("end", () => {
        finish(null);
      });

      socket.connect(this.#port, this.#host, () => {
        void this.#writeRequest(socket, input, onByteSize).catch((error: unknown) => {
          finish(normalizeFailure(error));
        });
      });
    });
  }

  async #writeRequest(
    socket: Socket,
    input: SecurityScanInput,
    onByteSize: (byteSize: number) => void,
  ): Promise<void> {
    await writeSocket(socket, CLAMD_INSTREAM_COMMAND);
    let byteSize = 0;

    for await (const sourceChunk of toAsyncBytes(input)) {
      if (!(sourceChunk instanceof Uint8Array)) {
        throw new ClamdClientError("input_error", "Security scan input yielded a non-byte chunk.");
      }
      for (let offset = 0; offset < sourceChunk.byteLength; offset += this.#chunkSizeBytes) {
        const chunk = sourceChunk.subarray(
          offset,
          Math.min(sourceChunk.byteLength, offset + this.#chunkSizeBytes),
        );
        if (byteSize + chunk.byteLength > this.#maxBytes) {
          throw new ClamdClientError(
            "max_bytes",
            "Security scan input exceeded the configured byte limit.",
          );
        }
        byteSize += chunk.byteLength;
        onByteSize(byteSize);
        const prefix = Buffer.allocUnsafe(4);
        prefix.writeUInt32BE(chunk.byteLength, 0);
        await writeSocket(socket, prefix);
        await writeSocket(socket, chunk);
      }
    }
    await endSocket(socket, CLAMD_STREAM_TERMINATOR);
  }
}

/**
 * Parse the clamd INSTREAM response without retaining any submitted content.
 */
export function parseClamdInstreamResponse(response: string): ClamdParsedVerdict {
  const trimmed = response.replace(/\0/gu, "").trim();
  if (/\bERROR$/u.test(trimmed)) {
    throw new ClamdClientError("daemon_error", "clamd rejected the scan request.");
  }
  if (/\bOK$/u.test(trimmed)) {
    return { infected: false, signature: null };
  }
  const found = /:\s*(.+?)\s+FOUND$/u.exec(trimmed);
  if (found !== null) {
    return {
      infected: true,
      signature: sanitizeSignature(found[1] ?? "unknown"),
    };
  }
  throw new ClamdClientError("protocol_error", "clamd returned an unparseable response.");
}

function createResult(
  input:
    | {
        readonly state: "clean" | "scan_failed" | "unsupported";
        readonly scannerName: string;
        readonly scannerVersion: string;
        readonly started: Date;
        readonly completed: Date;
        readonly byteSize: number;
      }
    | {
        readonly state: "infected";
        readonly scannerName: string;
        readonly scannerVersion: string;
        readonly started: Date;
        readonly completed: Date;
        readonly byteSize: number;
        readonly signature: string;
      },
): SecurityScanResult {
  const completed =
    input.completed.getTime() < input.started.getTime() ? input.started : input.completed;
  return securityScanResultSchema.parse({
    state: input.state,
    evidence: {
      scannerName: input.scannerName,
      scannerVersion: input.scannerVersion,
      startedAt: input.started.toISOString(),
      completedAt: completed.toISOString(),
      byteSize: input.byteSize,
      ...(input.state === "infected" ? { signature: input.signature } : {}),
    },
  });
}

function normalizeFailure(error: unknown): ClamdClientError {
  if (error instanceof ClamdClientError) {
    return error;
  }
  return new ClamdClientError("input_error", "Security scan input failed.", {
    cause: error,
  });
}

function scannerAvailability(code: ClamdFailureCode): boolean | undefined {
  switch (code) {
    case "daemon_error":
    case "protocol_error":
    case "response_too_large":
      return true;
    case "timeout":
    case "transport_error":
      return false;
    case "aborted":
    case "configuration":
    case "input_error":
    case "max_bytes":
      return undefined;
  }
}

async function* toAsyncBytes(input: SecurityScanInput): AsyncIterable<Uint8Array> {
  if (typeof input === "string") {
    yield Buffer.from(input);
    return;
  }
  if (input instanceof Uint8Array) {
    yield input;
    return;
  }
  yield* input;
}

function byteSizeOf(input: SecurityScanInput): number | undefined {
  if (typeof input === "string") {
    return Buffer.byteLength(input);
  }
  return input instanceof Uint8Array ? input.byteLength : undefined;
}

function writeSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(bytes, (error?: Error | null) => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function endSocket(socket: Socket, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.end(bytes, (error?: Error | null) => {
      if (error !== undefined && error !== null) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ClamdClientError("configuration", `${label} must be a positive safe integer.`);
  }
  return value;
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ClamdClientError("configuration", `${label} must not be empty.`);
  }
  return normalized;
}

function scannerIdentity(value: string, label: string): string {
  const normalized = nonEmpty(value, label);
  if (normalized.length > 128) {
    throw new ClamdClientError("configuration", `${label} must be at most 128 characters.`);
  }
  return normalized;
}

function sanitizeSignature(value: string): string {
  const normalized = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, 512);
  return normalized.length === 0 ? "unknown" : normalized;
}
