import { z } from "zod";
import type { AuthFetch } from "@/lib/auth";

const jsonHeaders = { "content-type": "application/json" } as const;

export type SignupFetch = AuthFetch;

export class SignupApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: unknown;
  readonly retryAfterSeconds: number | null;

  constructor(input: {
    readonly message: string;
    readonly status: number;
    readonly code?: string | null;
    readonly details?: unknown;
    readonly retryAfterSeconds?: number | null;
  }) {
    super(input.message);
    this.name = "SignupApiError";
    this.status = input.status;
    this.code = input.code ?? null;
    this.details = input.details;
    this.retryAfterSeconds = input.retryAfterSeconds ?? null;
  }
}

interface SignupOrg {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status: string;
  readonly region: string;
}

export interface SignupVerifyEmailResponse {
  readonly status: "active";
  readonly org: SignupOrg;
  readonly verification: {
    readonly status: "verified";
  };
  readonly session: {
    readonly created: boolean;
    readonly status: string;
  };
  readonly workspace: {
    readonly workspaceUrl: string;
  };
}

export interface SignupResendVerificationResponse {
  readonly status: "accepted";
}

export interface SignupOnboardingInviteAcceptResponse {
  readonly status: "accepted";
  readonly org: SignupOrg;
  readonly actorId: string;
  readonly workspace: {
    readonly workspaceUrl: string;
  };
}

const signupOrgSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  status: z.string(),
  region: z.string(),
});

const signupVerifyEmailResponseSchema = z.object({
  status: z.literal("active"),
  org: signupOrgSchema,
  verification: z.object({
    status: z.literal("verified"),
  }),
  session: z.object({
    created: z.boolean(),
    status: z.string(),
  }),
  workspace: z.object({
    workspaceUrl: z.string(),
  }),
});

const signupResendVerificationResponseSchema = z.object({
  status: z.literal("accepted"),
});

const signupOnboardingInviteAcceptResponseSchema = z.object({
  status: z.literal("accepted"),
  org: signupOrgSchema,
  actorId: z.string(),
  workspace: z.object({
    workspaceUrl: z.string(),
  }),
});

export async function verifySignupEmail(
  token: string,
  fetchImpl: SignupFetch = fetch,
  options: { readonly signal?: AbortSignal } = {},
): Promise<SignupVerifyEmailResponse> {
  const response = await fetchImpl("/v1/api/signup/verify-email", {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify({ token }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return parseResponse(response, "verify email", signupVerifyEmailResponseSchema);
}

export async function resendSignupVerification(
  token: string,
  fetchImpl: SignupFetch = fetch,
): Promise<SignupResendVerificationResponse> {
  const response = await fetchImpl("/v1/api/signup/resend-verification", {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify({ token }),
  });
  return parseResponse(
    response,
    "resend verification email",
    signupResendVerificationResponseSchema,
  );
}

export async function acceptSignupOnboardingInvite(
  token: string,
  fetchImpl: SignupFetch = fetch,
  options: { readonly signal?: AbortSignal } = {},
): Promise<SignupOnboardingInviteAcceptResponse> {
  const response = await fetchImpl("/v1/api/signup/onboarding-invite/accept", {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify({ token }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return parseResponse(
    response,
    "accept onboarding invite",
    signupOnboardingInviteAcceptResponseSchema,
  );
}

async function parseResponse<T>(
  response: Response,
  action: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw signupApiError(payload, response, action);
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Failed to ${action}: malformed response.`);
  }
  return parsed.data;
}

function signupApiError(payload: unknown, response: Response, action: string): SignupApiError {
  const retryAfter = retryAfterSeconds(response.headers.get("retry-after"));
  if (!isRecord(payload)) {
    return new SignupApiError({
      message: `Failed to ${action} (${String(response.status)}).`,
      status: response.status,
      retryAfterSeconds: retryAfter,
    });
  }

  const envelope = isRecord(payload.error) ? payload.error : payload;
  return new SignupApiError({
    message: errorMessage(payload) ?? `Failed to ${action} (${String(response.status)}).`,
    status: response.status,
    code: typeof envelope.code === "string" ? envelope.code : null,
    details: envelope.details,
    retryAfterSeconds: retryAfter,
  });
}

function errorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  if (typeof payload.error === "string") {
    return payload.error;
  }
  if (isRecord(payload.error)) {
    if (typeof payload.error.message === "string") {
      return payload.error.message;
    }
    if (typeof payload.error.code === "string") {
      return payload.error.code;
    }
  }
  if (typeof payload.message === "string") {
    return payload.message;
  }
  return undefined;
}

function retryAfterSeconds(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
