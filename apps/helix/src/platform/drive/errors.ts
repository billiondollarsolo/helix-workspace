import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  BadRequestError,
  type ApiErrorOptions,
} from "../../api/api-error.js";

export class DriveNotFoundError extends NotFoundError {
  constructor(message = "Unknown or inaccessible Drive object", o?: ApiErrorOptions) {
    super(message, o);
    this.name = "DriveNotFoundError";
  }
}

export class DriveForbiddenError extends ForbiddenError {
  constructor(message = "Insufficient Drive permission", o?: ApiErrorOptions) {
    super(message, o);
    this.name = "DriveForbiddenError";
  }
}

export class DriveConflictError extends ConflictError {
  constructor(message: string, o?: ApiErrorOptions) {
    super(message, o);
    this.name = "DriveConflictError";
  }
}

export class DriveInvalidStorageKeyError extends BadRequestError {
  constructor(message: string, o?: ApiErrorOptions) {
    super(message, o);
    this.name = "DriveInvalidStorageKeyError";
  }
}

/** Canonical name from the elite plan (G4). */
export class DriveQuotaExceededError extends ConflictError {
  readonly orgId: string;
  readonly limit: number;
  readonly projected: number;
  readonly limitBytes: number;
  readonly projectedBytes: number;

  constructor(orgId: string, limitBytes: number, projectedBytes: number, o?: ApiErrorOptions) {
    super(`Tenant storage quota exceeded: ${String(projectedBytes)}/${String(limitBytes)} bytes.`, {
      ...o,
      details: {
        orgId,
        limitBytes,
        projectedBytes,
        ...(typeof o?.details === "object" && o.details !== null
          ? (o.details as Record<string, unknown>)
          : {}),
      },
    });
    this.name = "DriveQuotaExceededError";
    this.orgId = orgId;
    this.limit = limitBytes;
    this.projected = projectedBytes;
    this.limitBytes = limitBytes;
    this.projectedBytes = projectedBytes;
  }
}

/**
 * Historical name used throughout store.ts / metering tests.
 * Prefer {@link DriveQuotaExceededError} for new code.
 */
export class DriveStorageQuotaExceededError extends DriveQuotaExceededError {
  constructor(orgId: string, limit: number, projected: number, o?: ApiErrorOptions) {
    super(orgId, limit, projected, o);
    this.name = "DriveStorageQuotaExceededError";
  }
}
