import { queryOptions } from "@tanstack/react-query";
import { authenticatedFetch, type AuthFetch } from "@/lib/auth";
import { ADMIN_QUERY_DEFAULTS } from "@/features/admin/console/request-budget";

export interface AppPassword {
  readonly id: string;
  readonly actorId: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface AppPasswordCreateInput {
  readonly actorId: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly expiresAt?: string | null;
}

export interface AppPasswordCreateResult {
  readonly appPassword: AppPassword;
  readonly password: string;
}

export interface AppPasswordRevokeResult {
  readonly status: "revoked" | "not_found";
  readonly passwordId?: string;
  readonly appPassword?: AppPassword;
}

interface AppPasswordListOutput {
  readonly appPasswords: readonly AppPassword[];
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

export const appPasswordsQueryKeys = {
  list: (includeRevoked: boolean) => ["admin", "app-passwords", includeRevoked] as const,
};

export function appPasswordsQueryOptions(includeRevoked = false) {
  return queryOptions({
    ...ADMIN_QUERY_DEFAULTS,
    queryKey: appPasswordsQueryKeys.list(includeRevoked),
    queryFn: () => listAppPasswords({ includeRevoked }),
    staleTime: 30_000,
  });
}

export async function listAppPasswords(
  input: { readonly includeRevoked?: boolean } = {},
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<readonly AppPassword[]> {
  const output = await callTool<AppPasswordListOutput>(
    "app.passwords.list",
    { includeRevoked: input.includeRevoked ?? false },
    fetchImpl,
  );
  return output.appPasswords;
}

export function createAppPassword(
  input: AppPasswordCreateInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<AppPasswordCreateResult> {
  return callToolWithApproval("app.passwords.create", input, fetchImpl);
}

export function revokeAppPassword(
  id: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<AppPasswordRevokeResult> {
  return callToolWithApproval("app.passwords.revoke", { passwordId: id }, fetchImpl);
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
