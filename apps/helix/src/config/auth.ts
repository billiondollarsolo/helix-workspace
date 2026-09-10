import { envValueFlag } from "../platform/util/env.js";

export interface BetterAuthServerConfig {
  readonly databaseUrl: string;
  readonly secret: string;
  readonly baseUrl: string;
  readonly secureCookies: boolean;
  readonly trustedOrigins?: readonly string[];
}

export function getBetterAuthRuntimeConfig(
  env: NodeJS.ProcessEnv,
): BetterAuthServerConfig | undefined {
  if (!envValueFlag(env.BETTER_AUTH_ENABLED ?? "true", true)) {
    if (env.NODE_ENV === "production") {
      throw new TypeError("Better Auth cannot be disabled in production");
    }
    return undefined;
  }
  const databaseUrl = env.BETTER_AUTH_DATABASE_URL ?? env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new TypeError("BETTER_AUTH_DATABASE_URL or DATABASE_URL is required");
  }
  const secret =
    env.BETTER_AUTH_SECRET ??
    (env.NODE_ENV === "production"
      ? undefined
      : "helix_local_better_auth_secret_change_me_32_chars");
  if (secret === undefined || secret.length < 32) {
    throw new TypeError("BETTER_AUTH_SECRET must be at least 32 characters");
  }
  const production = env.NODE_ENV === "production";
  const configuredBaseUrl = env.BETTER_AUTH_URL ?? env.HELIX_PUBLIC_URL ?? env.PUBLIC_BASE_URL;
  if (production && configuredBaseUrl === undefined) {
    throw new TypeError("A canonical HTTPS Better Auth origin is required in production");
  }
  const baseUrl = canonicalHttpOrigin(configuredBaseUrl ?? "http://localhost:3000");
  if (production && !baseUrl.startsWith("https://")) {
    throw new TypeError("Better Auth's production origin must use HTTPS");
  }
  const trustedOrigins = (env.BETTER_AUTH_TRUSTED_ORIGINS ?? env.CLIENT_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return {
    databaseUrl,
    secret,
    baseUrl,
    secureCookies: production,
    ...(trustedOrigins.length === 0 ? {} : { trustedOrigins }),
  };
}

function canonicalHttpOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Better Auth origin must be a valid HTTP(S) origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError("Better Auth origin must contain only an HTTP(S) scheme and authority");
  }
  return url.origin;
}
