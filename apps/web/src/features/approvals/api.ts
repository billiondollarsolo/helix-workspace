import { pendingActionReviewResultSchema } from "@helix/contracts";
import { authenticatedFetch } from "@/lib/auth";
import { responseError } from "@/lib/tool-call";
import { z } from "zod";
import { queryOptions } from "@tanstack/react-query";

export function pendingActionReviewQueryOptions(id: string) {
  return queryOptions({
    queryKey: ["pending-action-review", id],
    queryFn: () => getPendingActionReview(id),
    retry: false,
    refetchInterval: 5000,
  });
}

async function getPendingActionReview(id: string) {
  const response = await authenticatedFetch(`/actions/${encodeURIComponent(id)}/review`);
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw responseError(response, output, "Action review");
  return pendingActionReviewResultSchema.parse(output);
}

export async function decidePendingAction(id: string, decision: "approve" | "cancel") {
  const response = await authenticatedFetch(
    `/api/tools/pending/${encodeURIComponent(id)}/${decision}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw responseError(response, output, "Action decision");
  const result = z.object({ status: z.string() }).safeParse(output);
  if (
    !result.success ||
    result.data.status !== (decision === "approve" ? "executed" : "cancelled")
  ) {
    throw new Error("The decision did not finish. Refresh this request to check its status.");
  }
}
