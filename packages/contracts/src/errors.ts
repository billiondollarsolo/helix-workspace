import { z } from "zod";

/**
 * Canonical client-facing error codes.
 * Preserves existing helix error-envelope mappings (incl. `unauthenticated`,
 * `gone`, `method_not_allowed`, fallback `error`) and adds plan aliases
 * (`unauthorized`, `unprocessable`, `internal_error`).
 */
export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "unauthenticated",
  "forbidden",
  "not_found",
  "method_not_allowed",
  "conflict",
  "gone",
  "unprocessable",
  "rate_limited",
  "internal_error",
  "error",
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: "bad_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  405: "method_not_allowed",
  409: "conflict",
  410: "gone",
  422: "unprocessable",
  429: "rate_limited",
  500: "internal_error",
};

const CODE_TO_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409,
  gone: 410,
  unprocessable: 422,
  rate_limited: 429,
  internal_error: 500,
  // Legacy fallback code used by errorCodeForStatus for unknown statuses.
  error: 500,
};

export function errorCodeForStatus(status: number): ErrorCode {
  return STATUS_TO_CODE[status] ?? "error";
}

export function statusForErrorCode(code: ErrorCode): number {
  return CODE_TO_STATUS[code];
}

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    traceId: z.string().optional(),
    details: z.unknown().optional(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;
