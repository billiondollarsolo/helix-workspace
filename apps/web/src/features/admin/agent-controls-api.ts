import { queryOptions } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/auth";
import { callTool, type ToolFetch } from "@/lib/tool-call";
import { ADMIN_QUERY_DEFAULTS, ADMIN_STALE_TIME } from "@/features/admin/console/request-budget";

export interface AgentOperationalControls {
  readonly globalReadOnly: boolean;
  readonly agentWritesEnabled: boolean;
  readonly agentWritesDisabledOrgIds: readonly string[];
  readonly disabledToolIds: readonly string[];
}

export const agentControlsQueryKeys = {
  root: ["admin", "agent-controls"] as const,
  detail: () => [...agentControlsQueryKeys.root, "detail"] as const,
};

export function agentControlsQueryOptions(fetchImpl: ToolFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: agentControlsQueryKeys.detail(),
    queryFn: () => getAgentOperationalControls(fetchImpl),
    staleTime: ADMIN_STALE_TIME.volatile,
    /* This is the agent kill switch. Another operator disabling agents during
       an incident has to be visible here without a reload — `staleTime: 5_000`
       alone only meant "the next mount may refetch", and a page left open
       never mounts again. `platform.pending_action.created` covers approvals
       but not the switch itself, so the interval stays until an emitter does. */
    refetchInterval: 10_000,
  });
}

export async function getAgentOperationalControls(
  fetchImpl: ToolFetch = authenticatedFetch,
): Promise<AgentOperationalControls> {
  const output = await callTool<{ readonly controls: AgentOperationalControls }>(
    "admin.agent_controls.get",
    {},
    { fetchImpl, autoApprove: false },
  );
  return output.controls;
}

export async function setAgentOperationalControls(
  input: {
    readonly globalReadOnly?: boolean;
    readonly agentWritesEnabled?: boolean;
    readonly disableOrgId?: string;
    readonly enableOrgId?: string;
  },
  fetchImpl: ToolFetch = authenticatedFetch,
): Promise<AgentOperationalControls> {
  const output = await callTool<{ readonly controls: AgentOperationalControls }>(
    "admin.agent_controls.set",
    input,
    { fetchImpl, autoApprove: true },
  );
  return output.controls;
}
