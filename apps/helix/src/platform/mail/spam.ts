import { Socket } from "node:net";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { JsonObject } from "@helix/sdk-types";

/**
 * SpamAssassin `spamd` integration.
 *
 * `spamd` speaks a small line-oriented protocol over TCP (the SPAMC/1.5
 * protocol). The {@link SpamdScanner} sends a `SYMBOLS` request carrying the
 * full RFC822 message and parses the `Spam:` response header plus the symbol
 * report body.
 *
 * Inbound ingest scores every received message; messages whose score meets or
 * exceeds the configured threshold are routed to the Spam folder. The hook is
 * config-gated exactly like the antivirus hook — when `MAIL_SPAMD_ENABLED` is
 * not set the scanner is never constructed and ingest skips scoring.
 */

/** Verdict from a single spamd scan. */
export interface SpamScanResult {
  /** SpamAssassin numeric score for the message. */
  readonly score: number;
  /** Threshold spamd itself reports (informational; routing uses the config threshold). */
  readonly thresholdReportedBySpamd: number | null;
  /** True when {@link score} meets or exceeds the configured routing threshold. */
  readonly isSpam: boolean;
  /** Triggered SpamAssassin rule symbols (e.g. `BAYES_99`, `HTML_MESSAGE`). */
  readonly symbols: readonly string[];
  /** Structured evidence persisted on the message metadata. */
  readonly evidence: JsonObject;
}

/** Pluggable spam scanner. Inbound ingest calls {@link SpamScanner.scan}. */
export interface SpamScanner {
  scan(raw: Buffer | string): Promise<SpamScanResult>;
}

export interface SpamdScannerOptions {
  readonly host: string;
  readonly port: number;
  /** Routing threshold — score >= threshold routes the message to Spam. */
  readonly threshold: number;
  /** Per-scan socket timeout in milliseconds. Defaults to 10s. */
  readonly timeoutMs?: number;
  /** Maximum message size sent to spamd, in bytes. Defaults to 25 MiB. */
  readonly maxMessageBytes?: number;
}

const DEFAULT_SPAMD_TIMEOUT_MS = 10_000;
const DEFAULT_SPAMD_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_SPAMD_PORT = 783;
const DEFAULT_SPAMD_THRESHOLD = 5;

/**
 * Spam scanner backed by a SpamAssassin `spamd` daemon over TCP.
 *
 * Scanning is best-effort from ingest's point of view: a daemon outage or
 * timeout surfaces as a thrown error that the ingest pipeline catches and
 * treats as "unscored" rather than failing the message.
 */
export class SpamdScanner implements SpamScanner {
  readonly #host: string;
  readonly #port: number;
  readonly #threshold: number;
  readonly #timeoutMs: number;
  readonly #maxMessageBytes: number;

  constructor(options: SpamdScannerOptions) {
    this.#host = options.host;
    this.#port = options.port;
    this.#threshold = options.threshold;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_SPAMD_TIMEOUT_MS;
    this.#maxMessageBytes = options.maxMessageBytes ?? DEFAULT_SPAMD_MAX_BYTES;
  }

  get threshold(): number {
    return this.#threshold;
  }

  async scan(raw: Buffer | string): Promise<SpamScanResult> {
    return trace.getTracer("helix.mail").startActiveSpan("spamd.check", async (span) => {
      try {
        const body = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (body.byteLength > this.#maxMessageBytes) {
          // spamd silently truncates oversized messages; skip rather than score a partial body.
          const result: SpamScanResult = {
            score: 0,
            thresholdReportedBySpamd: null,
            isSpam: false,
            symbols: [],
            evidence: {
              scanned: false,
              reason: "message exceeds spamd max size",
              byteSize: body.byteLength,
            },
          };
          span.setAttribute("helix.mail.spam_scanned", false);
          return result;
        }
        const response = await this.#request(body);
        const parsed = parseSpamdResponse(response);
        const isSpam = parsed.score >= this.#threshold;
        span.setAttribute("helix.mail.spam_score", parsed.score);
        span.setAttribute("helix.mail.spam_is_spam", isSpam);
        return {
          score: parsed.score,
          thresholdReportedBySpamd: parsed.threshold,
          isSpam,
          symbols: parsed.symbols,
          evidence: {
            scanned: true,
            score: parsed.score,
            threshold: this.#threshold,
            spamdThreshold: parsed.threshold,
            isSpam,
            symbols: [...parsed.symbols],
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

  #request(body: Buffer): Promise<string> {
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
        finish(new Error(`spamd request timed out after ${String(this.#timeoutMs)}ms`));
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
        // SPAMC/1.5 SYMBOLS request: returns the score header plus the list of
        // triggered rule symbols. Headers are CRLF-delimited; a blank line ends
        // the header block. spamd reads exactly `Content-length` body bytes, so
        // the connection is left open for the bidirectional reply.
        const header = [
          "SYMBOLS SPAMC/1.5",
          `Content-length: ${String(body.byteLength)}`,
          "",
          "",
        ].join("\r\n");
        socket.write(header);
        socket.write(body);
      });
    });
  }
}

interface ParsedSpamdResponse {
  readonly score: number;
  readonly threshold: number | null;
  readonly symbols: readonly string[];
}

/**
 * Parse a spamd `SYMBOLS` response.
 *
 * Example:
 * ```
 * SPAMD/1.1 0 EX_OK
 * Content-length: 56
 * Spam: True ; 8.3 / 5.0
 *
 * BAYES_99,HTML_MESSAGE,RDNS_NONE
 * ```
 */
export function parseSpamdResponse(response: string): ParsedSpamdResponse {
  const normalized = response.replace(/\r\n/gu, "\n");
  const separator = normalized.indexOf("\n\n");
  const headerBlock = separator === -1 ? normalized : normalized.slice(0, separator);
  const body = separator === -1 ? "" : normalized.slice(separator + 2);

  const statusLine = headerBlock.split("\n")[0] ?? "";
  if (!/^SPAMD\//u.test(statusLine)) {
    throw new Error(`Unexpected spamd response: ${statusLine.slice(0, 80)}`);
  }
  const exCode = statusLine.split(/\s+/u)[1];
  if (exCode !== undefined && exCode !== "0" && exCode !== "EX_OK") {
    throw new Error(`spamd returned error status: ${statusLine.trim()}`);
  }

  const spamHeader = headerBlock.split("\n").find((line) => /^spam:/iu.test(line));
  if (spamHeader === undefined) {
    throw new Error("spamd response is missing the Spam header");
  }
  // `Spam: True ; 8.3 / 5.0`
  const match = /^spam:\s*\w+\s*;\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/iu.exec(
    spamHeader,
  );
  if (match === null) {
    throw new Error(`Unparseable spamd Spam header: ${spamHeader.trim()}`);
  }
  const score = Number.parseFloat(match[1] ?? "0");
  const threshold = match[2] === undefined ? null : Number.parseFloat(match[2]);

  const symbols = body
    .replace(/\n/gu, ",")
    .split(",")
    .map((symbol) => symbol.trim())
    .filter((symbol) => symbol.length > 0);

  return {
    score: Number.isFinite(score) ? score : 0,
    threshold: threshold !== null && Number.isFinite(threshold) ? threshold : null,
    symbols,
  };
}

/**
 * Resolve a {@link SpamdScanner} from the environment. Returns `undefined`
 * (scanning disabled) unless `MAIL_SPAMD_ENABLED` is truthy — matching the
 * config-gated ClamAV antivirus hook.
 *
 *   MAIL_SPAMD_ENABLED    enable inbound spam scoring
 *   MAIL_SPAMD_HOST       spamd host (default `spamd`)
 *   MAIL_SPAMD_PORT       spamd port (default 783)
 *   MAIL_SPAMD_THRESHOLD  routing threshold (default 5.0)
 *   MAIL_SPAMD_TIMEOUT_MS per-scan socket timeout (default 10000)
 */
export function getSpamdScannerConfig(env: NodeJS.ProcessEnv): SpamdScannerOptions | undefined {
  if (!envFlag(env.MAIL_SPAMD_ENABLED)) {
    return undefined;
  }
  const host = env.MAIL_SPAMD_HOST ?? "spamd";
  const port = parsePositiveInt(env.MAIL_SPAMD_PORT) ?? DEFAULT_SPAMD_PORT;
  const threshold = parseFloatConfig(env.MAIL_SPAMD_THRESHOLD) ?? DEFAULT_SPAMD_THRESHOLD;
  const timeoutMs = parsePositiveInt(env.MAIL_SPAMD_TIMEOUT_MS);
  return {
    host,
    port,
    threshold,
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

function parseFloatConfig(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
