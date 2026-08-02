import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Actor, TenantConfig } from "@helix/sdk-types";
import { enrichActiveSpanWithTenant } from "../observability/tenant-span.js";
import type { TenantContext } from "./context.js";
import {
  RequestTenantIdentityError,
  resolveRequestOrgIdentity,
} from "./request-tenant-identity.js";

declare module "fastify" {
  interface FastifyRequest {
    tenant: TenantContext | null;
    effectiveConfig: TenantConfig | null;
  }
}

export interface TenantContextHookOptions {
  readonly resolveTenantContext: (request: FastifyRequest) => Promise<TenantContext>;
  readonly shouldResolveTenant?: (request: FastifyRequest) => boolean;
}

export class TenantActorMismatchError extends Error {
  readonly statusCode = 403;
  readonly code = "tenant-actor-mismatch";

  constructor(
    readonly tenantOrgId: string,
    readonly actorOrgId: string,
  ) {
    super("Authenticated actor does not belong to the resolved request tenant.");
    this.name = "TenantActorMismatchError";
  }
}

export function installTenantContextHook(
  app: FastifyInstance,
  options: TenantContextHookOptions,
): void {
  app.decorateRequest("tenant", null);
  app.decorateRequest("effectiveConfig", null);
  app.addHook("preHandler", async (request) => {
    if (!(options.shouldResolveTenant ?? shouldResolveTenantForRequest)(request)) {
      request.tenant = null;
      request.effectiveConfig = null;
      return;
    }

    request.tenant = await options.resolveTenantContext(request);
    request.effectiveConfig = request.tenant.effectiveConfig;
    enrichActiveSpanWithTenant(request.tenant);
  });
}

export function shouldResolveTenantForRequest(request: FastifyRequest): boolean {
  if (request.method === "OPTIONS") {
    return false;
  }

  const path = request.url.split("?")[0] ?? "/";
  if (
    path === "/healthz" ||
    path === "/readyz" ||
    path === "/metrics" ||
    path === "/openapi.json" ||
    path === "/openapi.yaml" ||
    path === "/asyncapi.json" ||
    (path.startsWith("/api/auth/saml/") && path.endsWith("/metadata")) ||
    path.startsWith("/api/scim/v2/") ||
    path === "/api/signup" ||
    path === "/api/signup/verify-email" ||
    (path.startsWith("/api/signup/org-slug/") && path.endsWith("/availability")) ||
    path === "/favicon.ico" ||
    path.startsWith("/docs")
  ) {
    return false;
  }

  return true;
}

/**
 * G1.8 — Bind authenticated actors to the resolved request tenant using the
 * shared request-tenant identity helper. Bootstrap `HELIX_DEFAULT_ORG_ID` is
 * never accepted as a request-path substitute here (`defaultOrgId: undefined`).
 */
export function assertActorMatchesRequestTenant(
  request: { readonly tenant?: TenantContext | null },
  actor: Pick<Actor, "id" | "orgId" | "type">,
): void {
  const tenant = request.tenant;
  if (tenant === null || tenant === undefined) {
    return;
  }
  if (actor.id === "anonymous" || actor.type === "system") {
    return;
  }

  try {
    const boundOrgId = resolveRequestOrgIdentity({
      actorOrgId: actor.orgId.length > 0 ? actor.orgId : undefined,
      resolvedTenantOrgId: tenant.orgId,
      // Request auth path must never invent a tenant from the bootstrap default.
      defaultOrgId: undefined,
      bootstrapContext: false,
    });
    if (actor.orgId.length === 0 || boundOrgId !== actor.orgId || boundOrgId !== tenant.orgId) {
      throw new TenantActorMismatchError(tenant.orgId, actor.orgId);
    }
  } catch (error) {
    if (error instanceof RequestTenantIdentityError) {
      throw new TenantActorMismatchError(tenant.orgId, actor.orgId);
    }
    throw error;
  }
}
