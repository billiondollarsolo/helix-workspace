import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";

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
    queryKey: domainsQueryKeys.domains(),
    queryFn: () => fetchDomains(fetchImpl),
    retry: false,
    throwOnError: false,
  });
}

export function dnsRecordsQueryOptions(
  domainId: string | null,
  fetchImpl: AuthFetch = authenticatedFetch,
) {
  return queryOptions({
    queryKey: domainsQueryKeys.dnsRecords(domainId ?? ""),
    queryFn: () => fetchDnsRecords(domainId ?? "", fetchImpl),
    enabled: domainId !== null,
    retry: false,
    throwOnError: false,
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
  const response = await fetchImpl(
    `/api/admin/domains/${encodeURIComponent(domainId)}/dns`,
    { method: "GET" },
  );
  return (await parseResponse(response, "load DNS records", dnsRecordsResponseSchema))
    .dnsRecords;
}

export async function upsertDnsRecord(
  domainId: string,
  input: UpsertDnsRecordInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DnsRecord> {
  const response = await fetchImpl(
    `/api/admin/domains/${encodeURIComponent(domainId)}/dns`,
    {
      method: "PUT",
      headers: jsonHeaders,
      body: JSON.stringify(input),
    },
  );
  return (await parseResponse(response, "save DNS record", dnsRecordResponseSchema)).dnsRecord;
}

export async function verifyDnsRecord(
  domainId: string,
  recordId: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<DnsRecord> {
  const response = await fetchImpl(
    `/api/admin/domains/${encodeURIComponent(domainId)}/dns/${encodeURIComponent(recordId)}/verify`,
    { method: "POST", headers: jsonHeaders },
  );
  return (await parseResponse(response, "verify DNS record", dnsRecordResponseSchema)).dnsRecord;
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

async function ensureOk(response: Response, action: string): Promise<void> {
  if (response.ok) {
    return;
  }
  const payload: unknown = await response.json().catch(() => ({}));
  throw new Error(errorMessage(payload) ?? `Failed to ${action} (${String(response.status)}).`);
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
