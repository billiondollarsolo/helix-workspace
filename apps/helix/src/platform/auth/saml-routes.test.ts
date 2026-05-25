import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { InMemoryTenantIdpConfigStore } from "./tenant-idp-configs.js";
import { registerTenantSamlRoutes, renderSamlServiceProviderMetadata } from "./saml-routes.js";
import type { OrgRecord, OrgStore } from "../tenancy/orgs.js";

describe("tenant SAML routes", () => {
  it("serves SP metadata for the tenant primary SAML IdP without starting login", async () => {
    const idpConfigs = new InMemoryTenantIdpConfigStore();
    await idpConfigs.create({
      orgId: "org-1",
      protocol: "saml",
      displayName: "Acme Okta",
      config: { metadataUrl: "https://idp.example.com/metadata" },
    });
    const app = fastify();
    await registerTenantSamlRoutes(app, {
      orgs: orgStore({ acme: orgRecord({ id: "org-1", slug: "acme" }) }),
      idpConfigs,
      publicBaseUrl: "https://app.helix.example",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/saml/acme/metadata",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/samlmetadata+xml");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain(
      'entityID="https://app.helix.example/api/auth/saml/acme/metadata"',
    );
    expect(response.body).toContain('Location="https://app.helix.example/api/auth/saml/acme/acs"');
    expect(response.body).toContain('WantAssertionsSigned="true"');
    await app.close();
  });

  it("takes precedence over the generic BetterAuth /api/auth/* route", async () => {
    const idpConfigs = new InMemoryTenantIdpConfigStore();
    await idpConfigs.create({
      orgId: "org-1",
      protocol: "saml",
      displayName: "Acme Okta",
    });
    const app = fastify();
    app.route({
      method: ["GET", "POST"],
      url: "/api/auth/*",
      handler: async () => ({ betterAuth: true }),
    });
    await registerTenantSamlRoutes(app, {
      orgs: orgStore({ acme: orgRecord({ id: "org-1", slug: "acme" }) }),
      idpConfigs,
      publicBaseUrl: "https://app.helix.example",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/saml/acme/metadata",
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("<md:EntityDescriptor");
    expect(response.body).not.toContain("betterAuth");
    await app.close();
  });

  it("does not serve SAML metadata for missing tenants, inactive tenants, or OIDC primaries", async () => {
    const idpConfigs = new InMemoryTenantIdpConfigStore();
    await idpConfigs.create({
      orgId: "org-oidc",
      protocol: "oidc",
      displayName: "Acme OIDC",
    });
    const app = fastify();
    await registerTenantSamlRoutes(app, {
      orgs: orgStore({
        suspended: orgRecord({ id: "org-suspended", slug: "suspended", status: "suspended" }),
        oidc: orgRecord({ id: "org-oidc", slug: "oidc" }),
      }),
      idpConfigs,
    });

    const missing = await app.inject({ method: "GET", url: "/api/auth/saml/missing/metadata" });
    const suspended = await app.inject({
      method: "GET",
      url: "/api/auth/saml/suspended/metadata",
    });
    const oidc = await app.inject({ method: "GET", url: "/api/auth/saml/oidc/metadata" });

    expect(missing.statusCode).toBe(404);
    expect(suspended.statusCode).toBe(404);
    expect(oidc.statusCode).toBe(404);
    await app.close();
  });
});

describe("renderSamlServiceProviderMetadata", () => {
  it("escapes XML attributes derived from deployment URLs", () => {
    const metadata = renderSamlServiceProviderMetadata({
      baseUrl: "https://helix.example/a&b",
      tenantSlug: "acme",
    });

    expect(metadata).toContain("https://helix.example/a&amp;b/api/auth/saml/acme/metadata");
    expect(metadata).toContain("https://helix.example/a&amp;b/api/auth/saml/acme/acs");
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
