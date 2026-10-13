import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { ADMIN_QUERY_DEFAULTS, ADMIN_STALE_TIME } from "@/features/admin/console/request-budget";
import { ensureOk, parseResponse } from "@/features/admin/api-response";

/**
 * Admin Console — agents and the secrets stored for them.
 *
 * `/api/admin/agents` lists the organization's agents and service accounts and
 * adds an agent. `/api/admin/agent-secrets` stores a secret, sets how agents
 * may use it, and grants it. A value is only ever sent, never returned.
 */

const agentSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  type: z.enum(["agent", "service_account"]),
  description: z.string(),
  disabled: z.boolean(),
  createdAt: z.string(),
});

const grantSchema = z.object({
  actorId: z.string(),
  displayName: z.string(),
  actorType: z.enum(["agent", "service_account"]),
  disabled: z.boolean(),
  grantedAt: z.string(),
  lastUsedAt: z.string().nullable(),
  useCount: z.number().int(),
});

const secretSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  mode: z.enum(["use_only", "handover"]),
  allowedHosts: z.array(z.string()),
  headerName: z.string(),
  headerPrefix: z.string(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  rotatedAt: z.string(),
  grants: z.array(grantSchema),
});

export type AdminAgent = z.infer<typeof agentSchema>;
export type AgentSecret = z.infer<typeof secretSchema>;
export type AgentSecretMode = AgentSecret["mode"];

const AGENTS_PATH = "/api/admin/agents";
const SECRETS_PATH = "/api/admin/agent-secrets";
const json = { "content-type": "application/json" } as const;

export const adminAgentsQueryKey = ["admin", "agents"] as const;
export const agentSecretsQueryKey = ["admin", "agent-secrets"] as const;

export function adminAgentsQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    staleTime: ADMIN_STALE_TIME.normal,
    queryKey: adminAgentsQueryKey,
    queryFn: async () =>
      (
        await parseResponse(
          await fetchImpl(AGENTS_PATH),
          "load agents",
          z.object({ agents: z.array(agentSchema) }),
        )
      ).agents,
  });
}

export async function createAdminAgent(
  input: { readonly displayName: string; readonly description: string },
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<AdminAgent> {
  const response = await fetchImpl(AGENTS_PATH, {
    method: "POST",
    headers: json,
    body: JSON.stringify(input),
  });
  return (await parseResponse(response, "add the agent", z.object({ agent: agentSchema }))).agent;
}

export function agentSecretsQueryOptions(fetchImpl: AuthFetch = authenticatedFetch) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    staleTime: ADMIN_STALE_TIME.normal,
    queryKey: agentSecretsQueryKey,
    queryFn: async () =>
      (
        await parseResponse(
          await fetchImpl(SECRETS_PATH),
          "load agent secrets",
          z.object({ secrets: z.array(secretSchema) }),
        )
      ).secrets,
  });
}

/** How a secret is sent in a request: to which hosts, in which header. */
interface AgentSecretDelivery {
  readonly allowedHosts: readonly string[];
  readonly headerName: string;
  readonly headerPrefix: string;
}

export interface AgentSecretCreateInput extends AgentSecretDelivery {
  readonly name: string;
  readonly description: string;
  readonly mode: AgentSecretMode;
  readonly value: string;
}

export interface AgentSecretUpdateInput extends Partial<AgentSecretDelivery> {
  readonly description?: string;
  readonly mode?: AgentSecretMode;
  /** A new value; leave out to keep the stored one. */
  readonly value?: string;
}

const secretResponse = z.object({ secret: secretSchema });

async function send(
  path: string,
  method: "POST" | "PATCH" | "PUT",
  body: unknown,
  action: string,
  fetchImpl: AuthFetch,
): Promise<AgentSecret> {
  const response = await fetchImpl(path, { method, headers: json, body: JSON.stringify(body) });
  return (await parseResponse(response, action, secretResponse)).secret;
}

export function createAgentSecret(
  input: AgentSecretCreateInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<AgentSecret> {
  return send(SECRETS_PATH, "POST", input, "store the secret", fetchImpl);
}

export function updateAgentSecret(
  id: string,
  input: AgentSecretUpdateInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<AgentSecret> {
  return send(`${SECRETS_PATH}/${id}`, "PATCH", input, "save the secret", fetchImpl);
}

export function setAgentSecretGrants(
  id: string,
  actorIds: readonly string[],
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<AgentSecret> {
  return send(
    `${SECRETS_PATH}/${id}/grants`,
    "PUT",
    { actorIds },
    "save who can use it",
    fetchImpl,
  );
}

export async function deleteAgentSecret(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  await ensureOk(
    await fetchImpl(`${SECRETS_PATH}/${id}`, { method: "DELETE" }),
    "delete the secret",
  );
}
