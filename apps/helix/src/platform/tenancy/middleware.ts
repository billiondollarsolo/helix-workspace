import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Actor, TenantConfig } from "@helix/sdk-types";
import type postgres from "postgres";
import { enrichActiveSpanWithTenant } from "../observability/tenant-span.js";
import type { TenantContext } from "./context.js";
import { withTenantPostgresContext } from "./postgres-roles.js";

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

interface TenantRequestTransaction {
  rollbackOnly: boolean;
  finish(commit: boolean): Promise<void>;
}

const tenantRequestRollback = new Error("Tenant request rolled back");

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

/** Keep all store queries for one tenant request in one transaction-local RLS context. */
export function installTenantPostgresContextHook(app: FastifyInstance, sql: postgres.Sql): void {
  const active = new WeakMap<FastifyRequest, TenantRequestTransaction>();

  app.addHook("preHandler", (request, _reply, done) => {
    if (request.tenant === null) {
      done();
      return;
    }

    let release: ((commit: boolean) => void) | undefined;
    let started = false;
    let finished = false;
    const transaction = withTenantPostgresContext(
      sql,
      { orgId: request.tenant.orgId },
      async () => {
        started = true;
        const commit = await new Promise<boolean>((resolve) => {
          release = resolve;
          active.set(request, {
            rollbackOnly: false,
            async finish(shouldCommit) {
              if (!finished) {
                finished = true;
                release?.(shouldCommit);
              }
              try {
                await transaction;
              } catch (error) {
                if (error !== tenantRequestRollback) throw error;
              }
            },
          });
          done();
        });
        if (!commit) throw tenantRequestRollback;
      },
    );

    void transaction.catch((error: unknown) => {
      if (error === tenantRequestRollback) return;
      if (!started) {
        done(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      request.log.error({ error }, "Tenant PostgreSQL transaction failed");
    });
  });

  app.addHook("onError", (request, _reply, _error, done) => {
    const transaction = active.get(request);
    if (transaction !== undefined) transaction.rollbackOnly = true;
    done();
  });

  app.addHook("onSend", async (request, _reply, payload) => {
    const transaction = active.get(request);
    if (transaction === undefined) return payload;
    active.delete(request);
    await transaction.finish(!transaction.rollbackOnly);
    return payload;
  });

  const rollback = async (request: FastifyRequest): Promise<void> => {
    const transaction = active.get(request);
    if (transaction === undefined) return;
    active.delete(request);
    await transaction.finish(false);
  };
  app.addHook("onRequestAbort", rollback);
  app.addHook("onTimeout", rollback);
  app.addHook("onResponse", rollback);
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
    path.startsWith("/api/scim/v2/") ||
    path === "/api/signup" ||
    path === "/api/signup/verify-email" ||
    path === "/api/auth/domain-discovery" ||
    (path.startsWith("/api/signup/org-slug/") && path.endsWith("/availability")) ||
    path === "/favicon.ico" ||
    path.startsWith("/docs")
  ) {
    return false;
  }

  return true;
}

export function assertActorMatchesRequestTenant(
  request: { readonly tenant?: TenantContext | null },
  actor: Pick<Actor, "id" | "orgId" | "type">,
): void {
  const tenant = request.tenant;
  if (tenant === null || tenant === undefined || actor.orgId === tenant.orgId) {
    return;
  }
  if (actor.id === "anonymous" || actor.type === "system") {
    return;
  }
  throw new TenantActorMismatchError(tenant.orgId, actor.orgId);
}
