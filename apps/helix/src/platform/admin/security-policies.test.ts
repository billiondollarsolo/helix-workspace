import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/actor.js";
import {
  InMemorySecurityPoliciesStore,
  SECURITY_POLICY_TYPES,
  defaultPolicy,
  parsePolicySettings,
  registerAdminSecurityPoliciesRoutes,
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
    const policies = (field(response, "policies") as { policyType: string }[]);
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
    const updatedPolicy = (field(updated, "policy") as { enabled: boolean; enforcement: string });
    expect(updatedPolicy.enabled).toBe(true);
    expect(updatedPolicy.enforcement).toBe("required");

    const reread = await app.inject({
      method: "GET",
      url: "/api/admin/security-policies/mfa",
      headers: headers("admin.console.read"),
    });
    expect((field(reread, "policy") as { settings: { rememberDeviceDays: number } }).settings.rememberDeviceDays).toBe(30);
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
