import { createOutboundHttpClient, OutboundHttpError } from "../../outbound-http.js";
import { isRecord } from "../../util/json.js";
import {
  decisionModelEndpoint,
  decisionProviderLabel,
  type DecisionModelProviderId,
  type ResolvedDecisionModelConfig,
} from "./config.js";
import {
  DecisionModelError,
  parseSystemOneResponse,
  systemOneRequestBody,
  validateDecisionRequest,
  type DecisionRequest,
  type DecisionResult,
} from "./protocol.js";

/**
 * Decision-model provider adapters. Both hosted providers speak the System
 * One protocol; they differ only in URL, envelope, and error shape:
 *
 * - `typesafe`: `POST {baseUrl}/v1/systemone` (TypeSafe Jev; with a base-URL
 *   override also OpenRouter or a self-hosted SGLang server).
 * - `cloudflare`: `POST …/ai/run/@cf/cloudflare/{model}` (Workers AI Clef). The
 *   body repeats `model`, and responses may be wrapped in `{result, success,
 *   errors, messages}`.
 *
 * Every call goes through the hardened outbound client with the provider's
 * exact host as the only allowed destination.
 */

export interface DecisionModelProvider {
  readonly id: DecisionModelProviderId;
  readonly model: string;
  decide(request: DecisionRequest): Promise<DecisionResult>;
}

export interface DecisionProviderOptions {
  /** Defaults to an outbound client that only reaches the configured host. */
  readonly fetch?: typeof fetch | undefined;
  /** Retries after the first attempt (429/529/5xx/408/network). Default 2. */
  readonly maxRetries?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_RETRY_DELAY_MS = 5_000;

export function createDecisionModelProvider(
  config: ResolvedDecisionModelConfig,
  credential: string,
  options: DecisionProviderOptions = {},
): DecisionModelProvider {
  const endpoint = decisionModelEndpoint(config);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl =
    options.fetch ??
    createOutboundHttpClient({
      allowedHosts: [endpoint.hostname],
      allowHttp: false,
      allowPrivateNetwork: false,
      timeoutMs,
      maxRequestBytes: MAX_RESPONSE_BYTES,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      maxRedirects: 0,
    });
  const label = decisionProviderLabel(config.provider);
  return {
    id: config.provider,
    model: config.model,
    async decide(request) {
      validateDecisionRequest(request);
      const body = systemOneRequestBody(request, config.model);
      const { payload, requestId } = await postWithRetry({
        url: endpoint,
        body: JSON.stringify(body),
        credential,
        fetchImpl,
        timeoutMs,
        maxRetries: options.maxRetries ?? 2,
        sleep: options.sleep ?? defaultSleep,
        describeError: (status, errorBody) =>
          config.provider === "cloudflare"
            ? cloudflareError(status, errorBody)
            : typesafeError(label, status, errorBody),
      });
      const unwrapped = config.provider === "cloudflare" ? unwrapCloudflare(payload) : payload;
      const result = parseSystemOneResponse(request, unwrapped, config.model);
      return requestId === undefined ? result : { ...result, requestId };
    },
  };
}

export interface DecisionProbeResult {
  readonly ok: true;
  readonly latencyMs: number;
  readonly model: string;
  readonly answer: string | boolean | null;
  readonly confidence: number | null;
}

/** "Test connection": one tiny synthetic request with one question. */
export async function probeDecisionModel(
  provider: DecisionModelProvider,
  now: () => number = Date.now,
): Promise<DecisionProbeResult> {
  const started = now();
  const result = await provider.decide({
    state:
      "Subject: Team lunch on Friday\n\nHi all, lunch is at noon in the usual place. See you there.",
    instructions: "Classify this short internal email.",
    questions: {
      verdict: {
        type: "choice",
        instructions: "Is this email legitimate or spam?",
        criteria: { legitimate: "Ordinary, expected mail", spam: "Unsolicited bulk mail" },
      },
    },
  });
  const answer = result.answers.verdict;
  return {
    ok: true,
    latencyMs: Math.max(0, Math.round(now() - started)),
    model: result.model,
    answer: answer?.answer ?? null,
    confidence: answer?.confidence ?? null,
  };
}

async function postWithRetry(input: {
  readonly url: URL;
  readonly body: string;
  readonly credential: string;
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly describeError: (status: number, body: unknown) => DecisionModelError;
}): Promise<{ readonly payload: unknown; readonly requestId?: string }> {
  for (let attempt = 0; ; attempt += 1) {
    let retryAfterMs: number | undefined;
    let failure: DecisionModelError;
    try {
      const response = await input.fetchImpl(input.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${input.credential}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: input.body,
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      const payload = await readJson(response);
      const requestId =
        response.headers.get("x-typesafe-request-id") ?? response.headers.get("cf-ray");
      if (response.ok) {
        return requestId === null ? { payload } : { payload, requestId };
      }
      failure = input.describeError(response.status, payload);
      retryAfterMs = retryAfter(response.headers.get("retry-after"));
    } catch (error) {
      failure = transportError(error);
    }
    if (!failure.retryable || attempt >= input.maxRetries) throw failure;
    const backoff = Math.min(MAX_RETRY_DELAY_MS, 500 * 2 ** attempt);
    await input.sleep(Math.min(MAX_RETRY_DELAY_MS, retryAfterMs ?? backoff));
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    if (response.ok) {
      throw new DecisionModelError(
        "invalid_response",
        "The decision model returned a response that is not JSON.",
      );
    }
    return null;
  }
}

function transportError(error: unknown): DecisionModelError {
  if (error instanceof DecisionModelError) return error;
  if (error instanceof OutboundHttpError) {
    if (error.code === "blocked_destination" || error.code === "invalid_url") {
      return new DecisionModelError(
        "blocked_destination",
        "The decision model endpoint is not an allowed public HTTPS destination. Check the provider base URL.",
      );
    }
    if (error.code === "aborted") {
      return new DecisionModelError("timeout", "The decision model did not answer in time.", {
        retryable: true,
      });
    }
    if (error.code === "response_too_large" || error.code === "request_too_large") {
      return new DecisionModelError(
        "invalid_response",
        "The decision model response is too large.",
      );
    }
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return new DecisionModelError("timeout", "The decision model did not answer in time.", {
      retryable: true,
    });
  }
  return new DecisionModelError(
    "provider_unavailable",
    "The decision model provider could not be reached.",
    { retryable: true },
  );
}

/** Status mapping shared by both providers; `detail` supplies vendor text when safe. */
function statusError(
  status: number,
  messages: { readonly auth: string; readonly detail?: string | undefined },
): DecisionModelError {
  const suffix = messages.detail === undefined ? "" : ` (${messages.detail})`;
  if (status === 401 || status === 403) {
    return new DecisionModelError("authentication", messages.auth, { status });
  }
  if (status === 429) {
    return new DecisionModelError(
      "rate_limited",
      "The decision model provider is rate limiting requests; try again later.",
      { status, retryable: true },
    );
  }
  if (status === 529 || status === 503) {
    return new DecisionModelError(
      "overloaded",
      "The decision model provider is overloaded; try again later.",
      { status, retryable: true },
    );
  }
  if (status === 408 || status >= 500) {
    return new DecisionModelError(
      "provider_unavailable",
      `The decision model provider failed with HTTP ${String(status)}.`,
      { status, retryable: true },
    );
  }
  return new DecisionModelError(
    "invalid_request",
    `The decision model rejected the request with HTTP ${String(status)}${suffix}.`,
    { status },
  );
}

function typesafeError(label: string, status: number, body: unknown): DecisionModelError {
  return statusError(status, {
    auth: `${label} rejected the API key (HTTP ${String(status)}). Create a key at console.typesafe.ai/keys (or your gateway) and save it again.`,
    detail: typesafeDetail(body),
  });
}

/** FastAPI `detail`: an array of validation errors or `{error_type, message}`. */
function typesafeDetail(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const detail = body.detail;
  if (Array.isArray(detail)) {
    const first: unknown = detail[0];
    if (isRecord(first) && typeof first.msg === "string") {
      const location = Array.isArray(first.loc) ? first.loc.map(String).join(".") : "";
      return boundedText(location.length > 0 ? `${location}: ${first.msg}` : first.msg);
    }
    return undefined;
  }
  if (isRecord(detail) && typeof detail.message === "string") return boundedText(detail.message);
  if (isRecord(body.error) && typeof body.error.message === "string") {
    return boundedText(body.error.message);
  }
  return typeof body.message === "string" ? boundedText(body.message) : undefined;
}

function cloudflareError(status: number, body: unknown): DecisionModelError {
  const first =
    isRecord(body) && Array.isArray(body.errors) && isRecord(body.errors[0])
      ? body.errors[0]
      : undefined;
  const code = typeof first?.code === "number" ? first.code : undefined;
  const message = typeof first?.message === "string" ? boundedText(first.message) : undefined;
  if (status < 400 && code !== 10000) {
    return new DecisionModelError(
      "invalid_response",
      `Cloudflare returned an unsuccessful result${message === undefined ? "" : ` (${message})`}.`,
    );
  }
  return statusError(status < 400 ? 401 : status, {
    auth: `Cloudflare rejected the API token${code === undefined ? "" : ` (code ${String(code)})`}. Use a token with Workers AI Read and Edit permissions for this account.`,
    detail: message,
  });
}

/** Accept both the REST envelope `{result, success, errors}` and an unwrapped body. */
function unwrapCloudflare(payload: unknown): unknown {
  if (!isRecord(payload) || !("result" in payload)) return payload;
  if (payload.success === false || !isRecord(payload.result)) {
    throw cloudflareError(200, payload);
  }
  return payload.result;
}

function retryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function boundedText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 200);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
