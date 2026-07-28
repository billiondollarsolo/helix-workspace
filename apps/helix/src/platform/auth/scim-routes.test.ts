import fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { registerTenantScimRoutes, type ScimAuthAuditSink } from "./scim-routes.js";
import { InMemoryTenantScimCredentialStore, hashScimBearerToken } from "./scim-credentials.js";
import type { OrgRecord, OrgStore } from "../tenancy/orgs.js";

const VALID_TOKEN = "scim-test-token-AcMe-0123456789";
const OTHER_TENANT_TOKEN = "scim-test-token-other-tenant-9876";
const ORG_ID = "11111111-1111-1111-1111-111111111111";

interface Harness {
  readonly app: FastifyInstance;
  readonly credentials: InMemoryTenantScimCredentialStore;
  readonly audit: RecordingAuditSink;
}

async function buildHarness(
  orgs: Record<string, OrgRecord>,
  options: {
    readonly seedToken?: string | undefined;
    readonly seedOrgId?: string | undefined;
    readonly omitCredentials?: boolean;
  } = {},
): Promise<Harness> {
  const app = fastify();
  const credentials = new InMemoryTenantScimCredentialStore();
  if (options.seedToken !== undefined) {
    await credentials.upsert({
      orgId: options.seedOrgId ?? ORG_ID,
      tokenHash: await hashScimBearerToken(options.seedToken),
    });
  }
  const audit = new RecordingAuditSink();
  await registerTenantScimRoutes(app, {
    orgs: orgStoreFromMap(orgs),
    ...(options.omitCredentials === true ? {} : { credentials }),
    auditSink: audit,
    documentationUri: "https://docs.helix.example/scim",
  });
  return { app, credentials, audit };
}

describe("tenant SCIM auth gating", () => {
  it("returns 401 with SCIM error envelope when Authorization header is missing", async () => {
    const { app, audit } = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      { seedToken: VALID_TOKEN },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/ServiceProviderConfig",
    });

    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/scim+json");
    expect(response.headers["www-authenticate"]).toContain("Bearer");
    expect(response.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      status: "401",
      detail: "SCIM authentication required.",
    });
    expect(audit.records).toContainEqual(
      expect.objectContaining({
        verb: "scim.auth.failed",
      }),
    );
    expect(audit.records.at(-1)?.metadata).toMatchObject({ reason: "missing_bearer" });
    await app.close();
  });

  it("returns 401 (not 404) for missing tenants so existence cannot be probed", async () => {
    const { app } = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      { seedToken: VALID_TOKEN },
    );

    const missing = await app.inject({
      method: "GET",
      url: "/api/scim/v2/does-not-exist/ServiceProviderConfig",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({ status: "401" });
    await app.close();
  });

  it("returns 401 (not 404) for suspended tenants so status cannot be probed", async () => {
    const { app } = await buildHarness(
      {
        suspended: orgRecord({
          id: ORG_ID,
          slug: "suspended",
          status: "suspended",
        }),
      },
      { seedToken: VALID_TOKEN },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/scim/v2/suspended/ServiceProviderConfig",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 (not 400) for malformed slugs so the regex shape is not leaked", async () => {
    const { app } = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      { seedToken: VALID_TOKEN },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/scim/v2/Bad_Tenant/ServiceProviderConfig",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ status: "401" });
    await app.close();
  });

  it("returns 401 when the tenant has no SCIM credential configured", async () => {
    const { app, audit } = await buildHarness({
      acme: orgRecord({ id: ORG_ID, slug: "acme" }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/ServiceProviderConfig",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(response.statusCode).toBe(401);
    expect(audit.records.at(-1)?.metadata).toMatchObject({
      reason: "no_credential_configured",
    });
    await app.close();
  });

  it("returns 401 when the credential store is not wired up at all", async () => {
    const { app } = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      { omitCredentials: true },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/ServiceProviderConfig",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 for an invalid bearer token (same status as missing tenant)", async () => {
    const { app, audit } = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      { seedToken: VALID_TOKEN },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/ServiceProviderConfig",
      headers: { authorization: "Bearer not-the-real-token" },
    });

    expect(response.statusCode).toBe(401);
    expect(audit.records.at(-1)).toMatchObject({
      verb: "scim.auth.failed",
      objectType: "scim_endpoint",
    });
    expect(audit.records.at(-1)?.metadata).toMatchObject({
      reason: "invalid_bearer",
      method: "GET",
    });
    // Token bytes must never appear in audit metadata.
    const flatJson = JSON.stringify(audit.records);
    expect(flatJson).not.toContain(VALID_TOKEN);
    expect(flatJson).not.toContain("not-the-real-token");
    await app.close();
  });

  it("returns 401 for a malformed Authorization header (e.g. Basic, empty)", async () => {
    const { app } = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      { seedToken: VALID_TOKEN },
    );

    const variants = [
      "Basic dXNlcjpwYXNz",
      "Bearer",
      "Bearer ",
      "bearer", // case-sensitive on scheme
    ];
    for (const header of variants) {
      const response = await app.inject({
        method: "GET",
        url: "/api/scim/v2/acme/ServiceProviderConfig",
        headers: { authorization: header },
      });
      expect(response.statusCode).toBe(401);
    }
    await app.close();
  });
});

describe("tenant SCIM discovery routes (authenticated)", () => {
  it("serves ServiceProviderConfig only with a valid bearer token", async () => {
    const { app } = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      { seedToken: VALID_TOKEN },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/ServiceProviderConfig",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
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

  it("serves ResourceTypes and Schemas with a valid bearer token", async () => {
    const { app } = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      { seedToken: VALID_TOKEN },
    );

    const headers = { authorization: `Bearer ${VALID_TOKEN}` };
    const resourceTypes = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/ResourceTypes",
      headers,
    });
    const schemas = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/Schemas",
      headers,
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

  it("returns a uniform 501 SCIM error envelope for every Users/Groups verb", async () => {
    const { app } = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      { seedToken: VALID_TOKEN },
    );

    const headers = { authorization: `Bearer ${VALID_TOKEN}` };
    const calls: ReadonlyArray<{
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
      url: string;
      resource: string;
    }> = [
      { method: "GET", url: "/api/scim/v2/acme/Users", resource: "Users" },
      { method: "POST", url: "/api/scim/v2/acme/Users", resource: "Users" },
      { method: "GET", url: "/api/scim/v2/acme/Users/abc", resource: "Users" },
      { method: "PUT", url: "/api/scim/v2/acme/Users/abc", resource: "Users" },
      { method: "PATCH", url: "/api/scim/v2/acme/Users/abc", resource: "Users" },
      { method: "DELETE", url: "/api/scim/v2/acme/Users/abc", resource: "Users" },
      { method: "GET", url: "/api/scim/v2/acme/Groups", resource: "Groups" },
      { method: "POST", url: "/api/scim/v2/acme/Groups", resource: "Groups" },
      { method: "PUT", url: "/api/scim/v2/acme/Groups/abc", resource: "Groups" },
      { method: "PATCH", url: "/api/scim/v2/acme/Groups/abc", resource: "Groups" },
      { method: "DELETE", url: "/api/scim/v2/acme/Groups/abc", resource: "Groups" },
    ];

    for (const call of calls) {
      const response = await app.inject({ method: call.method, url: call.url, headers });
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(501);
      expect(response.headers["content-type"]).toContain("application/scim+json");
      expect(response.json()).toMatchObject({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
        status: "501",
        detail: `${call.resource} SCIM provisioning is not implemented yet.`,
      });
    }
    await app.close();
  });

  it("never lets a token for tenant A unlock tenant B", async () => {
    const otherOrgId = "22222222-2222-2222-2222-222222222222";
    const app = fastify();
    const credentials = new InMemoryTenantScimCredentialStore();
    await credentials.upsert({
      orgId: ORG_ID,
      tokenHash: await hashScimBearerToken(VALID_TOKEN),
    });
    await credentials.upsert({
      orgId: otherOrgId,
      tokenHash: await hashScimBearerToken(OTHER_TENANT_TOKEN),
    });
    await registerTenantScimRoutes(app, {
      orgs: orgStoreFromMap({
        acme: orgRecord({ id: ORG_ID, slug: "acme" }),
        other: orgRecord({ id: otherOrgId, slug: "other" }),
      }),
      credentials,
    });

    const wrong = await app.inject({
      method: "GET",
      url: "/api/scim/v2/other/ServiceProviderConfig",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const right = await app.inject({
      method: "GET",
      url: "/api/scim/v2/other/ServiceProviderConfig",
      headers: { authorization: `Bearer ${OTHER_TENANT_TOKEN}` },
    });

    expect(wrong.statusCode).toBe(401);
    expect(right.statusCode).toBe(200);
    await app.close();
  });
});

class RecordingAuditSink implements ScimAuthAuditSink {
  public readonly records: Array<{
    readonly verb: string;
    readonly objectType: string;
    readonly objectId?: string;
    readonly metadata?: Record<string, unknown>;
  }> = [];

  async append(record: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly objectType: string;
    readonly objectId?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<{ readonly id: string }> {
    this.records.push({
      verb: record.verb,
      objectType: record.objectType,
      ...(record.objectId === undefined ? {} : { objectId: record.objectId }),
      ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    });
    return { id: "audit-id" };
  }
}

function orgStoreFromMap(orgs: Record<string, OrgRecord>): Pick<OrgStore, "findBySlug"> {
  return {
    async findBySlug(slug) {
      return orgs[slug] ?? null;
    },
  };
}

function orgRecord(overrides: Partial<OrgRecord>): OrgRecord {
  return {
    id: ORG_ID,
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
