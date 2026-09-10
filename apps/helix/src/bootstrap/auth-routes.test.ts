import { SYSTEM_TENANT_CONFIG, type Actor } from "@helix/sdk-types";
import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../platform/tenancy/context.js";
import { registerBetterAuthRoutes } from "./auth-routes.js";
import { registerCanonicalApi } from "./route-scope.js";

const tenant: TenantContext = {
  orgId: "b7300000-0000-4000-8000-000000000001",
  orgSlug: "profiles",
  orgTier: "personal",
  orgRegion: "default",
  effectiveConfig: SYSTEM_TENANT_CONFIG,
  org: {
    id: "b7300000-0000-4000-8000-000000000001",
    slug: "profiles",
    displayName: "Profiles",
    status: "active",
    tier: "personal",
    planId: "personal",
    region: "default",
    byoConfig: {},
    featureFlags: {},
    quotas: {},
    branding: {},
    suspendedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
  },
};
const actor: Actor = {
  id: "b7300000-0000-4000-8000-000000000002",
  orgId: tenant.orgId,
  type: "user",
  displayName: "Tenant name",
};
const nativeSession = {
  user: {
    id: "global-auth-id",
    name: "Global name",
    email: "person@example.com",
    emailVerified: true,
  },
  session: { id: "session-id" },
};

describe("Better Auth tenant profile projection", () => {
  it.each([
    { principal: actor, resolvedTenant: tenant, expectedName: "Tenant name", resolves: 1 },
    { principal: null, resolvedTenant: tenant, expectedName: "Global name", resolves: 1 },
    { principal: actor, resolvedTenant: null, expectedName: "Global name", resolves: 0 },
    {
      principal: { ...actor, orgId: "other-org" },
      resolvedTenant: tenant,
      expectedName: "Global name",
      resolves: 1,
    },
  ])(
    "projects only a valid tenant membership ($expectedName, $resolves)",
    async ({ principal, resolvedTenant, expectedName, resolves }) => {
      const app = fastify();
      app.decorateRequest("tenant", null);
      app.addHook("preHandler", async (request) => {
        request.tenant = resolvedTenant;
      });
      const resolve = vi.fn(async () => principal);
      const handler = vi.fn(async () => Response.json(nativeSession));
      await registerCanonicalApi(app, async (api) => {
        registerBetterAuthRoutes(
          api,
          {
            api: { getSession: async () => nativeSession },
            handler,
          },
          undefined,
          undefined,
          undefined,
          undefined,
          { resolve },
        );
      });
      try {
        const response = await app.inject("/v1/api/auth/get-session?disableCookieCache=true");
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          user: { ...nativeSession.user, name: expectedName },
          session: nativeSession.session,
        });
        expect(resolve).toHaveBeenCalledTimes(resolves);
        if (expectedName === "Tenant name") {
          expect(response.json().user).toMatchObject({ actorId: actor.id, orgId: tenant.orgId });
        } else {
          expect(response.json()).toEqual(nativeSession);
        }
        expect(handler).toHaveBeenCalledTimes(1);
        expect(nativeSession.user.name).toBe("Global name");
      } finally {
        await app.close();
      }
    },
  );

  it("preserves signed-out sessions without attempting actor resolution", async () => {
    const app = fastify();
    const resolve = vi.fn(async () => actor);
    app.decorateRequest("tenant", null);
    app.addHook("preHandler", async (request) => {
      request.tenant = tenant;
    });
    registerBetterAuthRoutes(
      app,
      { api: { getSession: async () => null }, handler: async () => Response.json(null) },
      undefined,
      undefined,
      undefined,
      undefined,
      { resolve },
    );
    try {
      expect((await app.inject("/api/auth/get-session")).json()).toBeNull();
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
