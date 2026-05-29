import type {
  ToolInvokeErrorResult,
  ToolQuotaLimitMetadata,
  ToolRateLimitMetadata,
} from "../platform/tool-registry.js";

/**
 * The single canonical error response shape returned across every REST and
 * tool-invocation surface (P1-10). A unified envelope means clients can parse
 * one shape, and every error carries a `traceId` for support correlation.
 */
export interface HelixErrorEnvelope {
  readonly error: {
    /** Stable machine-readable error code, e.g. `tool_not_found`. */
    readonly code: string;
    /** Human-readable message. */
    readonly message: string;
    /** Trace identifier for correlating logs/spans with this failure. */
    readonly traceId: string;
    /** Optional structured detail (rate-limit metadata, retry hints, …). */
    readonly details?: Record<string, unknown>;
  };
}

const statusCodeToErrorCode: Record<number, string> = {
  400: "bad_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  410: "gone",
  429: "rate_limited",
  500: "internal_error",
};

/** Maps an HTTP status code to a stable error code token. */
export function errorCodeForStatus(statusCode: number): string {
  return statusCodeToErrorCode[statusCode] ?? "error";
}

/** Builds the canonical error envelope. */
export function buildErrorEnvelope(input: {
  readonly statusCode: number;
  readonly message: string;
  readonly traceId: string;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
}): HelixErrorEnvelope {
  return {
    error: {
      code: input.code ?? errorCodeForStatus(input.statusCode),
      message: input.message,
      traceId: input.traceId,
      ...(input.details === undefined ? {} : { details: input.details }),
    },
  };
}

/** Converts a failed tool-registry result into the canonical envelope. */
export function toolErrorEnvelope(
  result: ToolInvokeErrorResult,
  traceId: string,
): HelixErrorEnvelope {
  const details: Record<string, unknown> = {};
  if (result.retryAfterSeconds !== undefined) {
    details.retryAfterSeconds = result.retryAfterSeconds;
  }
  if (result.rateLimit !== undefined) {
    details.rateLimit = result.rateLimit satisfies ToolRateLimitMetadata;
  }
  if (result.quotaLimit !== undefined) {
    details.quotaLimit = result.quotaLimit satisfies ToolQuotaLimitMetadata;
  }
  return buildErrorEnvelope({
    statusCode: result.statusCode,
    message: result.error,
    traceId,
    ...(Object.keys(details).length === 0 ? {} : { details }),
  });
}
