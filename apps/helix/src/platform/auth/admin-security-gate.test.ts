import type { Actor, SecurityTier } from "@helix/sdk-types";
import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "../../api/api-error.js";
import { requireActorScope } from "../../api/scopes.js";
import { isAdminMfaProtectedPath, registerCanonicalApi } from "../../bootstrap/route-scope.js";
import {
  InMemorySecurityPoliciesStore,
  registerAdminSecurityPoliciesRoutes,
} from "../admin/security-policies.js";
import { installAdminSecurityGate } from "./admin-security-gate.js";
import {
  resolveAdminSecurityControls,
  isSecurityPolicyRecoveryRequest,
} from "./admin-security-policy.js";
import type { CrownJewelApprovalStore } from "./crown-jewel.js";

const actor: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId: "22222222-2222-4222-8222-222222222222",
  type: "user",
  scopes: ["admin.security", "admin.domains"],
};
const off = {
  adminMfa: "optional",
  sensitiveActionMfaRequired: false,
  secondAdminApprovalRequired: false,
};
const policyUrl = "/v1/api/admin/security-policies/mfa";
const domainUrl = "/v1/api/admin/domains/one/capabilities";

async function harness(tier: SecurityTier = "enterprise") {
  const store = new InMemorySecurityPoliciesStore();
  const approvals: CrownJewelApprovalStore = {
    get: vi.fn(async () => null),
    approve: vi.fn(async () => ({ kind: "not_found" as const })),
    consume: vi.fn(async () => ({ kind: "not_found" as const })),
    reject: vi.fn(async () => {}),
    request: vi.fn(async (input) => ({
      id: "33333333-3333-4333-8333-333333333333",
      orgId: input.orgId,
      requesterActorId: input.actorId,
      actionId: input.action.id,
      permission: input.action.permission,
      fingerprint: input.fingerprint,
      status: "pending_confirmation" as const,
      approvedByActorId: null,
      expiresAt: input.expiresAt,
      consumedAt: null,
    })),
  };
  const auditSink = { append: vi.fn(async () => ({ id: "audit", thisHash: "hash" })) };
  const state = { actor, authenticated: true, recent: true, mfa: false, otherAdministrator: true };
  const actorFromRequest = () => {
    if (!state.authenticated) throw new ForbiddenError("Authentication required");
    return state.actor;
  };
  const mfa = {
    isMfaVerified: vi.fn(() => state.mfa),
    isRecentlyAuthenticated: vi.fn(() => state.recent),
  };
  const app = fastify();
  await registerCanonicalApi(app, async (api) => {
    installAdminSecurityGate(api, {
      policies: store,
      approvals,
      actorFromRequest,
      mfa,
      securityTier: () => tier,
      protectedPath: isAdminMfaProtectedPath,
      traceId: () => "trace",
    });
    await registerAdminSecurityPoliciesRoutes(api, {
      store,
      actorFromRequest,
      auditSink,
      mfa,
      securityTier: () => tier,
      hasOtherAdministrator: async () => state.otherAdministrator,
    });
    api.patch("/api/admin/domains/:id/capabilities", () => {
      requireActorScope(actorFromRequest(), "admin.domains");
      return { changed: true };
    });
  });
  const update = (settings: Record<string, unknown>) =>
    app.inject({ method: "PUT", url: policyUrl, payload: { settings } });
  const mutate = () =>
    app.inject({ method: "PATCH", url: domainUrl, payload: { mailEnabled: true } });
  return { app, store, approvals, auditSink, state, mfa, update, mutate };
}

describe("operator security controls", () => {
  it.each(["personal", "business", "enterprise", "sovereign"] as const)(
    "honors explicit optional MFA on %s without changing inherited defaults",
    (tier) => {
      expect(resolveAdminSecurityControls(tier).adminMfaRequired).toBe(tier !== "personal");
      expect(
        resolveAdminSecurityControls(tier, {
          enabled: true,
          enforcement: "required",
          settings: off,
        }),
      ).toEqual({
        adminMfaRequired: false,
        adminMfaSource: "policy",
        sensitiveActionMfaRequired: false,
        secondAdminApprovalRequired: false,
      });
    },
  );

  it("lets a freshly authenticated sole admin replace inherited requirements, read effective policy, and act immediately", async () => {
    const h = await harness();
    expect((await h.mutate()).statusCode).toBe(403);
    const saved = await h.update(off);
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      policy: {
        settings: off,
        effectiveControls: {
          adminMfaRequired: false,
          sensitiveActionMfaRequired: false,
          secondAdminApprovalRequired: false,
        },
      },
    });
    expect((await h.mutate()).statusCode).toBe(200);
    expect(h.approvals.request).not.toHaveBeenCalled();
    expect(h.auditSink.append).toHaveBeenCalledWith(
      expect.objectContaining({
        verb: "admin.security_policy.updated",
        metadata: expect.objectContaining({
          controls: expect.objectContaining({ secondAdminApprovalRequired: false }),
        }),
      }),
    );
    expect((await h.app.inject({ method: "GET", url: policyUrl })).json()).toMatchObject(
      saved.json(),
    );
    await h.app.close();
  });

  it("rejects stale login, forged headers, missing authentication, delegated denials, and machine policy changes", async () => {
    const h = await harness();
    h.state.recent = false;
    const stale = await h.app.inject({
      method: "PUT",
      url: policyUrl,
      headers: { "x-helix-mfa-verified": "true" },
      payload: { settings: off },
    });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ code: "security_policy_reauthentication_required" });
    h.state.recent = true;
    h.state.authenticated = false;
    expect((await h.update(off)).statusCode).toBe(403);
    h.state.authenticated = true;
    h.state.actor = { ...actor, scopes: ["admin.console.read"] };
    expect((await h.update(off)).statusCode).toBe(403);
    h.state.actor = { ...actor, type: "agent" };
    expect((await h.update(off)).statusCode).toBe(403);
    expect(await h.store.get(actor.orgId, "mfa")).toBeNull();
    await h.app.close();
  });

  it("requires an actual factor before enabling MFA and protects an explicit requirement against password-only changes", async () => {
    const h = await harness("personal");
    await h.update(off);
    expect((await h.update({ adminMfa: "required" })).json()).toMatchObject({
      code: "security_policy_mfa_required",
    });
    h.state.mfa = true;
    expect((await h.update({ adminMfa: "required" })).statusCode).toBe(200);
    h.state.mfa = false;
    expect((await h.update(off)).json()).toMatchObject({ code: "crown_jewel_step_up_required" });
    h.state.mfa = true;
    expect((await h.update(off)).statusCode).toBe(200);
    await h.app.close();
  });

  it("does not let a sole owner enable an impossible second-admin requirement", async () => {
    const h = await harness();
    h.state.otherAdministrator = false;
    const response = await h.update({ ...off, secondAdminApprovalRequired: true });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "security_policy_second_admin_required" });
    expect(await h.store.get(actor.orgId, "mfa")).toBeNull();
    await h.app.close();
  });

  it("enforces independent sensitive MFA and second-admin choices, including policy edits", async () => {
    const h = await harness("personal");
    await h.update(off);
    h.state.mfa = true;
    await h.update({ sensitiveActionMfaRequired: true });
    h.state.mfa = false;
    expect((await h.mutate()).json()).toMatchObject({ code: "crown_jewel_step_up_required" });
    h.state.mfa = true;
    expect((await h.mutate()).statusCode).toBe(200);
    await h.update({ sensitiveActionMfaRequired: false, secondAdminApprovalRequired: true });
    h.state.mfa = false;
    expect((await h.mutate()).json()).toMatchObject({ code: "crown_jewel_approval_required" });
    const protectedChange = await h.update(off);
    expect(protectedChange.statusCode).toBe(202);
    const encoded = await h.app.inject({
      method: "PUT",
      url: "/v1/api/admin/security-policies/%6dfa",
      payload: { settings: off },
    });
    expect(encoded.statusCode).toBe(202);

    expect(protectedChange.json()).toMatchObject({
      approval: { actionId: "security.policy.update" },
    });
    expect((await h.store.get(actor.orgId, "mfa"))?.settings.secondAdminApprovalRequired).toBe(
      true,
    );
    await h.app.close();
  });

  it("does not grant a route's permission or another tenant's optional policy", async () => {
    const h = await harness();
    await h.update(off);
    h.state.actor = { ...actor, scopes: ["admin.security"] };
    expect((await h.mutate()).statusCode).toBe(403);
    h.state.actor = { ...actor, orgId: "44444444-4444-4444-8444-444444444444" };
    expect((await h.mutate()).statusCode).toBe(403);
    await h.app.close();
  });

  it("applies tier MFA to delegated role administrators as well as direct admin scopes", async () => {
    const h = await harness();
    h.state.actor = {
      ...actor,
      scopes: [],
      roleBindings: [
        {
          roleId: "33333333-3333-4333-8333-333333333333",
          allow: ["admin.domains"],
          deny: [],
          scope: { type: "org" },
        },
      ],
    };
    expect((await h.mutate()).json()).toMatchObject({ error: { code: "admin_mfa_required" } });
    await h.app.close();
  });

  it("limits the recovery exemption to exact policy read/write routes", () => {
    expect(isSecurityPolicyRecoveryRequest("GET", "/v1/api/admin/security-policies")).toBe(true);
    expect(
      isSecurityPolicyRecoveryRequest("PUT", "/v1/api/admin/security-policies/session?x=1"),
    ).toBe(true);
    for (const url of [
      "/api/admin/security-policies/sso",
      "/api/admin/security-policies/mfa/extra",
      "/api/admin/users",
      "/api/admin/security-policies/mfa/../sso",
    ])
      expect(isSecurityPolicyRecoveryRequest("PUT", url)).toBe(false);
    expect(isSecurityPolicyRecoveryRequest("DELETE", policyUrl)).toBe(false);
  });
});
