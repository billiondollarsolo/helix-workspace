import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerTenantScimRoutes } from "./scim-routes.js";
import type { OrgRecord, OrgStore } from "../tenancy/orgs.js";

describe("tenant SCIM discovery routes", () => {
  it("serves ServiceProviderConfig for active tenants without touching login state", async () => {
    const app = fastify();
    await registerTenantScimRoutes(app, {
      orgs: orgStore({ acme: orgRecord({ id: "org-1", slug: "acme" }) }),
      documentationUri: "https://docs.helix.example/scim",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/ServiceProviderConfig",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/scim+json");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: "https://docs.helix.example/scim",
      patch: { supported: false },
      filter: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken", primary: true }],
    });
    await app.close();
  });

  it("serves ResourceTypes and Schemas discovery documents", async () => {
    const app = fastify();
    await registerTenantScimRoutes(app, {
      orgs: orgStore({ acme: orgRecord({ id: "org-1", slug: "acme" }) }),
    });

    const resourceTypes = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/ResourceTypes",
    });
    const schemas = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/Schemas",
    });

    expect(resourceTypes.statusCode).toBe(200);
    expect(resourceTypes.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 2,
      Resources: [
        {
          id: "User",
          endpoint: "/api/scim/v2/acme/Users",
          schema: "urn:ietf:params:scim:schemas:core:2.0:User",
        },
        {
          id: "Group",
          endpoint: "/api/scim/v2/acme/Groups",
          schema: "urn:ietf:params:scim:schemas:core:2.0:Group",
        },
      ],
    });
    expect(schemas.statusCode).toBe(200);
    expect(schemas.json()).toMatchObject({
      totalResults: 2,
      Resources: [
        { id: "urn:ietf:params:scim:schemas:core:2.0:User" },
        { id: "urn:ietf:params:scim:schemas:core:2.0:Group" },
      ],
    });
    await app.close();
  });

  it("returns SCIM errors for unimplemented Users and Groups provisioning", async () => {
    const app = fastify();
    await registerTenantScimRoutes(app, {
      orgs: orgStore({ acme: orgRecord({ id: "org-1", slug: "acme" }) }),
    });

    const users = await app.inject({ method: "GET", url: "/api/scim/v2/acme/Users" });
    const groups = await app.inject({ method: "POST", url: "/api/scim/v2/acme/Groups" });

    expect(users.statusCode).toBe(501);
    expect(users.headers["content-type"]).toContain("application/scim+json");
    expect(users.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "501",
      detail: "Users SCIM provisioning is not implemented yet.",
    });
    expect(groups.statusCode).toBe(501);
    expect(groups.json()).toMatchObject({
      status: "501",
      detail: "Groups SCIM provisioning is not implemented yet.",
    });
    await app.close();
  });

  it("does not serve SCIM discovery for invalid, missing, or inactive tenants", async () => {
    const app = fastify();
    await registerTenantScimRoutes(app, {
      orgs: orgStore({
        suspended: orgRecord({ id: "org-suspended", slug: "suspended", status: "suspended" }),
      }),
    });

    const invalid = await app.inject({
      method: "GET",
      url: "/api/scim/v2/Bad_Tenant/ServiceProviderConfig",
    });
    const missing = await app.inject({
      method: "GET",
      url: "/api/scim/v2/missing/ServiceProviderConfig",
    });
    const suspended = await app.inject({
      method: "GET",
      url: "/api/scim/v2/suspended/ServiceProviderConfig",
    });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.headers["content-type"]).toContain("application/scim+json");
    expect(invalid.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "400",
      detail: "Invalid SCIM tenant slug.",
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers["content-type"]).toContain("application/scim+json");
    expect(missing.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "404",
      detail: "SCIM tenant was not found.",
    });
    expect(suspended.statusCode).toBe(404);
    expect(suspended.headers["content-type"]).toContain("application/scim+json");
    expect(suspended.json()).toMatchObject({
      status: "404",
      detail: "SCIM tenant was not found.",
    });
    await app.close();
  });
});

function orgStore(orgs: Record<string, OrgRecord>): Pick<OrgStore, "findBySlug"> {
  return {
    async findBySlug(slug) {
      return orgs[slug] ?? null;
    },
  };
}

function orgRecord(overrides: Partial<OrgRecord>): OrgRecord {
  return {
    id: "org-1",
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
    ...overrides,
  };
}
