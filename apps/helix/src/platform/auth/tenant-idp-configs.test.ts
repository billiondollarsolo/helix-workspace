import { describe, expect, it } from "vitest";
import { InMemoryTenantIdpConfigStore } from "./tenant-idp-configs.js";

describe("InMemoryTenantIdpConfigStore", () => {
  it("creates tenant IdP configs with safe BYO-Identity defaults", async () => {
    const store = new InMemoryTenantIdpConfigStore();

    const config = await store.create({
      orgId: "org-1",
      protocol: "saml",
      displayName: "Acme Okta",
      config: { metadataUrl: "https://idp.example.com/metadata" },
      signingCertVaultPath: "tenants/org-1/idp/acme-okta/signing-cert",
      attrMapping: { email: "$.email", displayName: "$.name" },
    });

    expect(config).toMatchObject({
      orgId: "org-1",
      protocol: "saml",
      isPrimary: true,
      displayName: "Acme Okta",
      config: { metadataUrl: "https://idp.example.com/metadata" },
      signingCertVaultPath: "tenants/org-1/idp/acme-okta/signing-cert",
      attrMapping: { email: "$.email", displayName: "$.name" },
      jitProvisioning: true,
      enabled: true,
    });
    await expect(store.get("org-1", config.id)).resolves.toEqual(config);
    await expect(store.getPrimary("org-1")).resolves.toEqual(config);
  });

  it("rejects a second enabled primary IdP for the same tenant", async () => {
    const store = new InMemoryTenantIdpConfigStore();

    await store.create({
      orgId: "org-1",
      protocol: "oidc",
      displayName: "Acme OIDC",
    });

    await expect(
      store.create({
        orgId: "org-1",
        protocol: "saml",
        displayName: "Acme SAML",
      }),
    ).rejects.toThrow("Tenant already has an enabled primary IdP config.");
  });

  it("can promote an enabled secondary IdP to primary", async () => {
    const store = new InMemoryTenantIdpConfigStore({
      now: () => new Date("2026-05-24T10:00:00.000Z"),
    });
    const primary = await store.create({
      orgId: "org-1",
      protocol: "oidc",
      displayName: "Primary OIDC",
    });
    const secondary = await store.create({
      orgId: "org-1",
      protocol: "saml",
      displayName: "Secondary SAML",
      isPrimary: false,
    });

    await expect(store.setPrimary("org-1", secondary.id)).resolves.toMatchObject({
      id: secondary.id,
      isPrimary: true,
    });

    await expect(store.getPrimary("org-1")).resolves.toMatchObject({ id: secondary.id });
    await expect(store.list("org-1")).resolves.toEqual([
      expect.objectContaining({ id: secondary.id, isPrimary: true }),
      expect.objectContaining({ id: primary.id, isPrimary: false }),
    ]);
  });

  it("does not promote disabled or cross-tenant IdP configs", async () => {
    const store = new InMemoryTenantIdpConfigStore();
    const disabled = await store.create({
      orgId: "org-1",
      protocol: "saml",
      displayName: "Disabled SAML",
      enabled: false,
    });
    const otherTenant = await store.create({
      orgId: "org-2",
      protocol: "oidc",
      displayName: "Other Tenant OIDC",
    });

    await expect(store.setPrimary("org-1", disabled.id)).resolves.toBeNull();
    await expect(store.setPrimary("org-1", otherTenant.id)).resolves.toBeNull();
    await expect(store.get("org-1", otherTenant.id)).resolves.toBeNull();
    await expect(store.getPrimary("org-1")).resolves.toBeNull();
  });

  it("updates tenant IdP configs and demotes previous primaries", async () => {
    const store = new InMemoryTenantIdpConfigStore({
      now: () => new Date("2026-05-24T10:00:00.000Z"),
    });
    const primary = await store.create({
      orgId: "org-1",
      protocol: "saml",
      displayName: "Primary SAML",
    });
    const secondary = await store.create({
      orgId: "org-1",
      protocol: "oidc",
      displayName: "Secondary OIDC",
      isPrimary: false,
      enabled: false,
    });

    await expect(
      store.update({
        orgId: "org-1",
        id: secondary.id,
        displayName: "Updated OIDC",
        config: { issuer: "https://idp.example.com", clientId: "helix" },
        signingCertVaultPath: null,
        attrMapping: { email: "$.email" },
        enabled: true,
        isPrimary: true,
      }),
    ).resolves.toMatchObject({
      id: secondary.id,
      displayName: "Updated OIDC",
      enabled: true,
      isPrimary: true,
      config: { issuer: "https://idp.example.com", clientId: "helix" },
      attrMapping: { email: "$.email" },
      signingCertVaultPath: null,
    });
    await expect(store.get("org-1", primary.id)).resolves.toMatchObject({ isPrimary: false });
    await expect(store.getPrimary("org-1")).resolves.toMatchObject({ id: secondary.id });
  });

  it("disables primary configs by clearing primary status and deletes by tenant scope", async () => {
    const store = new InMemoryTenantIdpConfigStore();
    const primary = await store.create({
      orgId: "org-1",
      protocol: "saml",
      displayName: "Primary SAML",
    });
    const otherTenant = await store.create({
      orgId: "org-2",
      protocol: "oidc",
      displayName: "Other Tenant OIDC",
    });

    await expect(
      store.update({ orgId: "org-1", id: primary.id, enabled: false }),
    ).resolves.toMatchObject({
      enabled: false,
      isPrimary: false,
    });
    await expect(store.getPrimary("org-1")).resolves.toBeNull();
    await expect(store.delete("org-1", otherTenant.id)).resolves.toBeNull();
    await expect(store.delete("org-1", primary.id)).resolves.toMatchObject({ id: primary.id });
    await expect(store.get("org-1", primary.id)).resolves.toBeNull();
  });
});
