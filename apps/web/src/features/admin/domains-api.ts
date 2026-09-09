import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { ADMIN_QUERY_DEFAULTS } from "@/features/admin/console/request-budget";
import { ensureOk, parseResponse } from "@/features/admin/api-response";

/**
 * Admin Console — Domain & DNS client.
 *
 * Talks to `/api/admin/domains` — org domains plus the DNS records
 * (MX / SPF / DKIM / DMARC / TXT / CNAME / A) backing mail deliverability and
 * ownership verification. Supports listing domains with records, registering a
 * domain, setting the primary, releasing, DNS-record upsert, and re-verify.
 *
 * Backend responses are validated at the trust boundary with Zod.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

export const DNS_RECORD_TYPES = ["MX", "SPF", "DKIM", "DMARC", "TXT", "CNAME", "A"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export const DOMAIN_STATUSES = ["pending", "verified", "quarantined", "released"] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];
export const VERIFICATION_STATUSES = ["verified", "pending", "failed"] as const;

const domainSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  domain: z.string(),
  isPrimary: z.boolean(),
  status: z.enum(DOMAIN_STATUSES),
  verifiedAt: z.string().nullable(),
  identityEnabled: z.boolean(),
  mailEnabled: z.boolean(),
  aliasesEnabled: z.boolean(),
  customHostEnabled: z.boolean(),
  federationEnabled: z.boolean(),
  providerId: z.string().nullable(),
  identityMode: z.enum(["secondary", "alias"]),
  aliasTargetDomainId: z.string().nullable(),
  verificationHost: z.string(),
  verificationValue: z.string(),
  verificationExpiresAt: z.string(),
  verificationAttempts: z.number().int().nonnegative(),
  verificationLastAttemptAt: z.string().nullable(),
  quarantinedAt: z.string().nullable(),
  releasedAt: z.string().nullable(),
  claimableAfter: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Domain = z.infer<typeof domainSchema>;

const dnsRecordSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  domainId: z.string(),
  recordType: z.enum(DNS_RECORD_TYPES),
  host: z.string(),
  expectedValue: z.string(),
  observedValue: z.string().nullable(),
  status: z.enum(VERIFICATION_STATUSES),
  lastCheckedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DnsRecord = z.infer<typeof dnsRecordSchema>;

const domainWithRecordsSchema = z.object({
  domain: domainSchema,
  dnsRecords: z.array(dnsRecordSchema),
});

export type DomainWithRecords = z.infer<typeof domainWithRecordsSchema>;

const domainsResponseSchema = z.object({ domains: z.array(domainWithRecordsSchema) });
const domainResponseSchema = z.object({ domain: domainSchema });
const dnsRecordsResponseSchema = z.object({ dnsRecords: z.array(dnsRecordSchema) });
const dnsRecordResponseSchema = z.object({ dnsRecord: dnsRecordSchema });

export interface CreateDomainInput {
  readonly domain: string;
}

export interface UpsertDnsRecordInput {
  readonly recordType: DnsRecordType;
  readonly host: string;
  readonly expectedValue: string;
}

export interface UpdateDomainCapabilitiesInput {
  readonly identityEnabled?: boolean;
  readonly mailEnabled?: boolean;
  readonly aliasesEnabled?: boolean;
  readonly customHostEnabled?: boolean;
  readonly federationEnabled?: boolean;
  readonly providerId?: string | null;
  readonly identityMode?: "secondary" | "alias";
  readonly aliasTargetDomainId?: string | null;
}

// ---------------------------------------------------------------------------
// Query keys + options
// ---------------------------------------------------------------------------

export const domainsQueryKeys = {
  domains: () => ["admin", "domains"] as const,
  dnsRecords: (domainId: string) => ["admin", "domains", domainId, "dns"] as const,
};

export function domainsQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: domainsQueryKeys.domains(),
    queryFn: () => fetchDomains(fetchImpl),
  });
}

export function dnsRecordsQueryOptions(
  domainId: string | null,
  fetchImpl: AuthFetch = authenticatedFetch,
) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: domainsQueryKeys.dnsRecords(domainId ?? ""),
    queryFn: () => fetchDnsRecords(domainId ?? "", fetchImpl),
    enabled: domainId !== null,
  });
}

// ---------------------------------------------------------------------------
// Domains — fetchers + mutations
// ---------------------------------------------------------------------------

export async function fetchDomains(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<readonly DomainWithRecords[]> {
  const response = await fetchImpl("/api/admin/domains", { method: "GET" });
  return (await parseResponse(response, "load domains", domainsResponseSchema)).domains;
}

export async function createDomain(
  input: CreateDomainInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<Domain> {
  const response = await fetchImpl("/api/admin/domains", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return (await parseResponse(response, "add domain", domainResponseSchema)).domain;
}

export async function setPrimaryDomain(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<Domain> {
  const response = await fetchImpl(`/api/admin/domains/${encodeURIComponent(id)}/primary`, {
    method: "POST",
  });
  return (await parseResponse(response, "set primary domain", domainResponseSchema)).domain;
}

export async function verifyDomainOwnership(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<Domain> {
  const response = await fetchImpl(`/api/admin/domains/${encodeURIComponent(id)}/verify`, {
    method: "POST",
  });
  return (await parseResponse(response, "verify domain ownership", domainResponseSchema)).domain;
}

export async function rotateDomainChallenge(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<Domain> {
  const response = await fetchImpl(`/api/admin/domains/${encodeURIComponent(id)}/challenge`, {
    method: "POST",
  });
  return (await parseResponse(response, "rotate domain challenge", domainResponseSchema)).domain;
}

export async function releaseDomain(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl(`/api/admin/domains/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await ensureOk(response, "release domain");
}

export async function updateDomainCapabilities(
  id: string,
  input: UpdateDomainCapabilitiesInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<Domain> {
  const response = await fetchImpl(`/api/admin/domains/${encodeURIComponent(id)}/capabilities`, {
    method: "PATCH",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return (await parseResponse(response, "update domain capabilities", domainResponseSchema)).domain;
}

// ---------------------------------------------------------------------------
// DNS records — fetchers + mutations
// ---------------------------------------------------------------------------

export async function fetchDnsRecords(
  domainId: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<readonly DnsRecord[]> {
  const response = await fetchImpl(`/api/admin/domains/${encodeURIComponent(domainId)}/dns`, {
    method: "GET",
  });
  return (await parseResponse(response, "load DNS records", dnsRecordsResponseSchema)).dnsRecords;
}

export async function upsertDnsRecord(
  domainId: string,
  input: UpsertDnsRecordInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DnsRecord> {
  const response = await fetchImpl(`/api/admin/domains/${encodeURIComponent(domainId)}/dns`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return (await parseResponse(response, "save DNS record", dnsRecordResponseSchema)).dnsRecord;
}

export async function verifyDnsRecord(
  domainId: string,
  recordId: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DnsRecord> {
  const response = await fetchImpl(
    `/api/admin/domains/${encodeURIComponent(domainId)}/dns/${encodeURIComponent(recordId)}/verify`,
    /* No `content-type: application/json` header. Verify takes no body, and
       Fastify's JSON parser rejects a bodyless request that declares one with
       `FST_ERR_CTP_EMPTY_JSON_BODY` — a 400 raised before the route handler
       runs, which is why verification failed with "Bad Request" no matter what
       the DNS said. */
    { method: "POST" },
  );
  return (await parseResponse(response, "verify DNS record", dnsRecordResponseSchema)).dnsRecord;
}
