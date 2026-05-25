import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/actor.js";
import { InMemoryTenantIdpConfigStore } from "../auth/tenant-idp-configs.js";
import { registerAdminIdentityRoutes, testTenantIdpConfigLogin } from "./identity.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";

function headers(scopes: string): Record<string, string> {
  return {
    "x-helix-actor-id": actorId,
    "x-helix-org-id": orgId,
    "x-helix-scopes": scopes,
  };
}

function body(response: { json: () => unknown }): Record<string, unknown> {
  return response.json() as Record<string, unknown>;
}

async function buildApp() {
  const idpConfigs = new InMemoryTenantIdpConfigStore();
  const auditRecords: unknown[] = [];
  const app = fastify();
  await registerAdminIdentityRoutes(app, {
    idpConfigs,
    orgs: {
      async findById(id) {
        return id === orgId ? orgRecord() : null;
      },
    },
    actorFromRequest,
    auditSink: {
      async append(record) {
        auditRecords.push(record);
        return { id: "audit-1", thisHash: "hash-1" };
      },
    },
    publicBaseUrl: "https://app.helix.example",
  });
  return { app, idpConfigs, auditRecords };
}

describe("admin identity IdP config routes", () => {
  it("lists tenant IdP configs and always exposes local login recovery", async () => {
    const { app, idpConfigs } = await buildApp();
    await idpConfigs.create({
      orgId,
      protocol: "saml",
      displayName: "Acme Okta",
      config: { metadataUrl: "https://idp.example.com/metadata" },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/identity/idp-configs",
      headers: headers("admin.console.read"),
    });

    expect(response.statusCode).toBe(200);
    expect(body(response)).toMatchObject({
      idpConfigs: [
        {
          protocol: "saml",
          displayName: "Acme Okta",
          isPrimary: true,
          samlSpMetadataUrl: "https://app.helix.example/api/auth/saml/acme/metadata",
        },
      ],
      localLoginRecovery: { enabled: true, scope: "owner_admin_recovery" },
    });
    await app.close();
  });

  it("creates a tenant IdP config without disabling local login recovery", async () => {
    const { app, auditRecords } = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/identity/idp-configs",
      headers: headers("admin.console.write"),
      payload: {
        protocol: "saml",
        displayName: "Acme SAML",
        config: { metadataUrl: "https://idp.example.com/metadata" },
        signingCertVaultPath: "tenants/acme/idp/saml-signing-cert",
        attrMapping: { email: "$.email", displayName: "$.name" },
      },
    });

    expect(response.statusCode).toBe(201);
    expect(body(response)).toMatchObject({
      idpConfig: {
        orgId,
        protocol: "saml",
        displayName: "Acme SAML",
        signingCertVaultPath: "tenants/acme/idp/saml-signing-cert",
        attrMapping: { email: "$.email", displayName: "$.name" },
        isPrimary: true,
        samlSpMetadataUrl: "https://app.helix.example/api/auth/saml/acme/metadata",
      },
      localLoginRecovery: { enabled: true, scope: "owner_admin_recovery" },
    });
    expect(auditRecords).toEqual([
      expect.objectContaining({
        verb: "admin.identity.idp_config.created",
        objectType: "tenant_idp_config",
      }),
    ]);
    await app.close();
  });

  it("rejects inline IdP secrets and points admins to Vault paths", async () => {
    const { app } = await buildApp();

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/identity/idp-configs",
      headers: headers("admin.console.write"),
      payload: {
        protocol: "oidc",
        displayName: "Acme OIDC",
        config: { issuer: "https://idp.example.com", clientSecret: "plaintext" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(body(response)).toMatchObject({
      code: "invalid_request",
      error: "Invalid tenant IdP config.",
    });
    await app.close();
  });

  it("returns a conflict for a second enabled primary IdP", async () => {
    const { app } = await buildApp();
    await app.inject({
      method: "POST",
      url: "/api/admin/identity/idp-configs",
      headers: headers("admin.console.write"),
      payload: { protocol: "saml", displayName: "Primary SAML" },
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/identity/idp-configs",
      headers: headers("admin.console.write"),
      payload: { protocol: "oidc", displayName: "Primary OIDC" },
    });

    expect(response.statusCode).toBe(409);
    expect(body(response)).toMatchObject({
      code: "conflict",
      error: "Tenant already has an enabled primary IdP config.",
    });
    await app.close();
  });

  it("promotes an enabled secondary IdP for the actor tenant", async () => {
    const { app, idpConfigs, auditRecords } = await buildApp();
    await idpConfigs.create({ orgId, protocol: "saml", displayName: "Primary SAML" });
    const secondary = await idpConfigs.create({
      orgId,
      protocol: "oidc",
      displayName: "Secondary OIDC",
      isPrimary: false,
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/identity/idp-configs/${secondary.id}/primary`,
      headers: headers("admin.console.write"),
    });

    expect(response.statusCode).toBe(200);
    expect(body(response)).toMatchObject({
      idpConfig: { id: secondary.id, isPrimary: true },
      localLoginRecovery: { enabled: true, scope: "owner_admin_recovery" },
    });
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "admin.identity.idp_config.primary_set",
        objectId: secondary.id,
      }),
    );
    await app.close();
  });

  it("updates a tenant IdP config without disabling local login recovery", async () => {
    const { app, idpConfigs, auditRecords } = await buildApp();
    const idpConfig = await idpConfigs.create({
      orgId,
      protocol: "saml",
      displayName: "Acme SAML",
      config: { metadataUrl: "https://idp.example.com/metadata" },
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/identity/idp-configs/${idpConfig.id}`,
      headers: headers("admin.console.write"),
      payload: {
        displayName: "Acme SAML disabled",
        enabled: false,
        attrMapping: { email: "$.email" },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(body(response)).toMatchObject({
      idpConfig: {
        id: idpConfig.id,
        displayName: "Acme SAML disabled",
        enabled: false,
        isPrimary: false,
        attrMapping: { email: "$.email" },
      },
      localLoginRecovery: { enabled: true, scope: "owner_admin_recovery" },
    });
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "admin.identity.idp_config.updated",
        objectId: idpConfig.id,
        metadata: {
          protocol: "saml",
          isPrimary: false,
          enabled: false,
          changedFields: ["attrMapping", "displayName", "enabled"],
        },
      }),
    );
    await app.close();
  });

  it("rejects unsafe IdP config updates", async () => {
    const { app, idpConfigs } = await buildApp();
    const idpConfig = await idpConfigs.create({
      orgId,
      protocol: "oidc",
      displayName: "Acme OIDC",
      isPrimary: false,
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/admin/identity/idp-configs/${idpConfig.id}`,
      headers: headers("admin.console.write"),
      payload: {
        config: { clientSecret: "plaintext" },
        localLoginRecovery: { enabled: false },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(body(response)).toMatchObject({
      code: "invalid_request",
      error: "Invalid tenant IdP config.",
    });
    await app.close();
  });

  it("deletes a tenant IdP config without disabling local recovery", async () => {
    const { app, idpConfigs, auditRecords } = await buildApp();
    const idpConfig = await idpConfigs.create({
      orgId,
      protocol: "saml",
      displayName: "Delete SAML",
    });

    const response = await app.inject({
      method: "DELETE",
      url: `/api/admin/identity/idp-configs/${idpConfig.id}`,
      headers: headers("admin.console.write"),
    });

    expect(response.statusCode).toBe(200);
    expect(body(response)).toMatchObject({
      idpConfig: { id: idpConfig.id, displayName: "Delete SAML" },
      localLoginRecovery: { enabled: true, scope: "owner_admin_recovery" },
    });
    await expect(idpConfigs.get(orgId, idpConfig.id)).resolves.toBeNull();
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "admin.identity.idp_config.deleted",
        objectId: idpConfig.id,
      }),
    );
    await app.close();
  });

  it("does not update or delete cross-tenant IdP configs", async () => {
    const { app, idpConfigs } = await buildApp();
    const otherTenant = await idpConfigs.create({
      orgId: "33333333-3333-4333-8333-333333333333",
      protocol: "saml",
      displayName: "Other Tenant SAML",
    });

    const update = await app.inject({
      method: "PATCH",
      url: `/api/admin/identity/idp-configs/${otherTenant.id}`,
      headers: headers("admin.console.write"),
      payload: { displayName: "Bad update" },
    });
    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/admin/identity/idp-configs/${otherTenant.id}`,
      headers: headers("admin.console.write"),
    });

    expect(update.statusCode).toBe(404);
    expect(deletion.statusCode).toBe(404);
    expect(body(update)).toMatchObject({ code: "not_found" });
    expect(body(deletion)).toMatchObject({ code: "not_found" });
    await app.close();
  });

  it("checks IdP test-login readiness without starting SSO or disabling local recovery", async () => {
    const { app, idpConfigs, auditRecords } = await buildApp();
    const idpConfig = await idpConfigs.create({
      orgId,
      protocol: "saml",
      displayName: "Ready SAML",
      config: { metadataUrl: "https://idp.example.com/metadata" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/identity/idp-configs/${idpConfig.id}/test-login`,
      headers: headers("admin.console.write"),
    });

    expect(response.statusCode).toBe(200);
    expect(body(response)).toMatchObject({
      testLogin: {
        status: "runtime_pending",
      },
      localLoginRecovery: { enabled: true, scope: "owner_admin_recovery" },
    });
    expect(auditRecords).toContainEqual(
      expect.objectContaining({
        verb: "admin.identity.idp_config.test_login_checked",
        objectId: idpConfig.id,
        metadata: { protocol: "saml", status: "runtime_pending" },
      }),
    );
    await app.close();
  });

  it("reports configuration-required IdP test-login readiness", async () => {
    const { app, idpConfigs } = await buildApp();
    const idpConfig = await idpConfigs.create({
      orgId,
      protocol: "oidc",
      displayName: "Incomplete OIDC",
      config: { issuer: "https://idp.example.com" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/identity/idp-configs/${idpConfig.id}/test-login`,
      headers: headers("admin.console.write"),
    });

    expect(response.statusCode).toBe(200);
    expect(body(response)).toMatchObject({
      testLogin: {
        status: "configuration_required",
        message: "OIDC issuer/discovery URL and client ID are required.",
      },
      localLoginRecovery: { enabled: true, scope: "owner_admin_recovery" },
    });
    await app.close();
  });

  it("does not test cross-tenant IdP configs", async () => {
    const { app, idpConfigs } = await buildApp();
    const otherTenant = await idpConfigs.create({
      orgId: "33333333-3333-4333-8333-333333333333",
      protocol: "saml",
      displayName: "Other Tenant SAML",
      config: { metadataUrl: "https://idp.example.com/metadata" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/admin/identity/idp-configs/${otherTenant.id}/test-login`,
      headers: headers("admin.console.write"),
    });

    expect(response.statusCode).toBe(404);
    expect(body(response)).toMatchObject({ code: "not_found" });
    await app.close();
  });

  it("enforces admin console read and write scopes", async () => {
    const { app } = await buildApp();

    const read = await app.inject({
      method: "GET",
      url: "/api/admin/identity/idp-configs",
      headers: headers("drive.read"),
    });
    const write = await app.inject({
      method: "POST",
      url: "/api/admin/identity/idp-configs",
      headers: headers("admin.console.read"),
      payload: { protocol: "saml", displayName: "Acme SAML" },
    });

    expect(read.statusCode).toBe(403);
    expect(write.statusCode).toBe(403);
    await app.close();
  });
});

function orgRecord() {
  return {
    id: orgId,
    slug: "acme",
    displayName: "Acme",
    status: "active" as const,
    tier: "business" as const,
    planId: "business",
    region: "us-east-1",
    byoConfig: {},
    featureFlags: {},
    quotas: {},
    branding: {},
    suspendedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
  };
}

describe("testTenantIdpConfigLogin", () => {
  it("recognizes SAML static metadata and OIDC discovery readiness", () => {
    expect(
      testTenantIdpConfigLogin({
        id: "idp-1",
        orgId,
        protocol: "saml",
        isPrimary: true,
        displayName: "Static SAML",
        config: { entityId: "https://idp.example.com", ssoUrl: "https://idp.example.com/sso" },
        signingCertVaultPath: null,
        attrMapping: {},
        jitProvisioning: true,
        enabled: true,
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z",
      }),
    ).toMatchObject({ status: "runtime_pending" });

    expect(
      testTenantIdpConfigLogin({
        id: "idp-2",
        orgId,
        protocol: "oidc",
        isPrimary: false,
        displayName: "OIDC",
        config: {
          metadataUrl: "https://idp.example.com/.well-known/openid-configuration",
          clientId: "helix",
        },
        signingCertVaultPath: null,
        attrMapping: {},
        jitProvisioning: true,
        enabled: true,
        createdAt: "2026-05-24T00:00:00.000Z",
        updatedAt: "2026-05-24T00:00:00.000Z",
      }),
    ).toMatchObject({ status: "runtime_pending" });
  });
});
