import { queryOptions } from "@tanstack/react-query";
import { ADMIN_QUERY_DEFAULTS } from "./console/request-budget";
import { z } from "zod";
import { agentRuntimeSchema, type AgentRuntimeConfig } from "@helix/contracts";
import { authenticatedFetch } from "@/lib/auth";
const schema = z.object({
  items: z.array(agentRuntimeSchema),
  models: z.object({
    models: z.array(z.object({ id: z.string(), label: z.string() })),
    defaultModelId: z.string().optional(),
  }),
});
export const agentRuntimeQueryKey = ["admin", "agent-runtimes"] as const;
async function read(response: Response) {
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = z
      .object({ error: z.union([z.string(), z.object({ message: z.string() })]) })
      .safeParse(body);
    throw new Error(
      error.success
        ? typeof error.data.error === "string"
          ? error.data.error
          : error.data.error.message
        : "Could not update agent hosting.",
    );
  }
  return body;
}
export async function listAgentRuntimes() {
  return schema.parse(await read(await authenticatedFetch("/api/admin/agent-runtimes")));
}
export async function saveAgentRuntime(
  actorId: string,
  config: AgentRuntimeConfig,
  resetToNow = false,
) {
  return z.object({ runtime: agentRuntimeSchema }).parse(
    await read(
      await authenticatedFetch(`/api/admin/agent-runtimes/${encodeURIComponent(actorId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config, resetToNow }),
      }),
    ),
  ).runtime;
}

export function agentRuntimeQueryOptions(enabled: boolean) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: agentRuntimeQueryKey,
    queryFn: listAgentRuntimes,
    enabled,
    refetchInterval: enabled ? 10000 : false,
    throwOnError: false,
  });
}
