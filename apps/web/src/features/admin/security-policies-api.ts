import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";

/**
 * Admin Console — Security policies client.
 *
 * Talks to `/api/admin/security-policies` — one record per (org, policyType)
 * across the six controls: mfa, sso, session, external_sharing, dlp,
 * device_trust. `settings` is a typed JSON blob; it is validated loosely here
 * (the backend owns the per-type schema) and surfaced to the UI as-is.
 *
 * Backend responses are validated at the trust boundary with Zod.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

export const SECURITY_POLICY_TYPES = [
  "mfa",
  "sso",
  "session",
  "external_sharing",
  "dlp",
  "device_trust",
] as const;
export type SecurityPolicyType = (typeof SECURITY_POLICY_TYPES)[number];

export const securityPolicyLabels: Record<SecurityPolicyType, string> = {
  mfa: "Multi-factor authentication",
  sso: "Single sign-on (SSO)",
  session: "Session management",
  external_sharing: "External sharing",
  dlp: "DLP — Data loss prevention",
  device_trust: "Device trust",
};

export const securityPolicyGroup: Record<SecurityPolicyType, "Authentication" | "Access & data"> = {
  mfa: "Authentication",
  sso: "Authentication",
  session: "Authentication",
  external_sharing: "Access & data",
  dlp: "Access & data",
  device_trust: "Access & data",
};

export const POLICY_ENFORCEMENTS = ["disabled", "optional", "required"] as const;
export type PolicyEnforcement = (typeof POLICY_ENFORCEMENTS)[number];

const securityPolicySchema = z.object({
  id: z.string(),
  orgId: z.string(),
  policyType: z.enum(SECURITY_POLICY_TYPES),
  enabled: z.boolean(),
  enforcement: z.enum(POLICY_ENFORCEMENTS),
  settings: z.record(z.string(), z.unknown()),
  updatedBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type SecurityPolicy = z.infer<typeof securityPolicySchema>;

const policiesResponseSchema = z.object({ policies: z.array(securityPolicySchema) });
const policyResponseSchema = z.object({ policy: securityPolicySchema });
const ssoTestLoginResponseSchema = z.object({
  testLogin: z.object({
    status: z.enum(["configuration_required", "runtime_pending"]),
    message: z.string(),
  }),
});

export interface UpdateSecurityPolicyInput {
  readonly enabled?: boolean;
  readonly enforcement?: PolicyEnforcement;
  readonly settings?: Record<string, unknown>;
}

export type SsoTestLoginResponse = z.infer<typeof ssoTestLoginResponseSchema>["testLogin"];

// ---------------------------------------------------------------------------
// Query keys + options
// ---------------------------------------------------------------------------

export const securityPoliciesQueryKeys = {
  list: () => ["admin", "security-policies"] as const,
};

export function securityPoliciesQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    queryKey: securityPoliciesQueryKeys.list(),
    queryFn: () => fetchSecurityPolicies(fetchImpl),
    retry: false,
    throwOnError: false,
  });
}

// ---------------------------------------------------------------------------
// Fetchers + mutations
// ---------------------------------------------------------------------------

export async function fetchSecurityPolicies(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<readonly SecurityPolicy[]> {
  const response = await fetchImpl("/api/admin/security-policies", { method: "GET" });
  return (await parseResponse(response, "load security policies", policiesResponseSchema)).policies;
}

export async function fetchSecurityPolicy(
  policyType: SecurityPolicyType,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<SecurityPolicy> {
  const response = await fetchImpl(
    `/api/admin/security-policies/${encodeURIComponent(policyType)}`,
    { method: "GET" },
  );
  return (await parseResponse(response, "load security policy", policyResponseSchema)).policy;
}

export async function updateSecurityPolicy(
  policyType: SecurityPolicyType,
  input: UpdateSecurityPolicyInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<SecurityPolicy> {
  const response = await fetchImpl(
    `/api/admin/security-policies/${encodeURIComponent(policyType)}`,
    {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify(input),
    },
  );
  return (await parseResponse(response, "update security policy", policyResponseSchema)).policy;
}

export async function testSsoLogin(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<SsoTestLoginResponse> {
  const response = await fetchImpl("/api/admin/security-policies/sso/test-login", {
    method: "POST",
    headers: jsonHeaders,
    body: "{}",
  });
  return (await parseResponse(response, "test SSO login", ssoTestLoginResponseSchema)).testLogin;
}

// ---------------------------------------------------------------------------
// Shared response handling
// ---------------------------------------------------------------------------

async function parseResponse<T>(
  response: Response,
  action: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessage(payload) ?? `Failed to ${action} (${String(response.status)}).`);
  }
  const parsed = schema.safeParse(payload);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(`Failed to ${action}: malformed response.`);
}

function errorMessage(payload: unknown): string | undefined {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "string"
  ) {
    return payload.error;
  }
  return undefined;
}
