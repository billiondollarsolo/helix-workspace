import {
  type AccountPasswordChangeInput,
  type AccountPreferences,
  type AccountPreferencesSetInput,
  type AccountSession,
  accountSessionsListResultSchema,
} from "@helix/contracts";
import { type AuthFetch, authenticatedFetch } from "@/lib/auth";
import { callTool, responseError } from "@/lib/tool-call";

export function getAccountPreferences(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<AccountPreferences> {
  return callTool<AccountPreferences>("account.preferences.get", {}, { fetchImpl });
}

/**
 * Partial update; `null` clears a field. Pass the browser zone as
 * `detectedTimeZone` on load: it is saved only while no time zone is set.
 */
export function setAccountPreferences(
  input: AccountPreferencesSetInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<AccountPreferences> {
  return callTool<AccountPreferences>("account.preferences.set", input, { fetchImpl });
}

export function listAccountSessions(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<readonly AccountSession[]> {
  return accountRequest("/api/account/sessions", "GET", undefined, fetchImpl).then(
    (output) => accountSessionsListResultSchema.parse(output).sessions,
  );
}

export async function revokeAccountSession(
  sessionId: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  await accountRequest(
    `/api/account/sessions/${encodeURIComponent(sessionId)}/revoke`,
    "POST",
    {},
    fetchImpl,
  );
}

export async function revokeOtherAccountSessions(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<number> {
  const output = (await accountRequest(
    "/api/account/sessions/revoke-others",
    "POST",
    {},
    fetchImpl,
  )) as { readonly revoked: number };
  return output.revoked;
}

/** Requires the current password; other sessions are signed out when asked. */
export async function changeAccountPassword(
  input: AccountPasswordChangeInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<void> {
  await accountRequest("/api/account/password", "POST", input, fetchImpl);
}

export interface AppPasswordRecord {
  readonly id: string;
  readonly label: string;
  readonly scopes: readonly string[];
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface MyAppPasswords {
  readonly appPasswords: readonly AppPasswordRecord[];
  /** App password scopes you hold, so may grant to a new password. */
  readonly grantableScopes: readonly string[];
}

/** Your own app passwords (secrets are never listed). */
export async function listMyAppPasswords(
  input: { readonly actorId: string; readonly includeRevoked?: boolean },
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<MyAppPasswords> {
  const output = await callTool<Partial<MyAppPasswords>>(
    "app.passwords.list",
    { actorId: input.actorId, includeRevoked: input.includeRevoked ?? false },
    { fetchImpl },
  );
  return {
    appPasswords: output.appPasswords ?? [],
    grantableScopes: output.grantableScopes ?? [],
  };
}

/** Creates an app password for yourself; the password is shown once. */
export function createMyAppPassword(
  input: {
    readonly label: string;
    readonly scopes: readonly string[];
    readonly expiresAt?: string | null;
  },
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<{ readonly appPassword: AppPasswordRecord; readonly password: string }> {
  return callTool("app.passwords.create", input, { fetchImpl });
}

export function revokeMyAppPassword(
  passwordId: string,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<{ readonly status: "revoked" | "not_found" }> {
  return callTool("app.passwords.revoke", { passwordId }, { fetchImpl });
}

async function accountRequest(
  path: string,
  method: "GET" | "POST",
  body: unknown,
  fetchImpl: AuthFetch,
): Promise<unknown> {
  const response = await fetchImpl(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const output: unknown = await response.json().catch(() => null);
  if (!response.ok) throw responseError(response, output, "Account security request");
  return output;
}
