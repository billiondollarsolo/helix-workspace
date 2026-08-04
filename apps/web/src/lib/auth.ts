export const HELIX_ACCESS_TOKEN_STORAGE_KEY = "helix.accessToken";

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
}

/**
 * Optional client-credentials access token, kept only as a fallback for
 * non-browser/test contexts. Browser auth now rides the Better-Auth session
 * cookie (`helix_session`), so a stored token is no longer required.
 */
export function getStoredAccessToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const token = window.localStorage.getItem(HELIX_ACCESS_TOKEN_STORAGE_KEY)?.trim();
  return token === undefined || token.length === 0 ? null : token;
}

export function storeAccessToken(token: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(HELIX_ACCESS_TOKEN_STORAGE_KEY, token);
}

export function clearStoredAccessToken(): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(HELIX_ACCESS_TOKEN_STORAGE_KEY);
}

/**
 * Fetch wrapper for backend (`/api`, `/oauth`, `/trpc`, SSE) requests.
 * Always sends the Better-Auth session cookie via `credentials: "include"`
 * so the backend's `actorFromAuthenticatedRequest` resolves the actor from
 * the session. A stored client-credentials bearer token, if present, is
 * still attached as an optional fallback.
 */
export function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const token = getStoredAccessToken();
  return fetch(input, {
    ...init,
    credentials: "include",
    ...(token === null ? {} : { headers: headersWithBearer(init?.headers, token) }),
  });
}

/**
 * Appends a fallback `access_token` to realtime (WS/SSE) URLs. The session
 * cookie rides the WebSocket handshake automatically through the Vite proxy,
 * so this is only used when a fallback bearer token is stored.
 */
export function addAccessTokenSearchParam(url: string): string {
  const token = getStoredAccessToken();
  if (token === null) {
    return url;
  }
  const parsed = new URL(
    url,
    typeof window === "undefined" ? "http://localhost" : window.location.href,
  );
  parsed.searchParams.set("access_token", token);
  return parsed.toString();
}

/** Signs in with email + password via Better-Auth. Sets the session cookie. */
export async function signInWithEmail(
  input: SignInInput,
  fetchImpl: AuthFetch = fetch,
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
  const user = sessionUserFromOutput(output);
  if (user === null) {
    throw new Error("Sign-in response was missing the user record.");
  }
  return user;
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
export async function getSessionUser(fetchImpl: AuthFetch = fetch): Promise<SessionUser | null> {
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

/** Signs the current session out via Better-Auth and clears any fallback token. */
export async function signOut(fetchImpl: AuthFetch = fetch): Promise<void> {
  try {
    // A non-empty JSON body is required: Fastify rejects an empty body when
    // the content-type is application/json.
    await fetchImpl("/api/auth/sign-out", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } finally {
    clearStoredAccessToken();
  }
}

function headersWithBearer(headers: HeadersInit | undefined, token: string): Headers {
  const next = new Headers(headers);
  if (!next.has("authorization")) {
    next.set("authorization", `Bearer ${token}`);
  }
  return next;
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
    // Better-Auth may serialize the actor link in either casing.
    actorId: stringOrNull(user.actorId) ?? stringOrNull(user.actor_id),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
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
