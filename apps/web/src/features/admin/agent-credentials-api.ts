import { queryOptions } from "@tanstack/react-query";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";

export interface AgentCredential {
  readonly clientId: string;
  readonly actorId: string;
  readonly orgId: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

export interface AgentCredentialCreateInput {
  readonly actorId: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: string | null;
}

export interface AgentCredentialCreateResult {
  readonly credential: AgentCredential;
  readonly clientSecret: string;
  readonly grantType: "client_credentials";
  readonly tokenEndpoint: string;
}

export interface AgentCredentialRevokeResult {
  readonly status: "revoked" | "not_found";
  readonly clientId?: string;
  readonly credential?: AgentCredential;
}

interface AgentCredentialListOutput {
  readonly credentials: readonly AgentCredential[];
}

interface PendingToolOutput {
  readonly status: "pending_confirmation";
  readonly pending?: {
    readonly id?: string;
  };
}

interface ExecutedToolOutput<Output> {
  readonly status: "executed";
  readonly output: Output;
}

const jsonHeaders = {
  "content-type": "application/json",
} as const;

export const agentCredentialsQueryKeys = {
  list: (includeRevoked: boolean) => ["admin", "agent-credentials", includeRevoked] as const,
};

export function agentCredentialsQueryOptions(includeRevoked = false) {
  return queryOptions({
    queryKey: agentCredentialsQueryKeys.list(includeRevoked),
    queryFn: () => listAgentCredentials({ includeRevoked }),
    retry: false,
    staleTime: 30_000,
    throwOnError: false,
  });
}

export async function listAgentCredentials(
  input: { readonly includeRevoked?: boolean } = {},
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<readonly AgentCredential[]> {
  const output = await callTool<AgentCredentialListOutput>(
    "agent.credentials.list",
    { includeRevoked: input.includeRevoked ?? false },
    fetchImpl,
  );
  return output.credentials;
}

export function createAgentCredential(
  input: AgentCredentialCreateInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<AgentCredentialCreateResult> {
  return callToolWithApproval("agent.credentials.create", input, fetchImpl);
}

export function revokeAgentCredential(
  clientId: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<AgentCredentialRevokeResult> {
  return callToolWithApproval("agent.credentials.revoke", { clientId }, fetchImpl);
}

async function callTool<Output>(
  toolId: string,
  input: unknown,
  fetchImpl: AuthFetch,
): Promise<Output> {
  const response = await fetchImpl(`/api/tools/${encodeURIComponent(toolId)}`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  return parseToolResponse<Output>(response, toolId);
}

async function callToolWithApproval<Output>(
  toolId: string,
  input: unknown,
  fetchImpl: AuthFetch,
): Promise<Output> {
  const response = await fetchImpl(`/api/tools/${encodeURIComponent(toolId)}`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(input),
  });
  if (response.status !== 202) {
    return parseToolResponse<Output>(response, toolId);
  }

  const pending = (await response.json().catch(() => ({}))) as PendingToolOutput;
  const pendingId = pending.pending?.id;
  if (pendingId === undefined || pendingId.length === 0) {
    throw new Error(`Tool ${toolId} is awaiting confirmation without a pending id.`);
  }

  const approved = await fetchImpl(`/api/tools/pending/${encodeURIComponent(pendingId)}/approve`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({}),
  });
  const output = await parseToolResponse<ExecutedToolOutput<Output> | Output>(approved, toolId);
  if (isExecutedToolOutput<Output>(output)) {
    return output.output;
  }
  return output;
}

async function parseToolResponse<Output>(response: Response, toolId: string): Promise<Output> {
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ?? `Tool ${toolId} failed with ${response.status}`,
    );
  }
  return output as Output;
}

function isExecutedToolOutput<Output>(value: unknown): value is ExecutedToolOutput<Output> {
  return isRecord(value) && value.status === "executed" && "output" in value;
}

function errorMessageFromOutput(output: unknown): string | undefined {
  return isRecord(output) && typeof output.error === "string" ? output.error : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
