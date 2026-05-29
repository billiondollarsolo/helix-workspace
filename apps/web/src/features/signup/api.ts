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

export interface SignupRequest {
  readonly email: string;
  readonly password: string;
  readonly orgName: string;
  readonly orgSlug: string;
  readonly country: string;
  readonly phone?: string;
  readonly marketingOptIn: boolean;
  readonly termsAccepted: boolean;
  readonly privacyAccepted: boolean;
  readonly recaptchaToken?: string;
}

export interface SignupOrg {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly status: string;
  readonly region: string;
}

export interface SignupResponse {
  readonly status: "provisioning";
  readonly org: SignupOrg;
  readonly verification: {
    readonly required: true;
    readonly status: "pending";
    readonly expiresAt?: string;
  };
}

export interface SignupSlugAvailability {
  readonly slug: string;
  readonly valid: boolean;
  readonly available: boolean;
  readonly reason?: "invalid_format" | "reserved" | "taken";
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
    readonly onboardingUrl: string;
    readonly welcomeUrl: string;
  };
}

export interface SignupResendVerificationResponse {
  readonly status: "accepted";
}

export interface SignupFormViewedAttribution {
  readonly utmSource?: string;
  readonly utmMedium?: string;
  readonly utmCampaign?: string;
  readonly utmTerm?: string;
  readonly utmContent?: string;
  readonly referrerOrigin?: string;
}

export interface SignupFormViewedInput {
  readonly page: "signup";
  readonly attribution?: SignupFormViewedAttribution;
}

export interface SignupFormViewedResponse {
  readonly status: "accepted";
}

export interface SignupOnboardingInviteAcceptResponse {
  readonly status: "accepted";
  readonly org: SignupOrg;
  readonly actorId: string;
  readonly workspace: {
    readonly onboardingUrl: string;
    readonly welcomeUrl: string;
  };
}

const signupOrgSchema = z.object({
  id: z.string(),
  slug: z.string(),
  displayName: z.string(),
  status: z.string(),
  region: z.string(),
});

const signupResponseSchema = z.object({
  status: z.literal("provisioning"),
  org: signupOrgSchema,
  verification: z.object({
    required: z.literal(true),
    status: z.literal("pending"),
    expiresAt: z.string().optional(),
  }),
});

const signupSlugAvailabilitySchema = z.object({
  slug: z.string(),
  valid: z.boolean(),
  available: z.boolean(),
  reason: z.enum(["invalid_format", "reserved", "taken"]).optional(),
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
    onboardingUrl: z.string(),
    welcomeUrl: z.string(),
  }),
});

const signupResendVerificationResponseSchema = z.object({
  status: z.literal("accepted"),
});

const signupFormViewedResponseSchema = z.object({
  status: z.literal("accepted"),
});

const signupOnboardingInviteAcceptResponseSchema = z.object({
  status: z.literal("accepted"),
  org: signupOrgSchema,
  actorId: z.string(),
  workspace: z.object({
    onboardingUrl: z.string(),
    welcomeUrl: z.string(),
  }),
});

export async function checkOrgSlugAvailability(
  slug: string,
  fetchImpl: SignupFetch = fetch,
): Promise<SignupSlugAvailability> {
  const response = await fetchImpl(
    `/api/signup/org-slug/${encodeURIComponent(slug)}/availability`,
    {
      method: "GET",
      credentials: "include",
    },
  );
  return parseResponse(response, "check workspace URL", signupSlugAvailabilitySchema);
}

export async function startSignup(
  input: SignupRequest,
  fetchImpl: SignupFetch = fetch,
): Promise<SignupResponse> {
  const response = await fetchImpl("/api/signup", {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return parseResponse(response, "create workspace", signupResponseSchema);
}

export async function verifySignupEmail(
  token: string,
  fetchImpl: SignupFetch = fetch,
): Promise<SignupVerifyEmailResponse> {
  const response = await fetchImpl("/api/signup/verify-email", {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify({ token }),
  });
  return parseResponse(response, "verify email", signupVerifyEmailResponseSchema);
}

export async function resendSignupVerification(
  token: string,
  fetchImpl: SignupFetch = fetch,
): Promise<SignupResendVerificationResponse> {
  const response = await fetchImpl("/api/signup/resend-verification", {
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

export async function recordSignupFormViewed(
  input: SignupFormViewedInput,
  fetchImpl: SignupFetch = fetch,
): Promise<SignupFormViewedResponse> {
  const response = await fetchImpl("/api/signup/form-viewed", {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return parseResponse(response, "record signup form view", signupFormViewedResponseSchema);
}

export async function acceptSignupOnboardingInvite(
  token: string,
  fetchImpl: SignupFetch = fetch,
): Promise<SignupOnboardingInviteAcceptResponse> {
  const response = await fetchImpl("/api/signup/onboarding-invite/accept", {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify({ token }),
  });
  return parseResponse(
    response,
    "accept onboarding invite",
    signupOnboardingInviteAcceptResponseSchema,
  );
}

export function signupFormViewedInputFromBrowser(input: {
  readonly search: string;
  readonly referrer: string;
}): SignupFormViewedInput {
  const attribution: Record<string, string> = {};
  const params = new URLSearchParams(input.search);
  addAttribution(attribution, "utmSource", params.get("utm_source"));
  addAttribution(attribution, "utmMedium", params.get("utm_medium"));
  addAttribution(attribution, "utmCampaign", params.get("utm_campaign"));
  addAttribution(attribution, "utmTerm", params.get("utm_term"));
  addAttribution(attribution, "utmContent", params.get("utm_content"));
  const referrerOrigin = referrerOriginFrom(input.referrer);
  if (referrerOrigin !== undefined) {
    attribution.referrerOrigin = referrerOrigin;
  }
  return Object.keys(attribution).length === 0
    ? { page: "signup" }
    : { page: "signup", attribution };
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

function addAttribution(output: Record<string, string>, key: string, value: string | null): void {
  const sanitized = sanitizeAttributionValue(value);
  if (sanitized !== undefined) {
    output[key] = sanitized;
  }
}

function sanitizeAttributionValue(value: string | null): string | undefined {
  const trimmed = value?.trim();
  if (
    trimmed === undefined ||
    trimmed.length === 0 ||
    trimmed.length > 128 ||
    trimmed.includes("@") ||
    /^https?:\/\//iu.test(trimmed) ||
    hasControlCharacters(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function referrerOriginFrom(value: string): string | undefined {
  if (value.trim().length === 0) {
    return undefined;
  }
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) {
      return true;
    }
  }
  return false;
}
