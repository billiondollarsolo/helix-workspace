import { CliUsageError } from "./parser.js";

/** Documented process exit codes (see `helix --help`). */
export const EXIT_CODES = {
  ok: 0,
  generic: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  rateLimited: 5,
  pendingConfirmation: 6,
  network: 7,
} as const;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** A non-2xx Helix API response, carried to the top-level error reporter. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Helix API request failed (${String(status)}).`);
    this.name = "HttpError";
  }
}

/** The request never produced a response: DNS, TLS, connection reset, or timeout. */
export class NetworkError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "NetworkError";
  }
}

export interface RequestPolicy {
  /** Per-attempt timeout in milliseconds. */
  readonly timeoutMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

interface SendOptions {
  /**
   * The request is safe to repeat (a read, a tool call carrying an
   * Idempotency-Key, or a storage PUT), so 503s and network errors retry too.
   * 429 is always retried: the server did not process the request.
   */
  readonly idempotent: boolean;
  /** Overrides the per-attempt timeout, e.g. for size-proportional uploads. */
  readonly timeoutMs?: number;
  /** Also retry 500/502/504 (storage PUTs). */
  readonly retryServerErrors?: boolean;
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;
const MAX_RETRY_AFTER_MS = 60_000;

export interface HttpClient {
  readonly policy: RequestPolicy;
  send(url: string, init: RequestInit, options: SendOptions): Promise<Response>;
}

/** Reads a response body, reporting a timeout or reset mid-body as a network error. */
async function readResponseText(response: Response, timeoutMs: number): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw toNetworkError(error, timeoutMs);
  }
}

/** Sends a Helix API request, throwing {@link HttpError} for non-2xx responses. */
export async function sendForText(
  request: { readonly url: string; readonly init: RequestInit },
  context: { readonly http: HttpClient },
  idempotent: boolean,
): Promise<{ readonly status: number; readonly body: string }> {
  const response = await context.http.send(request.url, request.init, { idempotent });
  const body = await readResponseText(response, context.http.policy.timeoutMs);
  if (!response.ok) throw new HttpError(response.status, body);
  return { status: response.status, body };
}

export function createHttpClient(fetchImpl: FetchLike, policy: RequestPolicy): HttpClient {
  return {
    policy,
    async send(url, init, options) {
      const timeoutMs = options.timeoutMs ?? policy.timeoutMs;
      for (let attempt = 0; ; attempt += 1) {
        let response: Response;
        try {
          response = await fetchImpl(url, {
            ...init,
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (error) {
          const failure = toNetworkError(error, timeoutMs);
          if (!options.idempotent || attempt >= MAX_RETRIES) throw failure;
          await policy.sleep(backoffMs(attempt));
          continue;
        }
        if (attempt >= MAX_RETRIES || !isRetryableStatus(response.status, options)) {
          return response;
        }
        const retryAfter = retryAfterMs(response.headers.get("retry-after"));
        if (retryAfter !== undefined && retryAfter > MAX_RETRY_AFTER_MS) return response;
        await response.body?.cancel().catch(() => undefined);
        await policy.sleep(retryAfter ?? backoffMs(attempt));
      }
    },
  };
}

function isRetryableStatus(status: number, options: SendOptions): boolean {
  if (status === 429) return true;
  if (!options.idempotent) return false;
  if (status === 503) return true;
  return options.retryServerErrors === true && [500, 502, 504].includes(status);
}

function backoffMs(attempt: number): number {
  return BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 250);
}

/** Parses `Retry-After` as delta-seconds or an HTTP date. */
function retryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null || value.trim().length === 0) return undefined;
  if (/^\d+$/u.test(value.trim())) return Number(value.trim()) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Maps fetch and body-read failures (including timeouts) to a {@link NetworkError}. */
export function toNetworkError(error: unknown, timeoutMs?: number): NetworkError {
  if (error instanceof NetworkError) return error;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    const after = timeoutMs === undefined ? "" : ` after ${String(timeoutMs / 1000)}s`;
    return new NetworkError(
      `Request timed out${after}. Raise the limit with --timeout <seconds> or HELIX_TIMEOUT.`,
      true,
      { cause: error },
    );
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const detail = error instanceof Error ? error.message : String(error);
  return new NetworkError(
    `Network error contacting Helix: ${detail}${cause.length > 0 ? ` (${cause})` : ""}`,
    false,
    { cause: error },
  );
}

function exitCodeForStatus(status: number): number {
  if (status === 401 || status === 403) return EXIT_CODES.auth;
  if (status === 404) return EXIT_CODES.notFound;
  if (status === 429) return EXIT_CODES.rateLimited;
  return EXIT_CODES.generic;
}

export function exitCodeForError(error: unknown): number {
  if (error instanceof CliUsageError) return EXIT_CODES.usage;
  if (error instanceof HttpError) return exitCodeForStatus(error.status);
  if (error instanceof NetworkError) return EXIT_CODES.network;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return EXIT_CODES.network;
  return EXIT_CODES.generic;
}
