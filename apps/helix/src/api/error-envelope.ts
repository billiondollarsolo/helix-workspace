import type {
  ToolInvokeErrorResult,
  ToolQuotaLimitMetadata,
  ToolRateLimitMetadata,
} from "../platform/tool-registry.js";
import {
  ERROR_CODES,
  errorCodeForStatus as contractErrorCodeForStatus,
  statusForErrorCode,
  type ErrorCode,
  type ErrorEnvelope,
} from "@helix/contracts";

export { ERROR_CODES, statusForErrorCode, type ErrorCode };
export type HelixErrorEnvelope = ErrorEnvelope & {
  readonly error: ErrorEnvelope["error"] & {
    readonly traceId: string;
  };
};

/** Maps an HTTP status code to a stable error code token. */
export function errorCodeForStatus(statusCode: number): string {
  return contractErrorCodeForStatus(statusCode);
}

/** Builds the canonical error envelope. */
export function buildErrorEnvelope(input: {
  readonly statusCode: number;
  readonly message: string;
  readonly traceId: string;
  readonly code?: string;
  readonly details?: Record<string, unknown>;
}): HelixErrorEnvelope {
  const code = (input.code ?? errorCodeForStatus(input.statusCode)) as ErrorCode;
  return {
    error: {
      code,
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
