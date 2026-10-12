import type { LoggerOptions } from "pino";

/**
 * Central logging policy for credentials and browser handshake headers.
 *
 * Keep explicit request/response serializer paths as well as common structured
 * aliases: application code and dependencies do not all use the same wrapper
 * key. Message text must still never interpolate a secret.
 */
const HELIX_LOG_REDACT_PATHS = Object.freeze([
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-helix-mfa-assertion']",
  "req.headers['sec-websocket-protocol']",
  "request.headers.authorization",
  "request.headers.cookie",
  "request.headers['x-helix-mfa-assertion']",
  "request.headers['sec-websocket-protocol']",
  "res.headers['set-cookie']",
  "response.headers['set-cookie']",
  "headers.authorization",
  "headers.cookie",
  "headers['x-helix-mfa-assertion']",
  "headers['set-cookie']",
  "headers['sec-websocket-protocol']",
  "authorization",
  "cookie",
  "x-helix-mfa-assertion",
  "set-cookie",
  "sec-websocket-protocol",
  "password",
  "secret",
  "token",
  "accessToken",
  "refreshToken",
  "clientSecret",
  "apiKey",
  "*.password",
  "*.secret",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.clientSecret",
  "*.apiKey",
] as const);

/** Query parameters that carry signing material (S3 presigned URLs). */
const SIGNED_URL_PARAMETER =
  /([?&](?:x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&#]*/giu;

/** Replaces signing material in a URL's query string; the rest of the URL stays useful. */
export function redactSignedUrl(url: string): string {
  return url.replace(SIGNED_URL_PARAMETER, "$1[REDACTED]");
}

interface LoggedRequest {
  readonly method?: string;
  readonly url?: string;
  readonly host?: string;
  readonly ip?: string;
  readonly headers?: Readonly<Record<string, string | string[] | undefined>>;
  readonly socket?: { readonly remotePort?: number };
}

export function helixLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: {
      paths: [...HELIX_LOG_REDACT_PATHS],
      censor: "[REDACTED]",
    },
    serializers: {
      // Fastify's request shape, with presigned-URL signatures removed.
      req: (request: LoggedRequest) => ({
        method: request.method,
        url: request.url === undefined ? undefined : redactSignedUrl(request.url),
        version: request.headers?.["accept-version"],
        host: request.host,
        remoteAddress: request.ip,
        remotePort: request.socket?.remotePort,
      }),
      // Most call sites log failures as `{ error }`. Pino only knows `err`, so
      // without this an Error prints as `{}` and operators cannot see the cause.
      error: serializeLoggedError,
    },
  };
}

function serializeLoggedError(value: unknown): unknown {
  if (!(value instanceof Error)) return value;
  const code = (value as { code?: unknown }).code;
  return {
    type: value.name,
    message: scrubCredentials(value.message),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(value.stack === undefined ? {} : { stack: scrubCredentials(value.stack) }),
  };
}

/** Connection errors can echo a URL; never log its embedded credentials. */
function scrubCredentials(text: string): string {
  return text.replace(/\/\/[^@\s/]+@/gu, "//***@");
}
