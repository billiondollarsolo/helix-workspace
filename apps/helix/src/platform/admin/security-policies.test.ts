import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { createRecordingSql } from "../../test-support/recording-sql.js";
import { actorFromRequest } from "../../api/test-actor.js";
import {
  InMemorySecurityPoliciesStore,
  PostgresSecurityPoliciesStore,
  SECURITY_POLICY_TYPES,
  defaultPolicy,
  parsePolicySettings,
  registerAdminSecurityPoliciesRoutes,
} from "./security-policies.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const auditSink = { append: async () => ({ id: "audit", thisHash: "hash" }) };

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
  await registerAdminSecurityPoliciesRoutes(app, {
    store,
    actorFromRequest,
    auditSink,
    mfa: { isMfaVerified: () => true, isRecentlyAuthenticated: () => true },
  });
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

  it("does not accept removed editor apps in device trust policies", () => {
    expect(
      parsePolicySettings("device_trust", { protectedApps: ["drive", "mail", "calendar"] }).ok,
    ).toBe(true);
    expect(parsePolicySettings("device_trust", { protectedApps: ["docs"] }).ok).toBe(false);
  });

  it("stores bounded idle, absolute, reauthentication, and concurrent session limits", () => {
    expect(defaultPolicy("session").settings).toEqual({
      inactivityTimeoutDays: 14,
      absoluteLifetimeDays: 7,
      reauthForAdminActions: true,
      reauthIntervalMinutes: 10,
      maxConcurrentSessions: 10,
    });
    expect(
      parsePolicySettings("session", {
        inactivityTimeoutDays: 0,
        absoluteLifetimeDays: 91,
        reauthForAdminActions: true,
        reauthIntervalMinutes: 0,
        maxConcurrentSessions: 51,
      }).ok,
    ).toBe(false);
  });

  it("accepts SSO draft settings without allowing local login to be disabled", () => {
    const ok = parsePolicySettings("sso", {
      provider: "generic_oidc",
      metadataUrl: "https://idp.example.com/.well-known/openid-configuration",
      jitProvisioning: true,
      mappedDomains: ["example.com"],
      localLoginEnabled: true,
      setupStatus: "draft",
      testLoginStatus: "configuration_required",
      setupSource: "signup",
    });
    expect(ok.ok).toBe(true);

    const bad = parsePolicySettings("sso", {
      provider: "not-a-provider",
      localLoginEnabled: false,
    });
    expect(bad.ok).toBe(false);
  });

  it("validates the Drive workflow allowlist and due-date requirement", () => {
    expect(
      parsePolicySettings("drive_workflows", {
        allowedKinds: ["approval", "ownership_transfer"],
        requireDueDate: true,
      }).ok,
    ).toBe(true);
    expect(
      parsePolicySettings("drive_workflows", {
        allowedKinds: ["arbitrary_sql"],
        requireDueDate: false,
      }).ok,
    ).toBe(false);
  });
});

describe("admin security policies routes", () => {
  it("lists every policy with defaults before any edit", async () => {
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
    expect(byType.get("dlp")?.mode).toBe("enforced");
  });

  it("refuses SSO/device-trust enforcement=required while runtime is recorded-only", async () => {
    const { app } = await buildApp();
    for (const policyType of ["sso", "device_trust"] as const) {
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

describe("second security administrator eligibility", () => {
  it.each([
    { scopes: ["admin.console.read"], allow: [], deny: [], eligible: false },
    { scopes: ["admin.users"], allow: [], deny: [], eligible: false },
    { scopes: ["admin.security"], allow: [], deny: [], eligible: true },
    { scopes: [], allow: ["admin.security"], deny: [], eligible: true },
    { scopes: ["admin.*"], allow: [], deny: ["admin.security"], eligible: false },
  ])(
    "honors exact security permission and deny precedence ($eligible)",
    async ({ scopes, allow, deny, eligible }) => {
      const recording = createRecordingSql(
        [
          [
            {
              id: "33333333-3333-4333-8333-333333333333",
              scopes,
              role_bindings: [
                {
                  roleId: "44444444-4444-4444-8444-444444444444",
                  allow,
                  deny,
                  scopeType: "org",
                  scopeId: null,
                  resourceType: null,
                },
              ],
            },
          ],
        ],
        "$",
      );
      const store = new PostgresSecurityPoliciesStore(recording.sql);
      expect(
        await store.hasOtherAdministrator({
          id: actorId,
          orgId,
          type: "user",
          scopes: ["admin.security"],
        }),
      ).toBe(eligible);
      expect(recording.calls[0]?.text).toContain("candidate.type = 'user'");
      expect(recording.calls[0]?.text).toContain("helix_credential_principal_is_active");
      expect(recording.calls[0]?.values).toEqual([orgId, actorId]);
    },
  );
});
