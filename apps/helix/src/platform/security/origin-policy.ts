import cors from "@fastify/cors";
import type { FastifyInstance, FastifyRequest } from "fastify";

const HTTP_PROTOCOLS = new Set(["http:", "https:"]);

type HeaderValue = string | readonly string[] | undefined;

/**
 * Parse a comma-separated exact-origin allowlist into canonical URL origins.
 *
 * Entries are deliberately limited to HTTP(S) origins. Paths, credentials,
 * query strings, fragments, wildcards, regex-like values, and opaque origins
 * are rejected so callers cannot accidentally reintroduce origin reflection.
 */
export function parseTrustedOrigins(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) {
    return Object.freeze([]);
  }

  const origins = new Set<string>();
  for (const entry of value.split(",")) {
    const candidate = entry.trim();
    if (candidate.length === 0) {
      continue;
    }
    origins.add(parseExactOrigin(candidate));
  }
  return Object.freeze([...origins]);
}

/** Return true only when a request Origin exactly matches the configured set. */
export function isTrustedOrigin(
  origin: string | undefined,
  trustedOrigins: readonly string[],
): boolean {
  if (origin === undefined) {
    return false;
  }
  try {
    return trustedOrigins.includes(parseRequestOrigin(origin));
  } catch {
    return false;
  }
}

/**
 * Install exact CORS handling plus an enforcement hook.
 *
 * CORS response headers alone do not stop a credentialed cross-origin request
 * from reaching a mutating handler. The hook therefore rejects an untrusted
 * Origin whenever browser or service credentials are present. Requests without
 * Origin remain available to non-browser clients; individual browser socket
 * routes apply the stricter missing-Origin policy in
 * {@link evaluateWebSocketOrigin}.
 */
export async function installTrustedOriginPolicy(
  app: FastifyInstance,
  trustedOrigins: readonly string[],
): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    const origin = firstHeaderValue(request.headers.origin);
    if (
      origin !== undefined &&
      !isTrustedOrigin(origin, trustedOrigins) &&
      requestCarriesCredentials(request)
    ) {
      return reply.code(403).send({
        error: {
          code: "forbidden",
          message: "Request origin is not trusted.",
        },
      });
    }
  });

  await app.register(cors, {
    credentials: true,
    origin: (origin, callback) => {
      callback(null, isTrustedOrigin(origin, trustedOrigins));
    },
  });
}

export type WebSocketOriginDecision =
  | { readonly allowed: true; readonly browser: true }
  | {
      readonly allowed: true;
      readonly browser: false;
      readonly initialCredential: boolean;
    }
  | { readonly allowed: false; readonly reason: "missing_origin_with_cookie" | "untrusted_origin" };

/**
 * Apply the Chat WebSocket browser/service-client boundary.
 *
 * Browsers send Origin and may authenticate with their secure session cookie.
 * A missing Origin is accepted only as the explicitly documented non-browser
 * path: cookies are forbidden, and the client must either present a service
 * credential during upgrade or complete the bounded first-frame bearer
 * handshake.
 */
export function evaluateWebSocketOrigin(
  request: FastifyRequest,
  trustedOrigins: readonly string[],
): WebSocketOriginDecision {
  const origin = firstHeaderValue(request.headers.origin);
  if (origin !== undefined) {
    return isTrustedOrigin(origin, trustedOrigins)
      ? { allowed: true, browser: true }
      : { allowed: false, reason: "untrusted_origin" };
  }

  if (firstHeaderValue(request.headers.cookie) !== undefined) {
    return { allowed: false, reason: "missing_origin_with_cookie" };
  }

  return {
    allowed: true,
    browser: false,
    initialCredential: hasNonBrowserUpgradeCredential(request),
  };
}

/** Credentials a browser WebSocket constructor cannot attach itself. */
export function hasNonBrowserUpgradeCredential(request: FastifyRequest): boolean {
  return [
    request.headers.authorization,
    request.headers["x-api-key"],
    request.headers["x-helix-client-cert-fingerprint"],
  ].some((value) => firstHeaderValue(value) !== undefined);
}

function requestCarriesCredentials(request: FastifyRequest): boolean {
  return [
    request.headers.authorization,
    request.headers.cookie,
    request.headers["x-api-key"],
    request.headers["x-helix-client-cert-fingerprint"],
    request.headers["x-helix-actor-id"],
    request.headers["x-helix-org-id"],
  ].some((value) => firstHeaderValue(value) !== undefined);
}

function parseExactOrigin(value: string): string {
  if (value === "*" || value === "null" || value.startsWith("/") || value.endsWith("/u")) {
    throw new TypeError(`Invalid trusted origin entry: ${safeOriginLabel(value)}`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`Invalid trusted origin entry: ${safeOriginLabel(value)}`);
  }

  if (
    !HTTP_PROTOCOLS.has(url.protocol) ||
    url.origin === "null" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new TypeError(`Invalid trusted origin entry: ${safeOriginLabel(value)}`);
  }
  return url.origin;
}

function parseRequestOrigin(value: string): string {
  if (value.trim() !== value || value.includes(",") || value === "null") {
    throw new TypeError("Invalid request origin.");
  }
  const url = new URL(value);
  if (
    !HTTP_PROTOCOLS.has(url.protocol) ||
    url.origin === "null" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    value.endsWith("/")
  ) {
    throw new TypeError("Invalid request origin.");
  }
  return url.origin;
}

function safeOriginLabel(value: string): string {
  try {
    const url = new URL(value);
    return url.origin === "null" ? "(invalid)" : url.origin;
  } catch {
    return "(invalid)";
  }
}

function firstHeaderValue(value: HeaderValue): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  const first = value?.[0]?.trim();
  return first === undefined || first.length === 0 ? undefined : first;
}
