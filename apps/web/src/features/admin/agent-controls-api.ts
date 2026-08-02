import { queryOptions } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/auth";
import { callTool, type ToolFetch } from "@/lib/tool-call";

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
    queryKey: agentControlsQueryKeys.detail(),
    queryFn: () => getAgentOperationalControls(fetchImpl),
    retry: false,
    throwOnError: false,
    staleTime: 5_000,
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
