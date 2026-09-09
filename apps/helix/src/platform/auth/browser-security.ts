import { randomBytes, timingSafeEqual } from "node:crypto";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const csrfCookieNames = ["__Host-helix_csrf", "helix_csrf"] as const;

export function browserSecurityHeaders(input: {
  readonly production: boolean;
  readonly jitsiPublicUrl?: string | undefined;
}): Readonly<Record<string, string>> {
  const frameOrigin = configuredOrigin(input.jitsiPublicUrl);
  const frameSources = ["'self'", ...(frameOrigin === null ? [] : [frameOrigin])].join(" ");
  return {
    ...(input.production
      ? { "strict-transport-security": "max-age=31536000; includeSubDomains; preload" }
      : {}),
    "content-security-policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "media-src 'self' blob:",
      "connect-src 'self' https: wss:",
      "worker-src 'self' blob:",
      `frame-src ${frameSources}`,
    ].join("; "),
    "permissions-policy":
      "camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), geolocation=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin-allow-popups",
    "cross-origin-resource-policy": "same-origin",
    "origin-agent-cluster": "?1",
  };
}

export function normalizeTrustedOrigins(values: readonly string[]): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const value of values) {
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") {
        origins.add(url.origin);
      }
    } catch {
      // Invalid configured origins are ignored; callers therefore fail closed.
    }
  }
  return origins;
}

export function isTrustedCorsOrigin(
  origin: string | undefined,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  return origin === undefined || normalizedOrigin(origin, trustedOrigins) !== null;
}

/** Origin-based CSRF defense for writes authenticated by the Helix session cookie. */
export function isTrustedCookieMutation(input: {
  readonly method: string;
  readonly origin?: string | undefined;
  readonly cookie?: string | undefined;
  readonly csrfToken?: string | undefined;
  readonly trustedOrigins: ReadonlySet<string>;
}): boolean {
  if (SAFE_METHODS.has(input.method.toUpperCase()) || !hasSessionCookie(input.cookie)) {
    return true;
  }
  const cookieToken = csrfTokenFromCookie(input.cookie);
  return (
    normalizedOrigin(input.origin, input.trustedOrigins) !== null &&
    cookieToken !== null &&
    validCsrfToken(input.csrfToken) &&
    timingSafeEqual(Buffer.from(cookieToken), Buffer.from(input.csrfToken))
  );
}

export function createCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export function csrfTokenFromCookie(cookie: string | undefined): string | null {
  for (const part of cookie?.split(";") ?? []) {
    const [name, value] = part.trim().split("=", 2);
    if (
      csrfCookieNames.includes(name as (typeof csrfCookieNames)[number]) &&
      validCsrfToken(value)
    ) {
      return value;
    }
  }
  return null;
}

export function serializeCsrfCookie(token: string, secure: boolean): string {
  if (!validCsrfToken(token)) {
    throw new TypeError("CSRF token is invalid.");
  }
  return [
    `${secure ? "__Host-" : ""}helix_csrf=${token}`,
    "Path=/",
    "SameSite=Strict",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

function normalizedOrigin(
  value: string | undefined,
  trustedOrigins: ReadonlySet<string>,
): string | null {
  if (value === undefined || value === "null") {
    return null;
  }
  try {
    const origin = new URL(value).origin;
    return trustedOrigins.has(origin) ? origin : null;
  } catch {
    return null;
  }
}

function hasSessionCookie(cookie: string | undefined): boolean {
  return (
    cookie?.split(";").some((part) => /^(?:__Secure-)?helix_session=/u.test(part.trim())) ?? false
  );
}

function validCsrfToken(value: string | undefined): value is string {
  return value !== undefined && CSRF_TOKEN_PATTERN.test(value);
}

function configuredOrigin(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}
