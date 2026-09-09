const csrfCookieNames = ["__Host-helix_csrf", "helix_csrf"] as const;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const API_VERSION_PREFIX = "/v1";

export type AuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface SignInInput {
  readonly email: string;
  readonly password: string;
}

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly actorId: string | null;
  readonly twoFactorEnabled?: boolean;
}

export interface PasskeyRecord {
  readonly id: string;
  readonly name: string | null;
  readonly createdAt: string;
}

export class SecondFactorRequiredError extends Error {
  constructor(readonly methods: readonly string[]) {
    super("Enter your authenticator or recovery code.");
  }
}

const browserAuthClient = createAuthClient({
  plugins: [twoFactorClient(), passkeyClient()],
  fetchOptions: { customFetchImpl: betterAuthBrowserFetch },
});

/**
 * Fetch wrapper for backend (`/api`, `/oauth`, `/trpc`, SSE) requests.
 * Always sends the Better-Auth session cookie via `credentials: "include"`
 * so the backend's `actorFromAuthenticatedRequest` resolves the actor from
 * the session. Browser code never persists bearer credentials.
 */
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!SAFE_METHODS.has((init?.method ?? "GET").toUpperCase())) {
    headers.set("x-helix-csrf-token", await browserCsrfToken());
  }
  return fetch(versionedApiInput(input), {
    ...init,
    credentials: "include",
    headers,
  });
}

/** Signs in with email + password via Better-Auth. Sets the session cookie. */
export async function signInWithEmail(
  input: SignInInput,
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<SessionUser> {
  const response = await fetchImpl("/api/auth/sign-in/email", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: input.email, password: input.password }),
  });
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessageFromOutput(output) ?? "Invalid email or password.");
  }
  if (isRecord(output) && output.twoFactorRedirect === true) {
    throw new SecondFactorRequiredError(
      Array.isArray(output.twoFactorMethods)
        ? output.twoFactorMethods.filter((value): value is string => typeof value === "string")
        : ["totp"],
    );
  }
  const user = sessionUserFromOutput(output);
  if (user === null) {
    throw new Error("Sign-in response was missing the user record.");
  }
  return user;
}

export async function signInWithPasskey(): Promise<SessionUser> {
  const result = await browserAuthClient.signIn.passkey();
  if (result.error !== null) throw new Error(result.error.message ?? "Passkey sign-in failed.");
  const user = sessionUserFromOutput(result.data);
  if (user === null) throw new Error("Passkey sign-in response was incomplete.");
  return user;
}

export async function signInWithOidc(
  email: string,
  fetchImpl: AuthFetch = authenticatedFetch,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): Promise<void> {
  const normalizedEmail = email.trim().toLowerCase();
  const discovery = await authJson(fetchImpl, "/api/auth/domain-discovery", {
    method: "POST",
    body: JSON.stringify({ email: normalizedEmail }),
  });
  if (!isRecord(discovery) || discovery.managed !== true || discovery.protocol !== "oidc") {
    throw new Error("OIDC sign-in is not configured for this email domain.");
  }
  const result = await authJson(fetchImpl, "/api/auth/sign-in/sso", {
    method: "POST",
    body: JSON.stringify({
      email: normalizedEmail,
      providerType: "oidc",
      requestSignUp: false,
      callbackURL: `${window.location.origin}/mail`,
      errorCallbackURL: `${window.location.origin}/login`,
    }),
  });
  if (!isRecord(result) || typeof result.url !== "string") {
    throw new Error("OIDC provider did not return a sign-in URL.");
  }
  const target = new URL(result.url);
  if (target.protocol !== "https:") throw new Error("OIDC provider returned an insecure URL.");
  navigate(target.toString());
}

export async function verifyTotp(code: string): Promise<SessionUser> {
  return authUserMutation("/api/auth/two-factor/verify-totp", { code, trustDevice: false });
}

export async function verifyRecoveryCode(code: string): Promise<SessionUser> {
  return authUserMutation("/api/auth/two-factor/verify-backup-code", {
    code,
    trustDevice: false,
  });
}

export async function addPasskey(name?: string): Promise<void> {
  const result = await browserAuthClient.passkey.addPasskey({ name });
  if (result.error !== null) throw new Error(result.error.message ?? "Passkey enrollment failed.");
}

export async function listPasskeys(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<readonly PasskeyRecord[]> {
  const output = await authJson(fetchImpl, "/api/auth/passkey/list-user-passkeys", {
    method: "GET",
  });
  if (!Array.isArray(output)) return [];
  return output.flatMap((value) =>
    isRecord(value) && typeof value.id === "string"
      ? [
          {
            id: value.id,
            name: typeof value.name === "string" ? value.name : null,
            createdAt:
              typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString(),
          },
        ]
      : [],
  );
}

export async function deletePasskey(id: string): Promise<void> {
  await authJson(authenticatedFetch, "/api/auth/passkey/delete-passkey", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export async function enableTotp(password: string): Promise<{
  readonly totpURI: string;
  readonly backupCodes: readonly string[];
}> {
  const output = await authJson(authenticatedFetch, "/api/auth/two-factor/enable", {
    method: "POST",
    body: JSON.stringify({ password, method: "totp" }),
  });
  if (
    !isRecord(output) ||
    typeof output.totpURI !== "string" ||
    !Array.isArray(output.backupCodes)
  ) {
    throw new Error("TOTP enrollment response was incomplete.");
  }
  return {
    totpURI: output.totpURI,
    backupCodes: output.backupCodes.filter((value): value is string => typeof value === "string"),
  };
}

export async function regenerateRecoveryCodes(password: string): Promise<readonly string[]> {
  const output = await authJson(authenticatedFetch, "/api/auth/two-factor/generate-backup-codes", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
  return isRecord(output) && Array.isArray(output.backupCodes)
    ? output.backupCodes.filter((value): value is string => typeof value === "string")
    : [];
}

export async function disableTotp(password: string): Promise<void> {
  await authJson(authenticatedFetch, "/api/auth/two-factor/disable", {
    method: "POST",
    body: JSON.stringify({ password }),
  });
}

export async function requestPasswordReset(email: string): Promise<void> {
  await authJson(authenticatedFetch, "/api/auth/request-password-reset", {
    method: "POST",
    body: JSON.stringify({ email, redirectTo: `${window.location.origin}/login` }),
  });
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  await authJson(authenticatedFetch, "/api/auth/reset-password", {
    method: "POST",
    body: JSON.stringify({ token, newPassword }),
  });
}

/** TanStack Query keys for session queries. */
export const sessionQueryKeys = {
  current: ["auth", "session"] as const,
};

/** Query options for the current Better-Auth session user. Returns null
 *  while unauthenticated. Cached across the app so the profile menu, settings
 *  page, and side panel all read the same source. */
export function sessionUserQueryOptions() {
  return {
    queryKey: sessionQueryKeys.current,
    queryFn: () => getSessionUser(),
    staleTime: 30_000,
    throwOnError: false,
  } as const;
}

/** Returns the current Better-Auth session user, or null when unauthenticated. */
export async function getSessionUser(
  fetchImpl: AuthFetch = authenticatedFetch,
): Promise<SessionUser | null> {
  const response = await fetchImpl("/api/auth/get-session", {
    method: "GET",
    credentials: "include",
    headers: { "content-type": "application/json" },
  });
  if (!response.ok) {
    return null;
  }
  const output: unknown = await response.json().catch(() => null);
  if (output === null || (typeof output === "object" && Object.keys(output).length === 0)) {
    return null;
  }
  return sessionUserFromOutput(output);
}

/** Signs the current session out via Better-Auth. */
export async function signOut(fetchImpl: AuthFetch = authenticatedFetch): Promise<void> {
  // A non-empty JSON body is required: Fastify rejects an empty body when
  // the content-type is application/json.
  await fetchImpl("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

async function browserCsrfToken(): Promise<string> {
  const existing = csrfTokenFromDocument();
  if (existing !== null) {
    return existing;
  }
  const response = await fetch(apiPath("/api/auth/csrf-token"), { credentials: "include" });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok || !isRecord(payload) || typeof payload.csrfToken !== "string") {
    throw new Error("Unable to establish CSRF protection.");
  }
  return payload.csrfToken;
}

function csrfTokenFromDocument(): string | null {
  if (typeof document === "undefined") {
    return null;
  }
  for (const part of document.cookie.split(";")) {
    const [name, value] = part.trim().split("=", 2);
    if (csrfCookieNames.includes(name as (typeof csrfCookieNames)[number]) && value !== undefined) {
      return value;
    }
  }
  return null;
}

function sessionUserFromOutput(output: unknown): SessionUser | null {
  if (!isRecord(output)) {
    return null;
  }
  const user = isRecord(output.user) ? output.user : output;
  if (typeof user.id !== "string") {
    return null;
  }
  return {
    id: user.id,
    email: typeof user.email === "string" ? user.email : "",
    name: typeof user.name === "string" ? user.name : "",
    actorId:
      typeof user.actorId === "string"
        ? user.actorId
        : typeof user.actor_id === "string"
          ? user.actor_id
          : null,
    twoFactorEnabled: user.twoFactorEnabled === true,
  };
}

async function authUserMutation(path: string, body: unknown): Promise<SessionUser> {
  const output = await authJson(authenticatedFetch, path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const user = sessionUserFromOutput(output);
  if (user === null) throw new Error("Authentication response was incomplete.");
  return user;
}

async function authJson(fetchImpl: AuthFetch, path: string, init: RequestInit): Promise<unknown> {
  const response = await fetchImpl(path, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(init.headers)),
    },
  });
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(errorMessageFromOutput(output) ?? "Authentication request failed.");
  return output;
}

async function betterAuthBrowserFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const request = new Request(versionedApiInput(input), init);
  const headers = new Headers(request.headers);
  if (!SAFE_METHODS.has(request.method.toUpperCase())) {
    headers.set("x-helix-csrf-token", await browserCsrfToken());
  }
  return fetch(new Request(request, { credentials: "include", headers }));
}

/** Resolves a server path beneath the only supported public API version. */
export function apiPath(path: string): string {
  if (!path.startsWith("/")) throw new Error("API paths must be root-relative.");
  return path === API_VERSION_PREFIX || path.startsWith(`${API_VERSION_PREFIX}/`)
    ? path
    : `${API_VERSION_PREFIX}${path}`;
}

function versionedApiInput(input: RequestInfo | URL): RequestInfo | URL {
  if (typeof input === "string") {
    if (input.startsWith("/")) return apiPath(input);
    const url = new URL(input);
    url.pathname = apiPath(url.pathname);
    return url;
  }
  if (input instanceof URL) {
    const url = new URL(input);
    url.pathname = apiPath(url.pathname);
    return url;
  }
  const url = new URL(input.url);
  url.pathname = apiPath(url.pathname);
  return new Request(url, input);
}

function errorMessageFromOutput(output: unknown): string | undefined {
  if (!isRecord(output)) {
    return undefined;
  }
  if (typeof output.message === "string") {
    return output.message;
  }
  if (typeof output.error === "string") {
    return output.error;
  }
  if (isRecord(output.error) && typeof output.error.message === "string") {
    return output.error.message;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/client";
import { twoFactorClient } from "better-auth/client/plugins";
