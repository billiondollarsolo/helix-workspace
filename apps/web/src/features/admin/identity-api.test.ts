import { describe, expect, it, vi } from "vitest";
import type { AuthFetch } from "@/lib/auth";
import {
  createTenantIdpConfig,
  deleteTenantIdpConfig,
  fetchAdminIdentity,
  promoteTenantIdpConfig,
  testTenantIdpConfigLogin,
  updateTenantIdpConfig,
} from "./identity-api";

const identityPayload = {
  idpConfigs: [
    {
      id: "idp-1",
      orgId: "org-1",
      protocol: "saml",
      isPrimary: true,
      displayName: "Acme Okta",
      config: { metadataUrl: "https://idp.example.com/metadata" },
      signingCertVaultPath: "tenants/org-1/idp/saml-signing-cert",
      attrMapping: { email: "$.email" },
      jitProvisioning: true,
      enabled: true,
      samlSpMetadataUrl: "https://app.helix.example/api/auth/saml/acme/metadata",
      createdAt: "2026-05-24T00:00:00.000Z",
      updatedAt: "2026-05-24T00:00:00.000Z",
    },
  ],
  localLoginRecovery: { enabled: true, scope: "owner_admin_recovery" },
};

describe("identity-api", () => {
  it("fetches tenant IdP configs and local recovery status", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(Response.json(identityPayload));

    const result = await fetchAdminIdentity(fetchImpl);

    expect(result.localLoginRecovery.enabled).toBe(true);
    expect(result.idpConfigs[0]?.displayName).toBe("Acme Okta");
    expect(result.idpConfigs[0]?.samlSpMetadataUrl).toBe(
      "https://app.helix.example/api/auth/saml/acme/metadata",
    );
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/identity/idp-configs", { method: "GET" });
  });

  it("creates tenant IdP configs through the admin endpoint", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(
      Response.json({
        idpConfig: identityPayload.idpConfigs[0],
        localLoginRecovery: identityPayload.localLoginRecovery,
      }),
    );

    await createTenantIdpConfig(
      {
        protocol: "saml",
        displayName: "Acme Okta",
        config: { metadataUrl: "https://idp.example.com/metadata" },
        signingCertVaultPath: "tenants/org-1/idp/saml-signing-cert",
        attrMapping: { email: "$.email" },
        enabled: true,
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/identity/idp-configs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: "saml",
        displayName: "Acme Okta",
        config: { metadataUrl: "https://idp.example.com/metadata" },
        signingCertVaultPath: "tenants/org-1/idp/saml-signing-cert",
        attrMapping: { email: "$.email" },
        enabled: true,
      }),
    });
  });

  it("promotes a tenant IdP config to primary", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(
      Response.json({
        idpConfig: identityPayload.idpConfigs[0],
        localLoginRecovery: identityPayload.localLoginRecovery,
      }),
    );

    await promoteTenantIdpConfig("idp-1", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/identity/idp-configs/idp-1/primary", {
      method: "POST",
    });
  });

  it("updates a tenant IdP config through the admin endpoint", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(
      Response.json({
        idpConfig: { ...identityPayload.idpConfigs[0], enabled: false, isPrimary: false },
        localLoginRecovery: identityPayload.localLoginRecovery,
      }),
    );

    const result = await updateTenantIdpConfig(
      "idp-1",
      { enabled: false, jitProvisioning: false },
      fetchImpl,
    );

    expect(result.enabled).toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/identity/idp-configs/idp-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false, jitProvisioning: false }),
    });
  });

  it("deletes a tenant IdP config through the admin endpoint", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(
      Response.json({
        idpConfig: identityPayload.idpConfigs[0],
        localLoginRecovery: identityPayload.localLoginRecovery,
      }),
    );

    await deleteTenantIdpConfig("idp-1", fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/identity/idp-configs/idp-1", {
      method: "DELETE",
    });
  });

  it("checks IdP login readiness without starting SSO", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(
      Response.json({
        testLogin: {
          status: "runtime_pending",
          message:
            "SAML configuration is ready. Runtime AuthnRequest/ACS handling is not connected yet.",
        },
        localLoginRecovery: identityPayload.localLoginRecovery,
      }),
    );

    const result = await testTenantIdpConfigLogin("idp-1", fetchImpl);

    expect(result.status).toBe("runtime_pending");
    expect(fetchImpl).toHaveBeenCalledWith("/api/admin/identity/idp-configs/idp-1/test-login", {
      method: "POST",
    });
  });

  it("surfaces backend errors", async () => {
    const fetchImpl = vi
      .fn<AuthFetch>()
      .mockResolvedValue(Response.json({ error: "Invalid tenant IdP config." }, { status: 400 }));

    await expect(fetchAdminIdentity(fetchImpl)).rejects.toThrow("Invalid tenant IdP config.");
  });

  it("surfaces update and delete backend errors", async () => {
    const fetchImpl = vi
      .fn<AuthFetch>()
      .mockResolvedValueOnce(
        Response.json({ error: "Tenant IdP config not found." }, { status: 404 }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: "Tenant IdP config not found." }, { status: 404 }),
      );

    await expect(updateTenantIdpConfig("missing", { enabled: false }, fetchImpl)).rejects.toThrow(
      "Tenant IdP config not found.",
    );
    await expect(deleteTenantIdpConfig("missing", fetchImpl)).rejects.toThrow(
      "Tenant IdP config not found.",
    );
  });

  it("rejects malformed OK responses at the trust boundary", async () => {
    const fetchImpl = vi.fn<AuthFetch>().mockResolvedValue(Response.json({ idpConfigs: [] }));

    await expect(fetchAdminIdentity(fetchImpl)).rejects.toThrow("malformed response");
  });
});
