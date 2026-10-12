import type { Actor, JsonObject } from "@helix/sdk-types";
import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { OrgRecord, UpdateTenantConfigInput } from "../../tenancy/orgs.js";
import { registerMailDecisionAdminRoutes } from "./admin-routes.js";
import type { DecisionModelProviderId, ResolvedDecisionModelConfig } from "./config.js";
import { DecisionModelError } from "./protocol.js";
import type { DecisionModelProvider } from "./providers.js";
import type { DecisionModelReport } from "./report.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const admin: Actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId,
  type: "user",
  displayName: "Admin",
  scopes: ["admin.console.write"],
};
const accountId = "0123456789abcdef0123456789abcdef";
const secret = "cf-super-secret-token";

function setup(options: { spamd?: boolean; decide?: () => Promise<unknown> } = {}) {
  let actor: Actor = admin;
  let featureFlags: JsonObject = {};
  let credential: { provider: DecisionModelProviderId; value: string } | null = null;
  const org = (): OrgRecord => ({
    id: orgId,
    slug: "acme",
    displayName: "Acme",
    status: "active",
    tier: "business",
    region: "default",
    byoConfig: {},
    featureFlags,
    quotas: {},
    branding: {},
    suspendedAt: null,
    softDeletedAt: null,
    hardDeletedAt: null,
  });
  const updateTenantConfig = vi.fn(async (input: UpdateTenantConfigInput) => {
    featureFlags = { ...featureFlags, ...input.featureFlags };
    return org();
  });
  const append = vi.fn().mockResolvedValue({ id: "audit", thisHash: "hash" });
  const decide = vi.fn<DecisionModelProvider["decide"]>(
    (options.decide as DecisionModelProvider["decide"] | undefined) ??
      (async () => ({
        model: "clef-flash",
        usage: { inputTokens: 30, outputTokens: 0 },
        answers: {
          verdict: {
            type: "choice",
            answer: "legitimate",
            probabilities: { legitimate: 0.98, spam: 0.02 },
            confidence: 0.98,
          },
        },
      })),
  );
  const createProvider = vi.fn((config: ResolvedDecisionModelConfig): DecisionModelProvider => ({
    id: config.provider,
    model: config.model,
    decide,
  }));
  const buildReport = vi.fn(
    async () => ({ totals: { recorded: 0 } }) as unknown as DecisionModelReport,
  );
  const app = fastify();
  registerMailDecisionAdminRoutes(app, {
    store: {
      credentialStatus: async () =>
        credential === null
          ? null
          : { provider: credential.provider, updatedAt: new Date("2026-10-12T00:00:00.000Z") },
      readCredential: async (_org, provider) =>
        credential?.provider === provider ? credential.value : null,
      saveCredential: async (input) => {
        credential = { provider: input.provider, value: input.credential };
      },
      clearCredential: async () => {
        const had = credential !== null;
        credential = null;
        return had;
      },
      countAutoSpamSince: async () => 4,
    },
    orgs: { findById: async () => org(), updateTenantConfig },
    buildReport,
    actorFromRequest: () => actor,
    auditSink: { append },
    ...(options.spamd === true ? { spamd: { threshold: 5, ping: async () => true } } : {}),
    env: { MAIL_SPAM_AI_BETA_ENABLED: "false" },
    createProvider,
    now: () => new Date("2026-10-12T12:00:00.000Z"),
  });
  return {
    app,
    append,
    decide,
    createProvider,
    buildReport,
    updateTenantConfig,
    setActor: (next: Actor) => {
      actor = next;
    },
    flags: () => featureFlags,
    credential: () => credential,
  };
}

const enable = {
  settings: { mode: "shadow", provider: "cloudflare", cloudflareAccountId: accountId },
  apiKey: secret,
};

describe("decision model admin routes", () => {
  it("gates reads and writes by mail admin permissions", async () => {
    const h = setup();
    h.setActor({ ...admin, scopes: [] });
    expect((await h.app.inject({ url: "/api/admin/mail/decision-model" })).statusCode).toBe(403);
    expect((await h.app.inject({ url: "/api/admin/mail/spam" })).statusCode).toBe(403);
    h.setActor({ ...admin, scopes: ["admin.config.read"] });
    expect((await h.app.inject({ url: "/api/admin/mail/decision-model" })).statusCode).toBe(200);
    expect(
      (
        await h.app.inject({
          method: "PUT",
          url: "/api/admin/mail/decision-model",
          payload: enable,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await h.app.inject({ method: "POST", url: "/api/admin/mail/decision-model/test" }))
        .statusCode,
    ).toBe(403);
    h.setActor({ ...admin, scopes: ["mail.admin"] });
    expect(
      (
        await h.app.inject({
          method: "PUT",
          url: "/api/admin/mail/decision-model",
          payload: enable,
        })
      ).statusCode,
    ).toBe(200);
    expect(h.append).toHaveBeenCalledTimes(1);
  });

  it("keeps the credential write-only and audits without secrets", async () => {
    const h = setup();
    const initial = await h.app.inject({ url: "/api/admin/mail/decision-model" });
    expect(initial.json()).toEqual({
      decisionModel: expect.objectContaining({
        mode: "off",
        provider: "cloudflare",
        model: "clef-flash",
        credentialConfigured: false,
        notice:
          "Message content is sent to Cloudflare Workers AI for classification. Mail labelled confidential or restricted is never sent.",
      }),
    });

    const saved = await h.app.inject({
      method: "PUT",
      url: "/api/admin/mail/decision-model",
      payload: enable,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(secret);
    expect(saved.json().decisionModel).toMatchObject({
      mode: "shadow",
      cloudflareAccountId: accountId,
      credentialConfigured: true,
      credentialUpdatedAt: "2026-10-12T00:00:00.000Z",
      endpointHost: "api.cloudflare.com",
    });
    expect(h.credential()).toEqual({ provider: "cloudflare", value: secret });
    expect(h.flags().mail_decision_model).toMatchObject({ mode: "shadow", provider: "cloudflare" });
    expect(JSON.stringify(h.flags())).not.toContain(secret);
    expect(h.updateTenantConfig).toHaveBeenCalledWith(
      expect.objectContaining({ changedByActorId: admin.id, orgId }),
    );
    expect(h.append).toHaveBeenCalledWith({
      orgId,
      actorId: admin.id,
      verb: "mail.decision_model.updated",
      objectType: "mail_decision_model",
      objectId: orgId,
      metadata: {
        mode: "shadow",
        previousMode: "off",
        provider: "cloudflare",
        model: "clef-flash",
        credential: "set",
      },
    });
    expect(JSON.stringify(h.append.mock.calls)).not.toContain(secret);
    const read = await h.app.inject({ url: "/api/admin/mail/decision-model" });
    expect(read.body).not.toContain(secret);

    // Switching provider without a new key leaves the new provider unconfigured.
    const switched = await h.app.inject({
      method: "PUT",
      url: "/api/admin/mail/decision-model",
      payload: { settings: { mode: "enforce", provider: "typesafe" } },
    });
    expect(switched.statusCode).toBe(400);
    expect(switched.json()).toEqual({
      code: "invalid_request",
      error: "Add the TypeSafe API key before turning on enforce mode.",
    });
  });

  it("validates settings with actionable errors", async () => {
    const h = setup();
    const missingAccount = await h.app.inject({
      method: "PUT",
      url: "/api/admin/mail/decision-model",
      payload: { settings: { mode: "shadow", provider: "cloudflare" }, apiKey: secret },
    });
    expect(missingAccount.statusCode).toBe(400);
    expect(JSON.stringify(missingAccount.json().issues)).toContain(
      "cloudflareAccountId is required",
    );
    const insecure = await h.app.inject({
      method: "PUT",
      url: "/api/admin/mail/decision-model",
      payload: { settings: { provider: "typesafe", baseUrl: "http://example.test" } },
    });
    expect(insecure.statusCode).toBe(400);
    const both = await h.app.inject({
      method: "PUT",
      url: "/api/admin/mail/decision-model",
      payload: { ...enable, clearApiKey: true },
    });
    expect(both.statusCode).toBe(400);
    expect(h.updateTenantConfig).not.toHaveBeenCalled();
  });

  it("tests the connection with a draft key and audits the outcome", async () => {
    const h = setup();
    const response = await h.app.inject({
      method: "POST",
      url: "/api/admin/mail/decision-model/test",
      payload: enable,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      test: {
        ok: true,
        latencyMs: expect.any(Number),
        model: "clef-flash",
        answer: "legitimate",
        confidence: 0.98,
        provider: "cloudflare",
      },
    });
    expect(h.createProvider).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "cloudflare", cloudflareAccountId: accountId }),
      secret,
    );
    expect(h.append).toHaveBeenCalledWith(
      expect.objectContaining({
        verb: "mail.decision_model.tested",
        metadata: expect.objectContaining({ ok: true, provider: "cloudflare" }),
      }),
    );
    expect(JSON.stringify(h.append.mock.calls)).not.toContain(secret);
  });

  it("returns provider failures as actionable 502s and requires a key", async () => {
    const h = setup({
      decide: async () => {
        throw new DecisionModelError("authentication", "Cloudflare rejected the API token.", {
          status: 401,
        });
      },
    });
    const noKey = await h.app.inject({
      method: "POST",
      url: "/api/admin/mail/decision-model/test",
      payload: { settings: enable.settings },
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error).toBe("Add the Cloudflare API token to test the connection.");
    const failed = await h.app.inject({
      method: "POST",
      url: "/api/admin/mail/decision-model/test",
      payload: enable,
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toEqual({
      error: "Cloudflare rejected the API token.",
      code: "provider_error",
      providerCode: "authentication",
      providerStatus: 401,
    });
    expect(h.append).toHaveBeenCalledWith(
      expect.objectContaining({
        verb: "mail.decision_model.tested",
        metadata: expect.objectContaining({ ok: false, code: "authentication" }),
      }),
    );
  });

  it("serves the report with a bounded window", async () => {
    const h = setup();
    expect(
      (await h.app.inject({ url: "/api/admin/mail/decision-model/report?days=91" })).statusCode,
    ).toBe(400);
    const response = await h.app.inject({ url: "/api/admin/mail/decision-model/report?days=7" });
    expect(response.statusCode).toBe(200);
    expect(h.buildReport).toHaveBeenCalledWith(
      expect.objectContaining({ orgId, days: 7, now: new Date("2026-10-12T12:00:00.000Z") }),
    );
    expect(response.json().decisionModel).toEqual({
      mode: "off",
      provider: "cloudflare",
      model: "clef-flash",
    });
  });

  it("reports spam filtering status in the shape the web expects", async () => {
    const withSpamd = setup({ spamd: true });
    expect((await withSpamd.app.inject({ url: "/api/admin/mail/spam" })).json()).toEqual({
      enabled: true,
      threshold: 5,
      rejectThreshold: null,
      daemonStatus: "running",
      rulesetVersion: null,
      taggedLast24h: 4,
      betaSecondPass: { enabled: false, model: null },
      decisionModel: {
        mode: "off",
        provider: "cloudflare",
        model: "clef-flash",
        credentialConfigured: false,
      },
    });
    const without = setup();
    expect((await without.app.inject({ url: "/api/admin/mail/spam" })).json()).toMatchObject({
      enabled: false,
      daemonStatus: "stopped",
    });
  });
});
