import { versionedApiPath } from "./version.js";

export function pendingActionLinks(
  pendingId: string,
  publicBaseUrl: string | undefined,
): { readonly approvalUrl?: string; readonly statusUrl?: string; readonly reviewUrl?: string } {
  if (publicBaseUrl === undefined || publicBaseUrl.length === 0) return {};
  const base = publicBaseUrl.replace(/\/+$/u, "");
  const id = encodeURIComponent(pendingId);
  return {
    approvalUrl: `${base}${versionedApiPath(`/api/tools/pending/${id}/approve`)}`,
    statusUrl: `${base}${versionedApiPath(`/actions/${id}`)}`,
    reviewUrl: `${base}/approvals/${id}`,
  };
}
