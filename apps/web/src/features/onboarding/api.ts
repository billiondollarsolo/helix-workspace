import type { AuthFetch } from "@/lib/auth";
import { authenticatedFetch } from "@/lib/auth";
import { z } from "zod";

const jsonHeaders = { "content-type": "application/json" } as const;

export type OnboardingEvent = "started" | "completed";
export type OnboardingStep = "plan" | "invite" | "sso";
export type OnboardingPlanChoice = "pro-trial" | "personal" | "sales";
export type OnboardingIdentityChoice = "local" | "google" | "microsoft" | "okta" | "oidc" | "saml";

export interface SendOnboardingEventInput {
  readonly event: OnboardingEvent;
  readonly planChoice?: OnboardingPlanChoice;
  readonly inviteCount?: number;
  readonly identityChoice?: OnboardingIdentityChoice;
  readonly skipped?: boolean;
}

export type SendOnboardingEvent = (input: SendOnboardingEventInput) => Promise<void>;

export interface OnboardingState {
  readonly status: "not_started" | "in_progress" | "completed";
  readonly currentStep: OnboardingStep;
  readonly planChoice: OnboardingPlanChoice;
  readonly inviteCount: number;
  readonly identityChoice: OnboardingIdentityChoice;
  readonly skipped?: boolean;
  readonly updatedAt?: string;
  readonly completedAt?: string;
}

export type FetchOnboardingState = () => Promise<OnboardingState>;

export interface SaveOnboardingProgressInput {
  readonly currentStep: OnboardingStep;
  readonly planChoice?: OnboardingPlanChoice;
  readonly inviteCount?: number;
  readonly identityChoice?: OnboardingIdentityChoice;
}

export type SaveOnboardingProgress = (input: SaveOnboardingProgressInput) => Promise<void>;

export interface SendOnboardingInvitesInput {
  readonly emails: readonly string[];
}

export type SendOnboardingInvites = (input: SendOnboardingInvitesInput) => Promise<void>;

const onboardingStateSchema = z.object({
  status: z.enum(["not_started", "in_progress", "completed"]),
  currentStep: z.enum(["plan", "invite", "sso"]),
  planChoice: z.enum(["pro-trial", "personal", "sales"]),
  inviteCount: z.number().int().min(0).max(10),
  identityChoice: z.enum(["local", "google", "microsoft", "okta", "oidc", "saml"]),
  skipped: z.boolean().optional(),
  updatedAt: z.string().optional(),
  completedAt: z.string().optional(),
});

export async function fetchOnboardingState(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<OnboardingState> {
  const response = await fetchImpl("/api/signup/onboarding-state", {
    method: "GET",
    credentials: "include",
  });
  return parseResponse(response, "load onboarding state", onboardingStateSchema);
}

export async function sendOnboardingEvent(
  input: SendOnboardingEventInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl("/api/signup/onboarding-event", {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Failed to record onboarding event (${String(response.status)}).`);
  }
}

export async function saveOnboardingProgress(
  input: SaveOnboardingProgressInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl("/api/signup/onboarding-progress", {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(`Failed to save onboarding progress (${String(response.status)}).`);
  }
}

export async function sendOnboardingInvites(
  input: SendOnboardingInvitesInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl("/api/signup/onboarding-invites", {
    method: "POST",
    credentials: "include",
    headers: jsonHeaders,
    body: JSON.stringify({ emails: input.emails }),
  });
  if (!response.ok) {
    throw new Error(`Failed to send onboarding invites (${String(response.status)}).`);
  }
}

async function parseResponse<T>(
  response: Response,
  action: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Failed to ${action} (${String(response.status)}).`);
  }
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(`Failed to ${action}: malformed response.`);
}
