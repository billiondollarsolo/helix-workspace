import {
  errorCodeForStatus as contractErrorCodeForStatus,
  errorCodeSchema,
  type ErrorEnvelope,
} from "@helix/contracts";
import type {
  ToolInvokeErrorResult,
  ToolQuotaLimitMetadata,
  ToolRateLimitMetadata,
} from "../platform/tool-registry.js";
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
  const parsed = errorCodeSchema.safeParse(input.code);
  const code = parsed.success ? parsed.data : contractErrorCodeForStatus(input.statusCode);
  const details = {
    ...input.details,
    ...(!parsed.success && input.code !== undefined ? { domainCode: input.code } : {}),
  };
  return {
    error: {
      code,
      message: input.message,
      traceId: input.traceId,
      ...(Object.keys(details).length === 0 ? {} : { details }),
    },
  };
}

/** Converts a failed tool-registry result into the canonical envelope. */
export function toolErrorEnvelope(
  result: ToolInvokeErrorResult,
  traceId: string,
): HelixErrorEnvelope {
  const details: Record<string, unknown> = { ...result.codeDetails };
  if (result.retryAfterSeconds !== undefined) {
    details.retryAfterSeconds = result.retryAfterSeconds;
  }
  if (result.rateLimit !== undefined) {
    details.rateLimit = result.rateLimit satisfies ToolRateLimitMetadata;
  }
  if (result.quotaLimit !== undefined) {
    details.quotaLimit = result.quotaLimit satisfies ToolQuotaLimitMetadata;
  }
  if (result.details !== undefined) {
    details.issues = result.details.issues;
  }
  return buildErrorEnvelope({
    statusCode: result.statusCode,
    message: result.error,
    traceId,
    ...(result.code === undefined ? {} : { code: result.code }),
    ...(Object.keys(details).length === 0 ? {} : { details }),
  });
}
