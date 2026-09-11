import { queryOptions } from "@tanstack/react-query";
import { authenticatedFetch } from "@/lib/auth";
import { callTool, type ToolFetch } from "@/lib/tool-call";
import { ADMIN_QUERY_DEFAULTS, ADMIN_STALE_TIME } from "@/features/admin/console/request-budget";

export interface AgentDefenderPolicy {
  readonly actorId: string;
  readonly ownerActorId: string;
  readonly receiveMode: "allowlist" | "open";
  readonly loopEnabled: boolean;
  readonly allowedSenders: readonly string[];
  readonly allowSend: boolean;
}

export interface AgentDefenderHold {
  readonly agentActorId: string;
  readonly threadId: string;
  readonly heldAt: string;
  readonly subject: string;
  readonly fromAddress: string;
}

export const agentDefenderQueryKeys = {
  root: ["admin", "agent-defender"] as const,
  policies: () => [...agentDefenderQueryKeys.root, "policies"] as const,
  holds: () => [...agentDefenderQueryKeys.root, "holds"] as const,
};

export function agentDefenderPoliciesQueryOptions(fetchImpl: ToolFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: agentDefenderQueryKeys.policies(),
    queryFn: () => listAgentDefenderPolicies(fetchImpl),
    staleTime: ADMIN_STALE_TIME.volatile,
  });
}

export function agentDefenderHoldsQueryOptions(fetchImpl: ToolFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: agentDefenderQueryKeys.holds(),
    queryFn: () => listAgentDefenderHolds(fetchImpl),
    staleTime: ADMIN_STALE_TIME.volatile,
  });
}

export async function listAgentDefenderPolicies(
  fetchImpl: ToolFetch = authenticatedFetch,
): Promise<readonly AgentDefenderPolicy[]> {
  const output = await callTool<{ readonly policies: readonly AgentDefenderPolicy[] }>(
    "agent.defender.policy.list",
    {},
    { fetchImpl, autoApprove: false },
  );
  return output.policies;
}

export async function setAgentDefenderPolicy(
  input: {
    readonly actorId: string;
    readonly receiveMode: "allowlist" | "open";
    readonly loopEnabled: boolean;
    readonly allowedSenders: readonly string[];
    readonly allowSend: boolean;
  },
  fetchImpl: ToolFetch = authenticatedFetch,
): Promise<AgentDefenderPolicy> {
  const output = await callTool<{ readonly policy: AgentDefenderPolicy }>(
    "agent.defender.policy.set",
    input,
    { fetchImpl, autoApprove: true },
  );
  return output.policy;
}

export async function listAgentDefenderHolds(
  fetchImpl: ToolFetch = authenticatedFetch,
): Promise<readonly AgentDefenderHold[]> {
  const output = await callTool<{ readonly holds: readonly AgentDefenderHold[] }>(
    "agent.defender.holds.list",
    {},
    { fetchImpl, autoApprove: false },
  );
  return output.holds;
}

export async function decideAgentDefenderHold(
  input: {
    readonly agentActorId: string;
    readonly threadId: string;
    readonly action: "release" | "junk";
  },
  fetchImpl: ToolFetch = authenticatedFetch,
): Promise<boolean> {
  const output = await callTool<{ readonly ok: boolean }>("agent.defender.holds.decide", input, {
    fetchImpl,
    autoApprove: true,
  });
  return output.ok;
}
