import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { ADMIN_QUERY_DEFAULTS, ADMIN_STALE_TIME } from "@/features/admin/console/request-budget";
import { parseResponse } from "@/features/admin/api-response";

/**
 * Admin Console — HTTPS certificate client.
 *
 * Talks to `/api/admin/edge/certificate`: the certificate the deployment's
 * address serves, and replacing it with one the operator provides. The private
 * key is only ever sent, never returned.
 */

const summarySchema = z.object({
  subject: z.string(),
  issuer: z.string(),
  names: z.array(z.string()),
  notBefore: z.string(),
  notAfter: z.string(),
  fingerprintSha256: z.string(),
});

const statusSchema = z.object({
  hostname: z.string(),
  source: z.enum(["automatic", "uploaded", "deployment-files", "internal"]),
  manageable: z.boolean(),
  unavailableReason: z.string().nullable(),
  served: summarySchema.nullable(),
  uploaded: summarySchema.extend({ updatedAt: z.string() }).nullable(),
  applied: z.boolean().nullable(),
});

const responseSchema = z.object({ certificate: statusSchema });

export type EdgeCertificateSummary = z.infer<typeof summarySchema>;
export type EdgeCertificateStatus = z.infer<typeof statusSchema>;

export const edgeCertificateQueryKey = ["admin", "edge-certificate"] as const;

const PATH = "/api/admin/edge/certificate";

async function fetchEdgeCertificate(fetchImpl: AuthFetch): Promise<EdgeCertificateStatus> {
  const response = await fetchImpl(PATH);
  return (await parseResponse(response, "load the HTTPS certificate", responseSchema)).certificate;
}

/** `settling` re-reads every two seconds while the edge takes up a change. */
export function edgeCertificateQueryOptions(
  settling = false,
  fetchImpl: AuthFetch = authenticatedFetch,
) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    staleTime: ADMIN_STALE_TIME.normal,
    queryKey: edgeCertificateQueryKey,
    queryFn: () => fetchEdgeCertificate(fetchImpl),
    refetchInterval: settling ? 2_000 : false,
  });
}

/** A refused upload, with the input the refusal is about when the server names one. */
export class EdgeCertificateUploadError extends Error {
  constructor(
    message: string,
    readonly field: "certificate" | "privateKey" | null,
  ) {
    super(message);
    this.name = "EdgeCertificateUploadError";
  }
}

const refusalSchema = z.object({
  error: z.string(),
  issues: z.array(z.object({ path: z.array(z.string()) })).optional(),
});

export async function uploadEdgeCertificate(
  input: { readonly certificatePem: string; readonly privateKeyPem: string },
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<EdgeCertificateStatus> {
  const response = await fetchImpl(PATH, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (response.status === 400 || response.status === 409) {
    const refusal = refusalSchema.safeParse(
      await response
        .clone()
        .json()
        .catch(() => null),
    );
    if (refusal.success) {
      const field = refusal.data.issues?.[0]?.path[0];
      throw new EdgeCertificateUploadError(
        refusal.data.error,
        field === "certificate" || field === "privateKey" ? field : null,
      );
    }
  }
  return (await parseResponse(response, "save the certificate", responseSchema)).certificate;
}

export async function removeEdgeCertificate(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<EdgeCertificateStatus> {
  const response = await fetchImpl(PATH, { method: "DELETE" });
  return (await parseResponse(response, "remove the certificate", responseSchema)).certificate;
}
