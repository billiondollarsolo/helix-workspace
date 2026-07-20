import type { ErrorCode } from "@helix/contracts";
import { statusForErrorCode } from "@helix/contracts";

export interface ApiErrorOptions {
  details?: unknown;
  retryAfterSeconds?: number;
  cause?: unknown;
}

/**
 * Base class for all client-visible Helix API errors. The central Fastify
 * error handler renders these into the canonical error envelope.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  readonly retryAfterSeconds?: number;

  constructor(code: ErrorCode, message: string, options: ApiErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.code = code;
    this.statusCode = statusForErrorCode(code);
    if (options.details !== undefined) this.details = options.details;
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

export class BadRequestError extends ApiError {
  constructor(message: string, o?: ApiErrorOptions) {
    super("bad_request", message, o);
    this.name = "BadRequestError";
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message: string, o?: ApiErrorOptions) {
    super("unauthenticated", message, o);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends ApiError {
  constructor(message: string, o?: ApiErrorOptions) {
    super("forbidden", message, o);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends ApiError {
  constructor(message: string, o?: ApiErrorOptions) {
    super("not_found", message, o);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends ApiError {
  constructor(message: string, o?: ApiErrorOptions) {
    super("conflict", message, o);
    this.name = "ConflictError";
  }
}

export class RateLimitedError extends ApiError {
  constructor(message: string, o?: ApiErrorOptions) {
    super("rate_limited", message, o);
    this.name = "RateLimitedError";
  }
}

export class UnprocessableError extends ApiError {
  constructor(message: string, o?: ApiErrorOptions) {
    super("unprocessable", message, o);
    this.name = "UnprocessableError";
  }
}
