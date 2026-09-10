import type { FastifyInstance } from "fastify";
import fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { OrgRecord, OrgStore } from "../tenancy/orgs.js";
import {
  InMemoryTenantScimCredentialStore,
  SCIM_CREDENTIAL_SCOPES,
  deriveScimTokenHint,
  hashScimBearerToken,
  scimCredentialIdFromToken,
  type ScimCredentialScope,
} from "./scim-credentials.js";
import {
  ScimConflictError,
  ScimPreconditionError,
  type PutScimGroup,
  type PutScimUser,
  type ScimFilter,
  type ScimGroupRecord,
  type ScimPage,
  type ScimProvisioningStore,
  type ScimUserRecord,
  type ScimWriteResult,
} from "./scim-provisioning.js";
import {
  registerTenantScimRoutes,
  type ScimAuthAuditSink,
  type ScimAuthFailureReason,
} from "./scim-routes.js";

const VALID_TOKEN =
  "helix_scim_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const OTHER_TENANT_TOKEN =
  "helix_scim_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ADMIN_ID = "99999999-9999-4999-8999-999999999999";

interface Harness {
  readonly app: FastifyInstance;
  readonly credentials: InMemoryTenantScimCredentialStore;
  readonly provisioning: TestScimStore;
  readonly audit: RecordingAuditSink;
  readonly metrics: RecordingScimMetrics;
}

async function buildHarness(
  orgs: Record<string, OrgRecord>,
  options: {
    readonly seedToken?: string | undefined;
    readonly seedOrgId?: string | undefined;
    readonly omitCredentials?: boolean;
    readonly scopes?: readonly ScimCredentialScope[] | undefined;
    readonly sourceCidrs?: readonly string[] | undefined;
    readonly expiresAt?: Date | undefined;
  } = {},
): Promise<Harness> {
  const app = fastify();
  const credentials = new InMemoryTenantScimCredentialStore();
  if (options.seedToken !== undefined) {
    await seedCredential(credentials, options.seedOrgId ?? ORG_ID, options.seedToken, {
      scopes: options.scopes,
      sourceCidrs: options.sourceCidrs,
      expiresAt: options.expiresAt,
    });
  }
  const audit = new RecordingAuditSink();
  const metrics = new RecordingScimMetrics();
  const provisioning = new TestScimStore();
  await registerTenantScimRoutes(app, {
    orgs: orgStoreFromMap(orgs),
    ...(options.omitCredentials === true ? {} : { credentials }),
    auditSink: audit,
    metrics,
    provisioning,
    documentationUri: "https://docs.helix.example/scim",
  });
  return { app, credentials, provisioning, audit, metrics };
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
        actorId: null,
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
    expect(audit.records.at(-1)?.metadata).toMatchObject({ reason: "invalid_bearer" });
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
    const { app, audit, metrics } = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      { seedToken: VALID_TOKEN },
    );

    const response = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/ServiceProviderConfig",
      remoteAddress: "198.51.100.2",
      headers: {
        authorization: "Bearer not-the-real-token",
        "x-forwarded-for": "203.0.113.9",
      },
    });

    expect(response.statusCode).toBe(401);
    expect(audit.records.at(-1)).toMatchObject({
      verb: "scim.auth.failed",
      objectType: "scim_endpoint",
    });
    expect(audit.records.at(-1)?.metadata).toMatchObject({
      reason: "invalid_bearer",
      method: "GET",
      sourceIp: "198.51.100.2",
    });
    // Token bytes must never appear in audit metadata.
    const flatJson = JSON.stringify(audit.records);
    expect(flatJson).not.toContain(VALID_TOKEN);
    expect(flatJson).not.toContain("not-the-real-token");
    expect(metrics.reasons).toContain("invalid_bearer");
    await app.close();
  });

  it("enforces credential scope, expiry, revocation, and source policy", async () => {
    const scoped = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      {
        seedToken: VALID_TOKEN,
        scopes: ["scim.groups.read"],
        sourceCidrs: ["198.51.100.0/24"],
      },
    );
    const sourceDenied = await scoped.app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/Groups",
      remoteAddress: "203.0.113.4",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    const scopeDenied = await scoped.app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/Users",
      remoteAddress: "198.51.100.4",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(sourceDenied.statusCode).toBe(401);
    expect(scopeDenied.statusCode).toBe(403);
    expect(scoped.metrics.reasons).toEqual(["source_not_allowed", "insufficient_scope"]);
    await scoped.app.close();

    const expired = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      { seedToken: VALID_TOKEN, expiresAt: new Date(Date.now() - 1_000) },
    );
    const expiredResponse = await expired.app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/ServiceProviderConfig",
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    });
    expect(expiredResponse.statusCode).toBe(401);
    expect(expired.metrics.reasons).toEqual(["credential_expired"]);
    await expired.app.close();
  });

  it("keeps both staged tokens live during rotation, then revokes only the old token", async () => {
    const { app, credentials } = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      { seedToken: VALID_TOKEN },
    );
    await seedCredential(credentials, ORG_ID, OTHER_TENANT_TOKEN);
    const request = (token: string) =>
      app.inject({
        method: "GET",
        url: "/api/scim/v2/acme/ServiceProviderConfig",
        remoteAddress: "198.51.100.8",
        headers: { authorization: `Bearer ${token}` },
      });

    expect((await request(VALID_TOKEN)).statusCode).toBe(200);
    expect((await request(OTHER_TENANT_TOKEN)).statusCode).toBe(200);
    const oldId = scimCredentialIdFromToken(VALID_TOKEN);
    if (oldId === null) throw new Error("Test token must contain a credential id.");
    await credentials.revoke(ORG_ID, oldId, ADMIN_ID);
    expect((await request(VALID_TOKEN)).statusCode).toBe(401);
    expect((await request(OTHER_TENANT_TOKEN)).statusCode).toBe(200);
    const newId = scimCredentialIdFromToken(OTHER_TENANT_TOKEN);
    if (newId === null) throw new Error("Test token must contain a credential id.");
    await expect(credentials.findById(ORG_ID, newId)).resolves.toMatchObject({
      lastUsedIp: "198.51.100.8",
      lastUsedAt: expect.any(Date),
    });
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
      patch: { supported: true },
      filter: { supported: true, maxResults: 200 },
      etag: { supported: true },
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
    const userSchema = await app.inject({
      method: "GET",
      url: `/api/scim/v2/acme/Schemas/${encodeURIComponent("urn:ietf:params:scim:schemas:core:2.0:User")}`,
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
      totalResults: 3,
      Resources: [
        { id: "urn:ietf:params:scim:schemas:core:2.0:User" },
        { id: "urn:ietf:params:scim:schemas:core:2.0:Group" },
        { id: "urn:helix:params:scim:schemas:extension:2.0:User" },
      ],
    });
    expect(userSchema.statusCode).toBe(200);
    expect(userSchema.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
      id: "urn:ietf:params:scim:schemas:core:2.0:User",
    });
    await app.close();
  });

  it("supports idempotent User CRUD, filtering, pagination, ETags, and deprovision transfer", async () => {
    const { app, provisioning } = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      { seedToken: VALID_TOKEN },
    );
    const headers = {
      authorization: `Bearer ${VALID_TOKEN}`,
      "content-type": "application/scim+json",
    };
    const target = await app.inject({
      method: "POST",
      url: "/api/scim/v2/acme/Users",
      headers,
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        externalId: "idp-2",
        userName: "owner@acme.test",
        displayName: "Owner",
      },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/scim/v2/acme/Users",
      headers,
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        externalId: "idp-1",
        userName: "ada@acme.test",
        displayName: "Ada",
        name: { givenName: "Ada", familyName: "Lovelace" },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.headers.etag).toBe('W/"1"');
    const user = created.json<{ id: string }>();

    const retry = await app.inject({
      method: "POST",
      url: "/api/scim/v2/acme/Users",
      headers,
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
        externalId: "idp-1",
        userName: "ada@acme.test",
        displayName: "Ada",
        name: { givenName: "Ada", familyName: "Lovelace" },
      },
    });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ id: user.id, externalId: "idp-1" });

    const list = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/Users?startIndex=1&count=1&filter=userName%20eq%20%22ada%40acme.test%22",
      headers,
    });
    expect(list.json()).toMatchObject({
      totalResults: 1,
      startIndex: 1,
      itemsPerPage: 1,
      Resources: [{ id: user.id }],
    });
    const emptyPage = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/Users?startIndex=99&count=1",
      headers,
    });
    expect(emptyPage.json()).toMatchObject({
      totalResults: 2,
      startIndex: 99,
      itemsPerPage: 0,
      Resources: [],
    });

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/scim/v2/acme/Users/${user.id}`,
      headers: { ...headers, "if-match": created.headers.etag ?? "" },
      payload: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [
          { op: "replace", path: "active", value: false },
          {
            op: "replace",
            path: "urn:helix:params:scim:schemas:extension:2.0:User.dataTransferTargetId",
            value: target.json<{ id: string }>().id,
          },
        ],
      },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({ id: user.id, active: false });
    expect(provisioning.deprovisioned).toContainEqual({
      actorId: user.id,
      transferToActorId: target.json<{ id: string }>().id,
    });

    const stale = await app.inject({
      method: "PUT",
      url: `/api/scim/v2/acme/Users/${user.id}`,
      headers: { ...headers, "if-match": 'W/"1"' },
      payload: { userName: "ada@acme.test", displayName: "Ada", active: true },
    });
    expect(stale.statusCode).toBe(412);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/scim/v2/acme/Users/${target.json<{ id: string }>().id}`,
      headers: { ...headers, "if-match": target.headers.etag ?? "" },
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    await app.close();
  });

  it("uses a SCIM error envelope for malformed JSON", async () => {
    const { app } = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      { seedToken: VALID_TOKEN },
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/scim/v2/acme/Users",
      headers: {
        authorization: `Bearer ${VALID_TOKEN}`,
        "content-type": "application/scim+json",
      },
      payload: "{not-json",
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers["content-type"]).toContain("application/scim+json");
    expect(response.json()).toMatchObject({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
      scimType: "invalidValue",
      status: "400",
    });
    await app.close();
  });

  it("synchronizes Group members with PUT/PATCH and rejects invalid filters", async () => {
    const { app, provisioning } = await buildHarness(
      { acme: orgRecord({ id: ORG_ID, slug: "acme" }) },
      { seedToken: VALID_TOKEN },
    );
    const headers = {
      authorization: `Bearer ${VALID_TOKEN}`,
      "content-type": "application/scim+json",
    };
    const first = await app.inject({
      method: "POST",
      url: "/api/scim/v2/acme/Users",
      headers,
      payload: { externalId: "u-1", userName: "one@acme.test", displayName: "One" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/api/scim/v2/acme/Users",
      headers,
      payload: { externalId: "u-2", userName: "two@acme.test", displayName: "Two" },
    });
    const firstId = first.json<{ id: string }>().id;
    const secondId = second.json<{ id: string }>().id;
    const created = await app.inject({
      method: "POST",
      url: "/api/scim/v2/acme/Groups",
      headers,
      payload: { externalId: "g-1", displayName: "Engineering", members: [{ value: firstId }] },
    });
    expect(created.statusCode).toBe(201);
    const groupId = created.json<{ id: string }>().id;

    const added = await app.inject({
      method: "PUT",
      url: `/api/scim/v2/acme/Groups/${groupId}`,
      headers: { ...headers, "if-match": created.headers.etag ?? "" },
      payload: {
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        externalId: "g-1",
        displayName: "Engineering",
        members: [{ value: firstId }, { value: secondId }],
      },
    });
    expect(added.json()).toMatchObject({ members: [{ value: firstId }, { value: secondId }] });

    const removed = await app.inject({
      method: "PATCH",
      url: `/api/scim/v2/acme/Groups/${groupId}`,
      headers: { ...headers, "if-match": added.headers.etag ?? "" },
      payload: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "remove", path: `members[value eq "${firstId}"]` }],
      },
    });
    expect(removed.json()).toMatchObject({ members: [{ value: secondId }] });

    const invalid = await app.inject({
      method: "GET",
      url: "/api/scim/v2/acme/Groups?filter=userName%20eq%20%22x%22",
      headers,
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ scimType: "invalidFilter" });
    const foreign = await provisioning.createUser("22222222-2222-2222-2222-222222222222", {
      externalId: "foreign",
      userName: "foreign@other.test",
      displayName: "Foreign",
      givenName: null,
      familyName: null,
      active: true,
    });
    const crossTenant = await app.inject({
      method: "PUT",
      url: `/api/scim/v2/acme/Groups/${groupId}`,
      headers: { ...headers, "if-match": removed.headers.etag ?? "" },
      payload: { displayName: "Engineering", members: [{ value: foreign.record.id }] },
    });
    expect(crossTenant.statusCode).toBe(409);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/scim/v2/acme/Groups/${groupId}`,
      headers: { ...headers, "if-match": removed.headers.etag ?? "" },
    });
    expect(deleted.statusCode, deleted.body).toBe(204);
    await app.close();
  });

  it("never lets a token for tenant A unlock tenant B", async () => {
    const otherOrgId = "22222222-2222-2222-2222-222222222222";
    const app = fastify();
    const credentials = new InMemoryTenantScimCredentialStore();
    await seedCredential(credentials, ORG_ID, VALID_TOKEN);
    await seedCredential(credentials, otherOrgId, OTHER_TENANT_TOKEN);
    await registerTenantScimRoutes(app, {
      orgs: orgStoreFromMap({
        acme: orgRecord({ id: ORG_ID, slug: "acme" }),
        other: orgRecord({ id: otherOrgId, slug: "other" }),
      }),
      credentials,
      provisioning: new TestScimStore(),
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

class TestScimStore implements ScimProvisioningStore {
  private sequence = 1;
  private readonly users = new Map<string, ScimUserRecord>();
  private readonly groups = new Map<string, ScimGroupRecord>();
  public readonly deprovisioned: Array<{ actorId: string; transferToActorId: string | null }> = [];

  async listUsers(
    orgId: string,
    filter: ScimFilter | null,
    offset: number,
    limit: number,
  ): Promise<ScimPage<ScimUserRecord>> {
    return page(
      [...this.users.values()].filter((user) => user.orgId === orgId && matchesUser(user, filter)),
      offset,
      limit,
    );
  }

  async getUser(orgId: string, id: string): Promise<ScimUserRecord | null> {
    const user = this.users.get(id);
    return user?.orgId === orgId ? user : null;
  }

  async createUser(orgId: string, input: PutScimUser): Promise<ScimWriteResult<ScimUserRecord>> {
    const correlated = [...this.users.values()].find(
      (user) =>
        user.orgId === orgId &&
        ((input.externalId !== null &&
          user.externalId?.toLowerCase() === input.externalId.toLowerCase()) ||
          user.userName.toLowerCase() === input.userName.toLowerCase()),
    );
    if (correlated !== undefined) {
      if (sameTestUser(correlated, input)) return { record: correlated, created: false };
      throw new ScimConflictError("userName and externalId must be unique within the tenant.");
    }
    const now = new Date();
    const record: ScimUserRecord = {
      id: this.id(),
      orgId,
      externalId: input.externalId,
      userName: input.userName,
      displayName: input.displayName,
      givenName: input.givenName,
      familyName: input.familyName,
      active: input.active,
      dataTransferTargetId: input.dataTransferTargetId ?? null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.users.set(record.id, record);
    return { record, created: true };
  }

  async putUser(
    orgId: string,
    id: string,
    input: PutScimUser,
    expectedVersion: number | null,
  ): Promise<ScimUserRecord | null> {
    const current = await this.getUser(orgId, id);
    if (current === null) return null;
    stale(current.version, expectedVersion);
    if (!input.active) {
      await this.deprovision(orgId, id, input.dataTransferTargetId ?? null);
    }
    const record: ScimUserRecord = {
      ...current,
      ...input,
      dataTransferTargetId: input.dataTransferTargetId ?? current.dataTransferTargetId,
      updatedAt: new Date(),
      version: current.version + 1,
    };
    this.users.set(id, record);
    return record;
  }

  async deleteUser(
    orgId: string,
    id: string,
    expectedVersion: number | null,
    transferToActorId: string | null,
  ): Promise<boolean> {
    const current = await this.getUser(orgId, id);
    if (current === null) return false;
    stale(current.version, expectedVersion);
    await this.deprovision(orgId, id, transferToActorId);
    this.users.set(id, {
      ...current,
      active: false,
      dataTransferTargetId: transferToActorId,
      version: current.version + 1,
      updatedAt: new Date(),
    });
    return true;
  }

  async listGroups(
    orgId: string,
    filter: ScimFilter | null,
    offset: number,
    limit: number,
  ): Promise<ScimPage<ScimGroupRecord>> {
    return page(
      [...this.groups.values()].filter(
        (group) => group.orgId === orgId && matchesGroup(group, filter),
      ),
      offset,
      limit,
    );
  }

  async getGroup(orgId: string, id: string): Promise<ScimGroupRecord | null> {
    const group = this.groups.get(id);
    return group?.orgId === orgId ? group : null;
  }

  async createGroup(orgId: string, input: PutScimGroup): Promise<ScimWriteResult<ScimGroupRecord>> {
    const correlated = [...this.groups.values()].find(
      (group) =>
        group.orgId === orgId &&
        ((input.externalId !== null &&
          group.externalId?.toLowerCase() === input.externalId.toLowerCase()) ||
          group.displayName.toLowerCase() === input.displayName.toLowerCase()),
    );
    if (correlated !== undefined) {
      if (sameTestGroup(correlated, input)) return { record: correlated, created: false };
      throw new ScimConflictError("displayName and externalId must be unique within the tenant.");
    }
    const now = new Date();
    const record: ScimGroupRecord = {
      id: this.id(),
      orgId,
      externalId: input.externalId,
      displayName: input.displayName,
      members: await this.members(orgId, input.memberIds),
      createdAt: now,
      updatedAt: now,
      version: 1,
    };
    this.groups.set(record.id, record);
    return { record, created: true };
  }

  async putGroup(
    orgId: string,
    id: string,
    input: PutScimGroup,
    expectedVersion: number | null,
  ): Promise<ScimGroupRecord | null> {
    const current = await this.getGroup(orgId, id);
    if (current === null) return null;
    stale(current.version, expectedVersion);
    const record: ScimGroupRecord = {
      ...current,
      externalId: input.externalId,
      displayName: input.displayName,
      members: await this.members(orgId, input.memberIds),
      updatedAt: new Date(),
      version: current.version + 1,
    };
    this.groups.set(id, record);
    return record;
  }

  async deleteGroup(orgId: string, id: string, expectedVersion: number | null): Promise<boolean> {
    const current = await this.getGroup(orgId, id);
    if (current === null) return false;
    stale(current.version, expectedVersion);
    return this.groups.delete(id);
  }

  private async deprovision(
    orgId: string,
    actorId: string,
    transferToActorId: string | null,
  ): Promise<void> {
    if (transferToActorId !== null) {
      const target = await this.getUser(orgId, transferToActorId);
      if (target === null || !target.active || target.id === actorId) {
        throw new ScimConflictError(
          "The data-transfer target must be an active user in the same tenant.",
        );
      }
    }
    this.deprovisioned.push({ actorId, transferToActorId });
    for (const [id, group] of this.groups) {
      this.groups.set(id, {
        ...group,
        members: group.members.filter((member) => member.value !== actorId),
      });
    }
  }

  private async members(orgId: string, ids: readonly string[]) {
    const members = await Promise.all(
      [...new Set(ids)].map(async (id) => {
        const user = await this.getUser(orgId, id);
        if (user === null || !user.active) throw new ScimConflictError("Invalid group member.");
        return { value: user.id, display: user.displayName };
      }),
    );
    return members;
  }

  private id(): string {
    return `00000000-0000-4000-8000-${String(this.sequence++).padStart(12, "0")}`;
  }
}

function page<T>(all: readonly T[], offset: number, limit: number): ScimPage<T> {
  return { resources: all.slice(offset, offset + limit), total: all.length };
}

function matchesUser(user: ScimUserRecord, filter: ScimFilter | null): boolean {
  if (filter === null) return true;
  const value = filter.value.toLowerCase();
  if (filter.attribute === "id") return user.id === filter.value;
  if (filter.attribute === "externalId") return user.externalId?.toLowerCase() === value;
  return filter.attribute === "userName" && user.userName.toLowerCase() === value;
}

function matchesGroup(group: ScimGroupRecord, filter: ScimFilter | null): boolean {
  if (filter === null) return true;
  const value = filter.value.toLowerCase();
  if (filter.attribute === "id") return group.id === filter.value;
  if (filter.attribute === "externalId") return group.externalId?.toLowerCase() === value;
  return filter.attribute === "displayName" && group.displayName.toLowerCase() === value;
}

function sameTestUser(user: ScimUserRecord, input: PutScimUser): boolean {
  return (
    user.externalId === input.externalId &&
    user.userName.toLowerCase() === input.userName.toLowerCase() &&
    user.displayName === input.displayName &&
    user.givenName === input.givenName &&
    user.familyName === input.familyName &&
    user.active === input.active
  );
}

function sameTestGroup(group: ScimGroupRecord, input: PutScimGroup): boolean {
  return (
    group.externalId === input.externalId &&
    group.displayName === input.displayName &&
    group.members
      .map((member) => member.value)
      .sort()
      .join() === [...new Set(input.memberIds)].sort().join()
  );
}

function stale(version: number, expected: number | null): void {
  if (expected !== null && version !== expected) throw new ScimPreconditionError();
}

class RecordingAuditSink implements ScimAuthAuditSink {
  public readonly records: Array<{
    readonly orgId: string;
    readonly actorId: string | null;
    readonly verb: string;
    readonly objectType: string;
    readonly objectId?: string;
    readonly metadata?: Record<string, unknown>;
  }> = [];

  async append(record: {
    readonly orgId: string;
    readonly actorId: string | null;
    readonly verb: string;
    readonly objectType: string;
    readonly objectId?: string;
    readonly metadata?: Record<string, unknown>;
  }): Promise<{ readonly id: string }> {
    this.records.push({
      orgId: record.orgId,
      actorId: record.actorId,
      verb: record.verb,
      objectType: record.objectType,
      ...(record.objectId === undefined ? {} : { objectId: record.objectId }),
      ...(record.metadata === undefined ? {} : { metadata: record.metadata }),
    });
    return { id: "audit-id" };
  }
}

class RecordingScimMetrics {
  public readonly reasons: ScimAuthFailureReason[] = [];

  recordScimAuthFailure(input: { readonly reason: ScimAuthFailureReason }): void {
    this.reasons.push(input.reason);
  }
}

async function seedCredential(
  store: InMemoryTenantScimCredentialStore,
  orgId: string,
  token: string,
  overrides: {
    readonly scopes?: readonly ScimCredentialScope[] | undefined;
    readonly sourceCidrs?: readonly string[] | undefined;
    readonly expiresAt?: Date | undefined;
  } = {},
): Promise<void> {
  const id = scimCredentialIdFromToken(token);
  if (id === null) throw new Error("Test token must contain a credential id.");
  await store.create({
    id,
    orgId,
    name: `Credential ${id}`,
    tokenHash: await hashScimBearerToken(token),
    tokenHint: deriveScimTokenHint(token),
    scopes: overrides.scopes ?? SCIM_CREDENTIAL_SCOPES,
    sourceCidrs: overrides.sourceCidrs ?? [],
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 86_400_000),
    createdByActorId: ADMIN_ID,
  });
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
