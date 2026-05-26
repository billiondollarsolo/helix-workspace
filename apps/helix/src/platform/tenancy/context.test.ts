import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_ORG_DISPLAY_NAME,
  DEFAULT_ORG_ID,
  DEFAULT_ORG_REGION,
  DEFAULT_ORG_SLUG,
  type OrgRecord,
  type OrgStore,
} from "./orgs.js";
import { extractTenantSlug, resolveTenantContext } from "./context.js";

const defaultOrg = orgRecord({
  id: DEFAULT_ORG_ID,
  slug: DEFAULT_ORG_SLUG,
  displayName: DEFAULT_ORG_DISPLAY_NAME,
  region: DEFAULT_ORG_REGION,
});

describe("tenant slug extraction", () => {
  it("uses the explicit API tenant header before host inference", () => {
    expect(
      extractTenantSlug(requestWith({ host: "beta.helix.app", "x-helix-tenant": "acme-co" })),
    ).toBe("acme-co");
  });

  it("extracts the first subdomain from configured root hosts", () => {
    expect(extractTenantSlug(requestWith({ host: "acme.helix.app" }))).toBe("acme");
    expect(
      extractTenantSlug(requestWith({ host: "acme.preview.helix.example" }), {
        rootHosts: ["preview.helix.example"],
      }),
    ).toBe("acme");
  });

  it("ignores local and invalid tenant hosts", () => {
    expect(extractTenantSlug(requestWith({ host: "localhost:3000" }))).toBeNull();
    expect(extractTenantSlug(requestWith({ host: "127.0.0.1:3000" }))).toBeNull();
    expect(extractTenantSlug(requestWith({ host: "-bad.helix.app" }))).toBeNull();
  });
});

describe("resolveTenantContext", () => {
  it("single-tenant mode always resolves the default org", async () => {
    const store = storeWith({ defaultOrg });
    const context = await resolveTenantContext({
      config: { mode: "single-tenant" },
      orgs: store,
      request: requestWith({ host: "anything.example" }),
    });

    expect(context).toMatchObject({
      orgId: DEFAULT_ORG_ID,
      orgSlug: DEFAULT_ORG_SLUG,
      orgTier: "personal",
      orgRegion: DEFAULT_ORG_REGION,
    });
    expect(store.defaultOrgCalls).toBe(1);
  });

  it("multi-tenant SaaS mode resolves by tenant slug", async () => {
    const acme = orgRecord({
      id: "11111111-1111-4111-8111-111111111111",
      slug: "acme",
      planId: "business",
      featureFlags: { ai_smart_compose: false },
    });
    const context = await resolveTenantContext({
      config: { mode: "multi-tenant-saas" },
      orgs: storeWith({ orgsBySlug: { acme } }),
      plans: {
        async findById(id) {
          expect(id).toBe("business");
          return {
            id,
            displayName: "Business",
            featureFlagsDefault: { ai_smart_compose: true },
            quotasDefault: { actors_limit: null },
          };
        },
      },
      request: requestWith({ host: "acme.helix.app" }),
    });

    expect(context.orgId).toBe(acme.id);
    expect(context.orgSlug).toBe("acme");
    expect(context.effectiveConfig.features.ai_smart_compose).toBe(false);
    expect(context.effectiveConfig.quotas.actors_limit).toBeNull();
  });

  it("requires a tenant slug in multi-tenant SaaS mode", async () => {
    await expect(
      resolveTenantContext({
        config: { mode: "multi-tenant-saas" },
        orgs: storeWith({}),
        request: requestWith({ host: "localhost:3000" }),
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "tenant-required" });
  });

  it("rejects missing, provisioning, and suspended tenants", async () => {
    await expect(
      resolveTenantContext({
        config: { mode: "multi-tenant-saas" },
        orgs: storeWith({}),
        request: requestWith({ host: "missing.helix.app" }),
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "tenant-not-found" });

    await expect(
      resolveTenantContext({
        config: { mode: "multi-tenant-saas" },
        orgs: storeWith({
          orgsBySlug: { acme: orgRecord({ slug: "acme", status: "provisioning" }) },
        }),
        request: requestWith({ host: "acme.helix.app" }),
      }),
    ).rejects.toMatchObject({ statusCode: 423, code: "tenant-provisioning" });

    await expect(
      resolveTenantContext({
        config: { mode: "multi-tenant-saas" },
        orgs: storeWith({
          orgsBySlug: { acme: orgRecord({ slug: "acme", status: "suspended" }) },
        }),
        request: requestWith({ host: "acme.helix.app" }, { method: "GET", url: "/api/tools" }),
      }),
    ).rejects.toMatchObject({ statusCode: 402, code: "tenant-suspended" });
  });

  it("allows only lifecycle recovery routes for suspended and soft-deleted tenants", async () => {
    await expect(
      resolveTenantContext({
        config: { mode: "multi-tenant-saas" },
        orgs: storeWith({
          orgsBySlug: { acme: orgRecord({ slug: "acme", status: "suspended" }) },
        }),
        request: requestWith(
          { host: "acme.helix.app" },
          { method: "POST", url: "/api/admin/tenants/acme/unsuspend" },
        ),
      }),
    ).resolves.toMatchObject({ orgSlug: "acme" });

    await expect(
      resolveTenantContext({
        config: { mode: "multi-tenant-saas" },
        orgs: storeWith({
          orgsBySlug: { acme: orgRecord({ slug: "acme", status: "suspended" }) },
        }),
        request: requestWith(
          { host: "acme.helix.app" },
          { method: "GET", url: "/api/admin/tenants/acme/export" },
        ),
      }),
    ).resolves.toMatchObject({ orgSlug: "acme" });

    await expect(
      resolveTenantContext({
        config: { mode: "multi-tenant-saas" },
        orgs: storeWith({
          orgsBySlug: { acme: orgRecord({ slug: "acme", status: "suspended" }) },
        }),
        request: requestWith(
          { host: "acme.helix.app" },
          { method: "GET", url: "/api/admin/tenants/acme/export/manifest" },
        ),
      }),
    ).resolves.toMatchObject({ orgSlug: "acme" });

    await expect(
      resolveTenantContext({
        config: { mode: "multi-tenant-saas" },
        orgs: storeWith({
          orgsBySlug: { acme: orgRecord({ slug: "acme", status: "suspended" }) },
        }),
        request: requestWith(
          { host: "acme.helix.app" },
          { method: "POST", url: "/api/admin/tenants/acme/export/artifact" },
        ),
      }),
    ).resolves.toMatchObject({ orgSlug: "acme" });

    await expect(
      resolveTenantContext({
        config: { mode: "multi-tenant-saas" },
        orgs: storeWith({
          orgsBySlug: { acme: orgRecord({ slug: "acme", status: "soft_deleted" }) },
        }),
        request: requestWith(
          { host: "acme.helix.app" },
          { method: "POST", url: "/api/admin/tenants/acme/restore" },
        ),
      }),
    ).resolves.toMatchObject({ orgSlug: "acme" });

    await expect(
      resolveTenantContext({
        config: { mode: "multi-tenant-saas" },
        orgs: storeWith({
          orgsBySlug: { acme: orgRecord({ slug: "acme", status: "soft_deleted" }) },
        }),
        request: requestWith(
          { host: "acme.helix.app" },
          { method: "POST", url: "/api/admin/tenants/acme/export/artifact" },
        ),
      }),
    ).resolves.toMatchObject({ orgSlug: "acme" });

    await expect(
      resolveTenantContext({
        config: { mode: "multi-tenant-saas" },
        orgs: storeWith({
          orgsBySlug: { acme: orgRecord({ slug: "acme", status: "soft_deleted" }) },
        }),
        request: requestWith(
          { host: "acme.helix.app" },
          { method: "GET", url: "/api/admin/tenants/acme/export" },
        ),
      }),
    ).resolves.toMatchObject({ orgSlug: "acme" });

    await expect(
      resolveTenantContext({
        config: { mode: "multi-tenant-saas" },
        orgs: storeWith({
          orgsBySlug: { acme: orgRecord({ slug: "acme", status: "soft_deleted" }) },
        }),
        request: requestWith(
          { host: "acme.helix.app" },
          { method: "GET", url: "/api/admin/tenants/acme/export/manifest" },
        ),
      }),
    ).resolves.toMatchObject({ orgSlug: "acme" });

    await expect(
      resolveTenantContext({
        config: { mode: "multi-tenant-saas" },
        orgs: storeWith({
          orgsBySlug: { acme: orgRecord({ slug: "acme", status: "soft_deleted" }) },
        }),
        request: requestWith({ host: "acme.helix.app" }, { method: "GET", url: "/api/tools" }),
      }),
    ).rejects.toMatchObject({ statusCode: 410, code: "tenant-soft-deleted" });

    await expect(
      resolveTenantContext({
        config: { mode: "multi-tenant-saas" },
        orgs: storeWith({
          orgsBySlug: { acme: orgRecord({ slug: "acme", status: "hard_deleted" }) },
        }),
        request: requestWith(
          { host: "acme.helix.app" },
          { method: "POST", url: "/api/admin/tenants/acme/restore" },
        ),
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "tenant-not-found" });
  });
});

function requestWith(
  headers: Record<string, string>,
  overrides: Partial<Pick<FastifyRequest, "method" | "url">> = {},
): FastifyRequest {
  return { headers, method: "GET", url: "/", ...overrides } as FastifyRequest;
}

function orgRecord(overrides: Partial<OrgRecord>): OrgRecord {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    slug: "default",
    displayName: "Default",
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
    ...overrides,
  };
}

function storeWith(input: {
  readonly defaultOrg?: OrgRecord;
  readonly orgsBySlug?: Record<string, OrgRecord>;
}): OrgStore & { readonly defaultOrgCalls: number } {
  let defaultOrgCalls = 0;
  return {
    get defaultOrgCalls() {
      return defaultOrgCalls;
    },
    async createOrg(input) {
      return orgRecord({
        ...(input.id === undefined ? {} : { id: input.id }),
        slug: input.slug,
        displayName: input.displayName,
        status: input.status ?? "provisioning",
      });
    },
    async getOrCreateDefaultOrg() {
      defaultOrgCalls += 1;
      return input.defaultOrg ?? defaultOrg;
    },
    async activateProvisionedOrg(id) {
      const org = Object.values(input.orgsBySlug ?? {}).find((record) => record.id === id);
      return org === undefined ? null : orgRecord({ ...org, status: "active" });
    },
    async findById(id) {
      return Object.values(input.orgsBySlug ?? {}).find((org) => org.id === id) ?? null;
    },
    async findBySlug(slug) {
      return input.orgsBySlug?.[slug] ?? null;
    },
  };
}
