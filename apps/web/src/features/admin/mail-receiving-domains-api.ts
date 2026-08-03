/* Helix Admin — inbound (receiving) domain client.
 *
 * Separate from `mail-admin-api.ts` because it speaks to a different control
 * plane: sending domains authorize mail OUT and carry DKIM signing keys,
 * receiving domains authorize mail IN and carry a one-time ownership challenge.
 *
 * The challenge is the reason this file has a `verification` shape at all: the
 * server mints a token, returns it once, and persists only its SHA-256 digest.
 * Nothing can re-read it — `reissueReceivingDomainChallenge` mints a new one.
 */

import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { parseResponse } from "./mail-admin-api";
import { ADMIN_QUERY_DEFAULTS } from "@/features/admin/console/request-budget";

/** `pending` → `verified` → `active`, with `disabled` reachable from `active`.
 *  Only `active` accepts mail; `verified` means ownership is proven but the
 *  operator has not turned delivery on. */
export const RECEIVING_DOMAIN_STATUSES = ["pending", "verified", "active", "disabled"] as const;
export type ReceivingDomainStatus = (typeof RECEIVING_DOMAIN_STATUSES)[number];

const receivingDomainSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  domain: z.string(),
  status: z.enum(RECEIVING_DOMAIN_STATUSES),
  verifiedAt: z.string().nullable(),
  catchAllActorId: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ReceivingDomain = z.infer<typeof receivingDomainSchema>;

const receivingDomainsResponseSchema = z.object({ domains: z.array(receivingDomainSchema) });
export type ReceivingDomainsResponse = z.infer<typeof receivingDomainsResponseSchema>;

/** The TXT record to publish. Returned only by create and reissue. */
const verificationSchema = z.object({ dnsName: z.string(), dnsValue: z.string() });
export type ReceivingDomainVerification = z.infer<typeof verificationSchema>;

const challengeResponseSchema = z.object({
  domain: receivingDomainSchema,
  verification: verificationSchema,
});
export type ReceivingDomainChallengeResponse = z.infer<typeof challengeResponseSchema>;

const domainResponseSchema = z.object({ domain: receivingDomainSchema });

export const receivingDomainQueryKeys = {
  all: () => ["admin", "mail", "receiving-domains"] as const,
};

export function receivingDomainsQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: receivingDomainQueryKeys.all(),
    queryFn: () => fetchReceivingDomains(fetchImpl),
  });
}

export async function fetchReceivingDomains(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<ReceivingDomainsResponse> {
  const response = await fetchImpl("/api/admin/mail/receiving-domains", { method: "GET" });
  return parseResponse(response, "load receiving domains", receivingDomainsResponseSchema);
}

export async function createReceivingDomain(
  input: { domain: string; catchAllActorId?: string | null },
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<ReceivingDomainChallengeResponse> {
  const response = await fetchImpl("/api/admin/mail/receiving-domains", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      domain: input.domain,
      catchAllActorId: input.catchAllActorId ?? null,
    }),
  });
  return parseResponse(response, "add receiving domain", challengeResponseSchema);
}

export async function reissueReceivingDomainChallenge(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<ReceivingDomainChallengeResponse> {
  const response = await fetchImpl(
    `/api/admin/mail/receiving-domains/${encodeURIComponent(id)}/challenge`,
    { method: "POST" },
  );
  return parseResponse(response, "reissue the verification record", challengeResponseSchema);
}

/* verify/enable/disable take no body. Sending `content-type: application/json`
   with an empty body makes Fastify reject the request before the handler runs
   (FST_ERR_CTP_EMPTY_JSON_BODY), which is what broke admin domain verification
   until it was traced — so these deliberately send no headers at all. */
async function lifecycleAction(
  id: string,
  action: "verify" | "enable" | "disable",
  label: string,
  fetchImpl: AuthFetch,
): Promise<ReceivingDomain> {
  const response = await fetchImpl(
    `/api/admin/mail/receiving-domains/${encodeURIComponent(id)}/${action}`,
    { method: "POST" },
  );
  const parsed = await parseResponse(response, label, domainResponseSchema);
  return parsed.domain;
}

export async function deleteReceivingDomain(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl(`/api/admin/mail/receiving-domains/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await parseResponse(response, "remove the domain", z.object({ deleted: z.boolean() }));
}

export function verifyReceivingDomain(id: string, fetchImpl: AuthFetch = authenticatedFetch) {
  return lifecycleAction(id, "verify", "verify domain ownership", fetchImpl);
}

export function enableReceivingDomain(id: string, fetchImpl: AuthFetch = authenticatedFetch) {
  return lifecycleAction(id, "enable", "start accepting mail", fetchImpl);
}

export function disableReceivingDomain(id: string, fetchImpl: AuthFetch = authenticatedFetch) {
  return lifecycleAction(id, "disable", "stop accepting mail", fetchImpl);
}
