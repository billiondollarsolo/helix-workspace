import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { ADMIN_QUERY_DEFAULTS, ADMIN_STALE_TIME } from "@/features/admin/console/request-budget";
import { parseResponse } from "@/features/admin/api-response";

/**
 * Admin Console — DNS and proxy checklist client.
 *
 * Talks to `/api/admin/domains/dns-checklist`: each of the installation's
 * hostnames, whether its record should go through an HTTP proxy such as
 * Cloudflare, and whether it does right now.
 */

const rowSchema = z.object({
  hostname: z.string(),
  role: z.enum(["web", "app", "mail", "turn"]),
  expected: z.enum(["proxied", "dns-only"]),
  observed: z.enum(["proxied", "dns-only", "mixed", "unresolved"]),
  addresses: z.array(z.string()),
  status: z.enum(["ok", "recommend", "problem"]),
  advice: z.string(),
});

const responseSchema = z.object({ rows: z.array(rowSchema) });

export type DnsChecklistRow = z.infer<typeof rowSchema>;

export const dnsChecklistQueryKey = ["admin", "domains", "dns-checklist"] as const;

async function fetchDnsChecklist(fetchImpl: AuthFetch): Promise<DnsChecklistRow[]> {
  const response = await fetchImpl("/api/admin/domains/dns-checklist");
  return (await parseResponse(response, "check DNS records", responseSchema)).rows;
}

export function dnsChecklistQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    staleTime: ADMIN_STALE_TIME.normal,
    queryKey: dnsChecklistQueryKey,
    queryFn: () => fetchDnsChecklist(fetchImpl),
  });
}
