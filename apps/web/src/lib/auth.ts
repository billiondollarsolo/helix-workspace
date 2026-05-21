export const HELIX_ACCESS_TOKEN_STORAGE_KEY = "helix.accessToken";

export interface OAuthClientCredentialsInput {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope?: string;
}

export interface OAuthTokenResponse {
  readonly accessToken: string;
  readonly tokenType: "Bearer";
  readonly expiresIn: number;
  readonly scope: string;
}

export type AuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

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

export function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const token = getStoredAccessToken();
  if (token === null) {
    return fetch(input, init);
  }
  return fetch(input, {
    ...init,
    headers: headersWithBearer(init?.headers, token),
  });
}

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

export async function requestOAuthClientCredentialsToken(
  input: OAuthClientCredentialsInput,
  fetchImpl: AuthFetch = fetch,
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    ...(input.scope === undefined || input.scope.trim().length === 0
      ? {}
      : { scope: input.scope.trim() }),
  });
  const response = await fetchImpl("/oauth/token", {
    method: "POST",
    headers: {
      authorization: `Basic ${base64Encode(`${input.clientId}:${input.clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const output: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      errorMessageFromOutput(output) ??
        `OAuth token request failed with ${String(response.status)}`,
    );
  }
  if (!isOAuthTokenOutput(output)) {
    throw new Error("OAuth token response was missing required fields.");
  }
  return {
    accessToken: output.access_token,
    tokenType: output.token_type,
    expiresIn: output.expires_in,
    scope: output.scope,
  };
}

function headersWithBearer(headers: HeadersInit | undefined, token: string): Headers {
  const next = new Headers(headers);
  if (!next.has("authorization")) {
    next.set("authorization", `Bearer ${token}`);
  }
  return next;
}

function isOAuthTokenOutput(value: unknown): value is {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly scope: string;
} {
  return (
    isRecord(value) &&
    typeof value.access_token === "string" &&
    value.token_type === "Bearer" &&
    typeof value.expires_in === "number" &&
    typeof value.scope === "string"
  );
}

function errorMessageFromOutput(output: unknown): string | undefined {
  return isRecord(output) && typeof output.error_description === "string"
    ? output.error_description
    : isRecord(output) && typeof output.error === "string"
      ? output.error
      : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function base64Encode(value: string): string {
  if (typeof btoa === "function") {
    return btoa(value);
  }
  throw new Error("Base64 encoding is unavailable in this runtime.");
}
