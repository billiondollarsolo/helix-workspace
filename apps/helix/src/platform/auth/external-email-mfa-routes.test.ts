import type { Actor } from "@helix/sdk-types";
import fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/api-error.js";
import type { TenantContext } from "../tenancy/context.js";
import { registerExternalEmailMfaRoutes } from "./external-email-mfa-routes.js";

const person: Actor = { id: "actor-1", orgId: "tenant-1", type: "user" };
const apps: ReturnType<typeof fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup(actor: Actor | null = person, passwordValid = true) {
  const app = fastify();
  apps.push(app);
  app.decorateRequest("tenant", null);
  app.addHook("preHandler", async (request) => {
    request.tenant = { orgId: "tenant-1" } as TenantContext;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError)
      return reply.code(error.statusCode).send({ message: error.message });
    throw error;
  });
  const factors = {
    status: vi.fn(async () => ({
      outboundReady: true,
      email: "external@gmail.com",
      verified: true,
      enabled: false,
      totpEnabled: false,
      pendingEmail: null,
    })),
    beginVerification: vi.fn(async () => undefined),
    verifyAddress: vi.fn(async () => undefined),
    setEnabled: vi.fn(async () => undefined),
  };
  const handler = vi.fn(async () =>
    Response.json({ status: passwordValid }, { status: passwordValid ? 200 : 400 }),
  );
  const invalidateOtherSessions = vi.fn(async () => undefined);
  const append = vi.fn(async () => ({ id: "audit", thisHash: "hash" }));
  registerExternalEmailMfaRoutes(app, {
    auth: { handler, api: { getSession: async () => null } },
    verifier: {
      getSessionUser: async () => ({ id: "auth-user-1", email: "person@workspace.test" }),
      getSessionToken: async () => "current-token",
    },
    actors: { resolve: async () => actor },
    factors,
    recoveryCodes: { invalidateOtherSessions },
    audit: { append },
  });
  return { app, factors, handler, invalidateOtherSessions, append };
}

describe("external email factor account routes", () => {
  it.each([
    { actor: null, status: 401 },
    { actor: { ...person, type: "agent" as const }, status: 403 },
    { actor: { ...person, orgId: "another-tenant" }, status: 403 },
  ])(
    "rejects an unauthorized principal before reading factor state ($status)",
    async ({ actor, status }) => {
      const probe = setup(actor);
      expect((await probe.app.inject("/api/account/email-mfa")).statusCode).toBe(status);
      expect(probe.factors.status).not.toHaveBeenCalled();
    },
  );

  it("rejects caller-selected identities and a wrong password before sending", async () => {
    const probe = setup(person, false);
    const extra = await probe.app.inject({
      method: "POST",
      url: "/api/account/email-mfa/verification",
      payload: { email: "external@gmail.com", password: "password", userId: "someone-else" },
    });
    expect(extra.statusCode).toBe(400);
    expect(probe.handler).not.toHaveBeenCalled();
    const wrong = await probe.app.inject({
      method: "POST",
      url: "/api/account/email-mfa/verification",
      payload: { email: "external@gmail.com", password: "wrong" },
    });
    expect(wrong.statusCode).toBe(400);
    expect(probe.factors.beginVerification).not.toHaveBeenCalled();
  });

  it("binds verification and opt-in to the authenticated identity and audits without codes", async () => {
    const probe = setup();
    const sent = await probe.app.inject({
      method: "POST",
      url: "/api/account/email-mfa/verification",
      payload: { email: "External@Gmail.com", password: "password" },
    });
    expect(sent.statusCode).toBe(200);
    expect(probe.factors.beginVerification).toHaveBeenCalledWith(
      "auth-user-1",
      "external@gmail.com",
      "person@workspace.test",
    );
    expect(probe.factors.setEnabled).not.toHaveBeenCalled();
    const confirmed = await probe.app.inject({
      method: "POST",
      url: "/api/account/email-mfa/verification/confirm",
      payload: { code: "123456" },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(probe.factors.verifyAddress).toHaveBeenCalledWith("auth-user-1", "123456");
    const enabled = await probe.app.inject({
      method: "POST",
      url: "/api/account/email-mfa/enabled",
      payload: { enabled: true, password: "password" },
    });
    expect(enabled.statusCode).toBe(200);
    expect(probe.factors.setEnabled).toHaveBeenCalledWith("auth-user-1", true);
    expect(probe.invalidateOtherSessions).toHaveBeenCalledWith("auth-user-1", "current-token");
    expect(JSON.stringify(probe.append.mock.calls)).not.toContain("123456");
    expect(JSON.stringify(probe.append.mock.calls)).not.toContain("password");
    expect(probe.append).toHaveBeenCalledTimes(2);
  });
});
