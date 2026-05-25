import fastify from "fastify";
import type { FastifyRequest } from "fastify";
import { SYSTEM_TENANT_CONFIG } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import type { TenantContext } from "./context.js";
import {
  TenantActorMismatchError,
  assertActorMatchesRequestTenant,
  installTenantContextHook,
  shouldResolveTenantForRequest,
} from "./middleware.js";

const tenant: TenantContext = {
  orgId: "11111111-1111-4111-8111-111111111111",
  orgSlug: "acme",
  orgTier: "business",
  orgRegion: "us-east-1",
  effectiveConfig: SYSTEM_TENANT_CONFIG,
  org: {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "acme",
    displayName: "Acme",
    status: "active",
    tier: "business",
    planId: "business",
    region: "us-east-1",
    byoConfig: {},
    featureFlags: {},
    quotas: {},
    branding: {},
    suspendedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
  },
};

describe("tenant Fastify hook", () => {
  it("attaches tenant context to tenant-scoped requests", async () => {
    const app = fastify();
    const resolvedUrls: string[] = [];
    installTenantContextHook(app, {
      async resolveTenantContext(request) {
        resolvedUrls.push(request.url);
        return tenant;
      },
    });
    app.get("/api/tools", async (request) => ({
      orgId: request.tenant?.orgId,
      orgSlug: request.tenant?.orgSlug,
      aiSmartCompose: request.effectiveConfig?.features.ai_smart_compose,
    }));

    const response = await app.inject({ method: "GET", url: "/api/tools" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      orgId: tenant.orgId,
      orgSlug: "acme",
      aiSmartCompose: false,
    });
    expect(resolvedUrls).toEqual(["/api/tools"]);
  });

  it("leaves health and documentation surfaces outside tenant resolution", async () => {
    const app = fastify();
    let resolutionCount = 0;
    installTenantContextHook(app, {
      async resolveTenantContext() {
        resolutionCount += 1;
        return tenant;
      },
    });
    app.get("/readyz", async (request) => ({ tenant: request.tenant }));
    app.get("/docs/status", async (request) => ({ tenant: request.tenant }));

    const ready = await app.inject({ method: "GET", url: "/readyz" });
    const docs = await app.inject({ method: "GET", url: "/docs/status" });

    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ tenant: null });
    expect(docs.statusCode).toBe(200);
    expect(docs.json()).toEqual({ tenant: null });
    expect(resolutionCount).toBe(0);
  });

  it("supports route-level opt out for future public endpoints", async () => {
    const app = fastify();
    installTenantContextHook(app, {
      async resolveTenantContext() {
        return tenant;
      },
      shouldResolveTenant: (request) => !request.url.startsWith("/public/"),
    });
    app.get("/public/status", async (request) => ({ tenant: request.tenant }));
    app.get("/api/status", async (request) => ({ tenant: request.tenant?.orgSlug }));

    expect((await app.inject({ method: "GET", url: "/public/status" })).json()).toEqual({
      tenant: null,
    });
    expect((await app.inject({ method: "GET", url: "/api/status" })).json()).toEqual({
      tenant: "acme",
    });
  });
});

describe("tenant resolution route filter", () => {
  it("skips CORS preflight and platform liveness endpoints", () => {
    expect(shouldResolveTenantForRequest(request("OPTIONS", "/api/tools"))).toBe(false);
    expect(shouldResolveTenantForRequest(request("GET", "/healthz"))).toBe(false);
    expect(shouldResolveTenantForRequest(request("GET", "/readyz?probe=1"))).toBe(false);
    expect(shouldResolveTenantForRequest(request("GET", "/metrics"))).toBe(false);
    expect(shouldResolveTenantForRequest(request("GET", "/docs/json"))).toBe(false);
  });

  it("skips public SaaS signup endpoints so tenant resolution does not preempt signup", () => {
    expect(shouldResolveTenantForRequest(request("POST", "/api/signup"))).toBe(false);
    expect(shouldResolveTenantForRequest(request("POST", "/api/signup/verify-email"))).toBe(false);
    expect(
      shouldResolveTenantForRequest(
        request("GET", "/api/signup/org-slug/acme/availability?source=form"),
      ),
    ).toBe(false);
  });

  it("skips public SAML metadata so IdP setup can resolve the tenant from the path", () => {
    expect(shouldResolveTenantForRequest(request("GET", "/api/auth/saml/acme/metadata"))).toBe(
      false,
    );
  });

  it("skips SCIM path-tenant routes so provisioning clients do not need host/header tenancy", () => {
    expect(
      shouldResolveTenantForRequest(request("GET", "/api/scim/v2/acme/ServiceProviderConfig")),
    ).toBe(false);
    expect(shouldResolveTenantForRequest(request("GET", "/api/scim/v2/acme/ResourceTypes"))).toBe(
      false,
    );
    expect(shouldResolveTenantForRequest(request("GET", "/api/scim/v2/acme/Schemas"))).toBe(false);
    expect(shouldResolveTenantForRequest(request("GET", "/api/scim/v2/acme/Users"))).toBe(false);
    expect(shouldResolveTenantForRequest(request("POST", "/api/scim/v2/acme/Groups"))).toBe(false);
  });

  it("resolves tenant context for API and application routes", () => {
    expect(shouldResolveTenantForRequest(request("GET", "/api/tools"))).toBe(true);
    expect(shouldResolveTenantForRequest(request("POST", "/trpc/tools.invoke"))).toBe(true);
  });
});

describe("tenant actor boundary", () => {
  it("allows actors from the resolved tenant", () => {
    expect(() => {
      assertActorMatchesRequestTenant(
        { tenant },
        {
          id: "actor-1",
          orgId: tenant.orgId,
          type: "user",
        },
      );
    }).not.toThrow();
  });

  it("rejects authenticated actors from a different tenant", () => {
    expect(() => {
      assertActorMatchesRequestTenant(
        { tenant },
        {
          id: "actor-1",
          orgId: "99999999-9999-4999-8999-999999999999",
          type: "user",
        },
      );
    }).toThrow(TenantActorMismatchError);
  });

  it("leaves tenantless and anonymous requests to existing auth handling", () => {
    expect(() => {
      assertActorMatchesRequestTenant(
        { tenant: null },
        {
          id: "actor-1",
          orgId: "99999999-9999-4999-8999-999999999999",
          type: "user",
        },
      );
    }).not.toThrow();
    expect(() => {
      assertActorMatchesRequestTenant(
        { tenant },
        {
          id: "anonymous",
          orgId: "00000000-0000-0000-0000-000000000000",
          type: "agent",
        },
      );
    }).not.toThrow();
  });
});

function request(method: string, url: string) {
  return { method, url } as FastifyRequest;
}
