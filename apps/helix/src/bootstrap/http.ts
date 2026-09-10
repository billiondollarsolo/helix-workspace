import { ContractValidationError } from "@helix/contracts";
import type { FastifyInstance } from "fastify";
import fastify from "fastify";
import { ZodError } from "zod";
import { ApiError } from "../api/api-error.js";
import { trustedProxyAddresses } from "../api/client-ip.js";
import { buildErrorEnvelope } from "../api/error-envelope.js";
import { createPlatformMetrics } from "../api/metrics.js";
import { API_BODY_LIMIT_BYTES, API_REQUEST_TIMEOUT_MS } from "../api/request-body.js";
import { HELIX_API_VERSION_HEADER_VALUE } from "../api/version.js";
import { env } from "../config/env.js";
import { browserSecurityHeaders } from "../platform/auth/browser-security.js";
import { helixLoggerOptions } from "../platform/security/logger-redaction.js";
import { parseTrustedOrigins } from "../platform/security/origin-policy.js";
import { TenantActorMismatchError, TenantResolutionError } from "../platform/tenancy/index.js";
import {
  CredentialAuthError,
  installUntrustedIdentityHeaderGuard,
  traceIdForRequest,
} from "./request-principal.js";

export async function installHttp() {
  const bootEnv = env();

  const trustedOrigins = parseTrustedOrigins(bootEnv.BETTER_AUTH_TRUSTED_ORIGINS);

  const trustedProxies = trustedProxyAddresses(bootEnv.HELIX_TRUSTED_PROXIES);

  const app: FastifyInstance = fastify({
    logger: helixLoggerOptions(bootEnv.LOG_LEVEL),
    ...(trustedProxies.length === 0 ? {} : { trustProxy: [...trustedProxies] }),
    // Binary uploads bypass the API tier through scoped storage URLs. Keep
    // JSON control-plane requests small and terminate slow bodies promptly.
    bodyLimit: API_BODY_LIMIT_BYTES,
    requestTimeout: API_REQUEST_TIMEOUT_MS,
    // Tool routes carry signed pending-action ids and other long path
    // segments; Fastify's default `maxParamLength` of 100 silently 404s
    // anything longer. 2 KB matches the URL-segment ceiling most reverse
    // proxies tolerate without rejecting the request outright.
    routerOptions: {
      maxParamLength: 2048,
    },
  });

  if (bootEnv.NODE_ENV === "production" && bootEnv.HELIX_AI_ALLOW_PRIVATE_NETWORK === "true") {
    app.log.warn(
      "HELIX_AI_ALLOW_PRIVATE_NETWORK=true permits AI provider access to private networks",
    );
  }

  const metrics = createPlatformMetrics();

  const responseSecurityHeaders = browserSecurityHeaders({
    production: bootEnv.NODE_ENV === "production",
    jitsiPublicUrl: bootEnv.MEET_JITSI_PUBLIC_URL,
  });

  // P1-10: advertise the API version on every response so clients can detect
  // the contract they are talking to without parsing the OpenAPI document.
  app.addHook("onSend", async (_request, reply) => {
    if (!reply.hasHeader("api-version")) {
      reply.header("api-version", HELIX_API_VERSION_HEADER_VALUE);
    }
    for (const [name, value] of Object.entries(responseSecurityHeaders)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
  });

  installUntrustedIdentityHeaderGuard(app);

  // PRD §9.2: a presented-but-rejected API-key / mTLS credential surfaces as a
  // CredentialAuthError; map it to the carried 401/403 canonical error
  // envelope rather than a generic 500. ApiError / ContractValidationError /
  // ZodError share the same envelope path (G4).
  app.setErrorHandler((error, request, reply) => {
    const traceId = traceIdForRequest(request);
    if (error instanceof ApiError) {
      if (error.retryAfterSeconds !== undefined) {
        reply.header("retry-after", String(error.retryAfterSeconds));
      }
      const details =
        error.details !== undefined &&
        typeof error.details === "object" &&
        error.details !== null &&
        !Array.isArray(error.details)
          ? (error.details as Record<string, unknown>)
          : error.details !== undefined
            ? { value: error.details }
            : undefined;
      return reply.code(error.statusCode).send(
        buildErrorEnvelope({
          statusCode: error.statusCode,
          code: error.code,
          message: error.message,
          traceId,
          ...(details === undefined ? {} : { details }),
        }),
      );
    }
    if (error instanceof ContractValidationError) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: error.message,
          traceId,
          details: { issues: error.issues },
        }),
      );
    }
    if (error instanceof ZodError) {
      return reply.code(400).send(
        buildErrorEnvelope({
          statusCode: 400,
          code: "bad_request",
          message: "Request validation failed",
          traceId,
          details: {
            issues: error.issues.map((i) => ({
              path: i.path,
              message: i.message,
            })),
          },
        }),
      );
    }
    if (error instanceof CredentialAuthError) {
      return reply.code(error.statusCode).send(
        buildErrorEnvelope({
          statusCode: error.statusCode,
          code: error.code,
          message: error.message,
          traceId,
        }),
      );
    }
    if (error instanceof TenantResolutionError) {
      return reply.code(error.statusCode).send(
        buildErrorEnvelope({
          statusCode: error.statusCode,
          code: error.code,
          message: error.message,
          traceId,
        }),
      );
    }
    if (error instanceof TenantActorMismatchError) {
      return reply.code(error.statusCode).send(
        buildErrorEnvelope({
          statusCode: error.statusCode,
          code: error.code,
          message: error.message,
          traceId,
        }),
      );
    }
    throw error;
  });

  app.setNotFoundHandler((request, reply) => {
    const traceId = traceIdForRequest(request);
    return reply.code(404).send(
      buildErrorEnvelope({
        statusCode: 404,
        code: "not_found",
        message: `Route ${request.method} ${request.url} not found`,
        traceId,
      }),
    );
  });
  return { bootEnv, trustedOrigins, app, metrics };
}
