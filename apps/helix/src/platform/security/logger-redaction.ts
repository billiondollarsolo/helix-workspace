import type { LoggerOptions } from "pino";

/**
 * Central logging policy for credentials and browser handshake headers.
 *
 * Keep explicit request/response serializer paths as well as common structured
 * aliases: application code and dependencies do not all use the same wrapper
 * key. Message text must still never interpolate a secret.
 */
export const HELIX_LOG_REDACT_PATHS = Object.freeze([
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['sec-websocket-protocol']",
  "request.headers.authorization",
  "request.headers.cookie",
  "request.headers['sec-websocket-protocol']",
  "res.headers['set-cookie']",
  "response.headers['set-cookie']",
  "headers.authorization",
  "headers.cookie",
  "headers['set-cookie']",
  "headers['sec-websocket-protocol']",
  "authorization",
  "cookie",
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

export function helixLoggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: {
      paths: [...HELIX_LOG_REDACT_PATHS],
      censor: "[REDACTED]",
    },
  };
}
