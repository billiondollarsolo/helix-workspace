import { errorCodeForStatus } from "@helix/contracts";
import { ApiError } from "../../api/api-error.js";
import type { ToolInvokeErrorResult, ToolQuotaLimitMetadata } from "../tool-registry.js";

/** Carries a client-actionable domain code through tool results; status-derived codes stay implicit. */
export function domainErrorCode(
  error: unknown,
): Pick<ToolInvokeErrorResult, "code" | "codeDetails"> {
  if (!(error instanceof ApiError) || error.code === errorCodeForStatus(error.statusCode)) {
    return {};
  }
  const details = error.details;
  return {
    code: error.code,
    ...(typeof details === "object" && details !== null && !Array.isArray(details)
      ? { codeDetails: details as Readonly<Record<string, unknown>> }
      : {}),
  };
}

export function toolHttpError(error: unknown): {
  readonly statusCode: number;
  readonly retryAfterSeconds?: number;
  readonly quotaLimit?: ToolQuotaLimitMetadata;
} | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  if (
    typeof statusCode !== "number" ||
    !Number.isInteger(statusCode) ||
    statusCode < 400 ||
    statusCode > 599
  ) {
    return null;
  }
  const retryAfterSeconds = (error as { readonly retryAfterSeconds?: unknown }).retryAfterSeconds;
  const quotaLimit = toolQuotaLimit(error);
  return {
    statusCode,
    ...(typeof retryAfterSeconds === "number" &&
    Number.isInteger(retryAfterSeconds) &&
    retryAfterSeconds > 0
      ? { retryAfterSeconds }
      : {}),
    ...(quotaLimit === null ? {} : { quotaLimit }),
  };
}

function toolQuotaLimit(error: object): ToolQuotaLimitMetadata | null {
  const raw = (error as { readonly quotaLimit?: unknown }).quotaLimit;
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const quotaLimit = raw as {
    readonly quota?: unknown;
    readonly limit?: unknown;
    readonly used?: unknown;
    readonly remaining?: unknown;
    readonly retryAfterSeconds?: unknown;
    readonly resetsAt?: unknown;
  };
  if (
    typeof quotaLimit.quota !== "string" ||
    typeof quotaLimit.limit !== "number" ||
    typeof quotaLimit.used !== "number" ||
    quotaLimit.remaining !== 0 ||
    typeof quotaLimit.retryAfterSeconds !== "number" ||
    typeof quotaLimit.resetsAt !== "string"
  ) {
    return null;
  }
  return {
    quota: quotaLimit.quota,
    limit: quotaLimit.limit,
    used: quotaLimit.used,
    remaining: 0,
    retryAfterSeconds: quotaLimit.retryAfterSeconds,
    resetsAt: quotaLimit.resetsAt,
  };
}
