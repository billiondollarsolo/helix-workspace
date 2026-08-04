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
 * domain, setting the primary, deleting, DNS-record upsert, and re-verify.
 *
 * Backend responses are validated at the trust boundary with Zod.
 */

const jsonHeaders = { "content-type": "application/json" } as const;

export const DNS_RECORD_TYPES = ["MX", "SPF", "DKIM", "DMARC", "TXT", "CNAME", "A"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

export const VERIFICATION_STATUSES = ["verified", "pending", "failed"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

const domainSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  domain: z.string(),
  isPrimary: z.boolean(),
  verificationStatus: z.enum(VERIFICATION_STATUSES),
  verifiedAt: z.string().nullable(),
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

/* What a domain is used for. Both nullable: a registered domain with neither
   capability switched on is a normal state, not an error. */
const sendingCapabilitySchema = z.object({
  id: z.string(),
  isDefault: z.boolean(),
  verifiedAt: z.string().nullable(),
  dkimKeyCount: z.number(),
});
const receivingCapabilitySchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "verified", "active", "disabled"]),
});

export type SendingCapability = z.infer<typeof sendingCapabilitySchema>;
export type ReceivingCapability = z.infer<typeof receivingCapabilitySchema>;

const domainWithRecordsSchema = z.object({
  domain: domainSchema,
  dnsRecords: z.array(dnsRecordSchema),
  sending: sendingCapabilitySchema.nullable(),
  receiving: receivingCapabilitySchema.nullable(),
});

export type DomainWithRecords = z.infer<typeof domainWithRecordsSchema>;

const domainsResponseSchema = z.object({ domains: z.array(domainWithRecordsSchema) });
const domainResponseSchema = z.object({ domain: domainSchema });
const dnsRecordsResponseSchema = z.object({ dnsRecords: z.array(dnsRecordSchema) });
const dnsRecordResponseSchema = z.object({ dnsRecord: dnsRecordSchema });

export interface CreateDomainInput {
  readonly domain: string;
  readonly isPrimary?: boolean;
}

export interface UpsertDnsRecordInput {
  readonly recordType: DnsRecordType;
  readonly host: string;
  readonly expectedValue: string;
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
    headers: jsonHeaders,
  });
  return (await parseResponse(response, "set primary domain", domainResponseSchema)).domain;
}

export async function deleteDomain(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  const response = await fetchImpl(`/api/admin/domains/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await ensureOk(response, "delete domain");
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

/* --------------------------------------------------------------------- */
/* Proof of ownership                                                     */
/* --------------------------------------------------------------------- */

const ownershipChallengeSchema = z.object({
  domain: domainSchema,
  verification: z.object({ dnsName: z.string(), dnsValue: z.string() }),
});
export type OwnershipChallenge = z.infer<typeof ownershipChallengeSchema>;

/** Issues a fresh TXT challenge. The value is returned here and nowhere else —
 *  only its digest is stored, so re-issuing is the only way back. */
export async function issueOwnershipChallenge(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<OwnershipChallenge> {
  const response = await fetchImpl(`/api/admin/domains/${encodeURIComponent(id)}/challenge`, {
    method: "POST",
  });
  return parseResponse(response, "issue a verification record", ownershipChallengeSchema);
}

const ownershipVerifySchema = z.object({ domain: domainSchema, verified: z.boolean() });

export async function verifyDomainOwnership(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<z.infer<typeof ownershipVerifySchema>> {
  // No body, and no content-type: Fastify rejects an empty JSON body.
  const response = await fetchImpl(
    `/api/admin/domains/${encodeURIComponent(id)}/verify-ownership`,
    { method: "POST" },
  );
  return parseResponse(response, "verify domain ownership", ownershipVerifySchema);
}
