import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/actor.js";
import {
  InMemorySecurityPoliciesStore,
  SECURITY_POLICY_TYPES,
  defaultPolicy,
  parsePolicySettings,
  registerAdminSecurityPoliciesRoutes,
  testSsoPolicyLogin,
} from "./security-policies.js";

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

function field(response: { json: () => unknown }, key: string): unknown {
  return body(response)[key];
}

async function buildApp() {
  const store = new InMemorySecurityPoliciesStore();
  const app = fastify();
  await registerAdminSecurityPoliciesRoutes(app, { store, actorFromRequest });
  return { app, store };
}

describe("security policy settings validation", () => {
  it("provides a typed default for every policy type", () => {
    for (const policyType of SECURITY_POLICY_TYPES) {
      const fallback = defaultPolicy(policyType);
      expect(fallback.policyType).toBe(policyType);
      expect(fallback.enabled).toBe(false);
      expect(typeof fallback.settings).toBe("object");
    }
  });

  it("rejects settings that do not match the policy schema", () => {
    const ok = parsePolicySettings("mfa", { allowedMethods: ["totp"], rememberDeviceDays: 7 });
    expect(ok.ok).toBe(true);
    const bad = parsePolicySettings("mfa", { allowedMethods: ["fingerprint"] });
    expect(bad.ok).toBe(false);
  });

  it("accepts SSO draft settings without allowing local login to be disabled", () => {
    const ok = parsePolicySettings("sso", {
      provider: "generic_oidc",
      metadataUrl: "https://idp.example.com/.well-known/openid-configuration",
      jitProvisioning: true,
      mappedDomains: ["example.com"],
      localLoginEnabled: true,
      setupStatus: "draft",
      testLoginStatus: "runtime_pending",
      setupSource: "signup",
    });
    expect(ok.ok).toBe(true);

    const bad = parsePolicySettings("sso", {
      provider: "not-a-provider",
      localLoginEnabled: false,
    });
    expect(bad.ok).toBe(false);
  });

  it("reports SSO test-login status without starting an SSO flow", () => {
    expect(testSsoPolicyLogin({ provider: "none" })).toMatchObject({
      status: "configuration_required",
    });
    expect(testSsoPolicyLogin({ provider: "generic_saml" })).toMatchObject({
      status: "configuration_required",
    });
    expect(
      testSsoPolicyLogin({
        provider: "generic_saml",
        metadataUrl: "https://idp.example.com/saml/metadata",
      }),
    ).toMatchObject({ status: "runtime_pending" });
  });
});

describe("admin security policies routes", () => {
  it("lists all six policies with defaults before any edit", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/security-policies",
      headers: headers("admin.console.read"),
    });
    expect(response.statusCode).toBe(200);
    const policies = field(response, "policies") as { policyType: string }[];
    expect(policies.map((policy) => policy.policyType).sort()).toEqual(
      [...SECURITY_POLICY_TYPES].sort(),
    );
  });

  it("updates a policy with validated settings and persists it", async () => {
    const { app } = await buildApp();
    const updated = await app.inject({
      method: "PUT",
      url: "/api/admin/security-policies/mfa",
      headers: headers("admin.console.write"),
      payload: {
        enabled: true,
        enforcement: "required",
        settings: { allowedMethods: ["hardware_key", "totp"], rememberDeviceDays: 30 },
      },
    });
    expect(updated.statusCode).toBe(200);
    const updatedPolicy = field(updated, "policy") as { enabled: boolean; enforcement: string };
    expect(updatedPolicy.enabled).toBe(true);
    expect(updatedPolicy.enforcement).toBe("required");

    const reread = await app.inject({
      method: "GET",
      url: "/api/admin/security-policies/mfa",
      headers: headers("admin.console.read"),
    });
    expect(
      (field(reread, "policy") as { settings: { rememberDeviceDays: number } }).settings
        .rememberDeviceDays,
    ).toBe(30);
  });

  it("rejects invalid policy settings with a 400 envelope", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/security-policies/external_sharing",
      headers: headers("admin.console.write"),
      payload: { settings: { mode: "everyone" } },
    });
    expect(response.statusCode).toBe(400);
    expect(body(response).code).toBe("invalid_request");
  });

  it("rejects unknown policy types", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/security-policies/quantum",
      headers: headers("admin.console.write"),
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(400);
  });

  it("requires the write scope to update a policy", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/security-policies/dlp",
      headers: headers("admin.console.read"),
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(403);
    expect(body(response).requiredScope).toBe("admin.console.write");
  });

  it("tests SSO login readiness with write scope and updates only test status", async () => {
    const { app } = await buildApp();
    const updated = await app.inject({
      method: "PUT",
      url: "/api/admin/security-policies/sso",
      headers: headers("admin.console.write"),
      payload: {
        enabled: false,
        enforcement: "optional",
        settings: {
          provider: "generic_oidc",
          metadataUrl: "https://idp.example.com/.well-known/openid-configuration",
          jitProvisioning: true,
          mappedDomains: ["example.com"],
          localLoginEnabled: true,
          setupStatus: "draft",
          testLoginStatus: "not_tested",
          setupSource: "signup",
        },
      },
    });
    expect(updated.statusCode).toBe(200);

    const tested = await app.inject({
      method: "POST",
      url: "/api/admin/security-policies/sso/test-login",
      headers: headers("admin.console.write"),
      payload: {},
    });

    expect(tested.statusCode).toBe(200);
    expect(body(tested)).toEqual({
      testLogin: {
        status: "runtime_pending",
        message: "Configuration saved. SAML/OIDC runtime is not connected yet.",
      },
    });

    const reread = await app.inject({
      method: "GET",
      url: "/api/admin/security-policies/sso",
      headers: headers("admin.console.read"),
    });
    expect(
      (field(reread, "policy") as { settings: { testLoginStatus: string } }).settings
        .testLoginStatus,
    ).toBe("runtime_pending");
  });

  it("requires write scope for SSO test-login checks", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/admin/security-policies/sso/test-login",
      headers: headers("admin.console.read"),
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });

  it("requires a read scope to list policies", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/security-policies",
      headers: headers("mail.read"),
    });
    expect(response.statusCode).toBe(403);
  });

  it("attaches runtimeStatus so clients never invent enforcement", async () => {
    const { app } = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/admin/security-policies",
      headers: headers("admin.console.read"),
    });
    expect(response.statusCode).toBe(200);
    const policies = field(response, "policies") as {
      policyType: string;
      runtimeStatus: { mode: string; displayLevel: string };
    }[];
    const byType = new Map(policies.map((policy) => [policy.policyType, policy.runtimeStatus]));
    expect(byType.get("external_sharing")?.mode).toBe("enforced");
    expect(byType.get("sso")?.mode).toBe("recorded_only");
    expect(byType.get("dlp")?.mode).toBe("recorded_only");
  });

  it("refuses SSO/DLP enforcement=required while runtime is recorded-only", async () => {
    const { app } = await buildApp();
    for (const policyType of ["sso", "dlp", "device_trust"] as const) {
      const response = await app.inject({
        method: "PUT",
        url: `/api/admin/security-policies/${policyType}`,
        headers: headers("admin.console.write"),
        payload: { enabled: true, enforcement: "required" },
      });
      expect(response.statusCode).toBe(400);
      expect(String(body(response).error)).toMatch(/required|enforce/i);
    }
  });
});

describe("InMemorySecurityPoliciesStore", () => {
  it("upsert keeps the createdAt of the first write", async () => {
    let tick = 0;
    const store = new InMemorySecurityPoliciesStore({
      now: () => new Date(Date.UTC(2026, 4, 21, 0, 0, (tick += 1))),
    });
    const first = await store.upsert({
      orgId,
      policyType: "session",
      enabled: true,
      enforcement: "optional",
      settings: {},
      updatedBy: actorId,
    });
    const second = await store.upsert({
      orgId,
      policyType: "session",
      enabled: false,
      enforcement: "disabled",
      settings: {},
      updatedBy: actorId,
    });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).not.toBe(first.updatedAt);
  });
});
