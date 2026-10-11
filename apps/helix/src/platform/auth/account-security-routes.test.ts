import type { Actor } from "@helix/sdk-types";
import fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/api-error.js";
import { describeUserAgent, registerAccountSecurityRoutes } from "./account-security-routes.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const person: Actor = {
  id: "22222222-2222-4222-8222-222222222222",
  orgId,
  type: "user",
  scopes: ["profile.read"],
};
const chrome =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36";
const iphone =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const sessions = [
  {
    id: "session-current",
    token: "token-current",
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-10T10:00:00.000Z",
    expiresAt: "2027-01-01T10:00:00.000Z",
    ipAddress: "203.0.113.4",
    userAgent: chrome,
  },
  {
    id: "session-phone",
    token: "token-phone",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-10-11T08:00:00.000Z",
    expiresAt: "2026-12-01T10:00:00.000Z",
    ipAddress: null,
    userAgent: iphone,
  },
];

function setup(
  options: { readonly actor?: Actor | null; readonly respond?: (path: string) => Response } = {},
) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const audits: { verb: string; metadata?: Record<string, unknown> }[] = [];
  const app: FastifyInstance = fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError)
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    throw error;
  });
  registerAccountSecurityRoutes(app, {
    auth: {
      async handler(request) {
        const path = new URL(request.url).pathname;
        const text = request.method === "GET" ? "" : await request.text();
        calls.push({ path, method: request.method, body: text === "" ? null : JSON.parse(text) });
        if (options.respond !== undefined) return options.respond(path);
        if (path.endsWith("/list-sessions")) return Response.json(sessions);
        if (path.endsWith("/change-password"))
          return new Response(JSON.stringify({ token: "rotated" }), {
            headers: { "set-cookie": "helix_session=rotated; Path=/; HttpOnly" },
          });
        return Response.json({ status: true });
      },
    },
    sessionVerifier: { getSessionToken: async () => "token-current" },
    sessionActorResolver: { resolve: async () => options.actor ?? person },
    auditSink: {
      async append(record) {
        audits.push({
          verb: record.verb,
          ...(record.metadata ? { metadata: record.metadata } : {}),
        });
        return { id: "audit", thisHash: "hash" };
      },
    },
  });
  return { app, calls, audits };
}

describe("account security routes", () => {
  it("lists the person's sessions without tokens, current first, with device details", async () => {
    const { app } = setup();
    const response = await app.inject({ method: "GET", url: "/api/account/sessions" });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("token-");
    expect(response.json()).toEqual({
      sessions: [
        expect.objectContaining({
          id: "session-current",
          current: true,
          browser: "Chrome",
          os: "macOS",
          deviceType: "desktop",
          ipAddress: "203.0.113.4",
        }),
        expect.objectContaining({
          id: "session-phone",
          current: false,
          browser: "Safari",
          os: "iOS",
          deviceType: "mobile",
          lastActiveAt: "2026-10-11T08:00:00.000Z",
        }),
      ],
    });
  });

  it("signs out another session by id but refuses the current one", async () => {
    const { app, calls, audits } = setup();

    const other = await app.inject({
      method: "POST",
      url: "/api/account/sessions/session-phone/revoke",
    });
    const current = await app.inject({
      method: "POST",
      url: "/api/account/sessions/session-current/revoke",
    });
    const missing = await app.inject({
      method: "POST",
      url: "/api/account/sessions/session-gone/revoke",
    });

    expect(other.json()).toEqual({ revoked: true });
    expect(calls).toContainEqual({
      path: "/api/auth/revoke-session",
      method: "POST",
      body: { token: "token-phone" },
    });
    expect(current.statusCode).toBe(400);
    expect(missing.statusCode).toBe(404);
    expect(audits).toEqual([
      { verb: "account.session.revoked", metadata: { sessionId: "session-phone" } },
    ]);
  });

  it("signs out every other session", async () => {
    const { app, calls, audits } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/account/sessions/revoke-others",
    });
    expect(response.json()).toEqual({ revoked: 1 });
    expect(calls.map((call) => call.path)).toContain("/api/auth/revoke-other-sessions");
    expect(audits[0]?.verb).toBe("account.sessions.revoked_others");
  });

  it("changes the password through Better Auth and keeps the browser signed in", async () => {
    const { app, calls, audits } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/api/account/password",
      payload: {
        currentPassword: "old-password",
        newPassword: "a-new-password",
        revokeOtherSessions: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ changed: true, revokedOtherSessions: true });
    expect(response.headers["set-cookie"]).toEqual([
      expect.stringContaining("helix_session=rotated"),
    ]);
    expect(calls).toEqual([
      {
        path: "/api/auth/change-password",
        method: "POST",
        body: {
          currentPassword: "old-password",
          newPassword: "a-new-password",
          revokeOtherSessions: true,
        },
      },
    ]);
    expect(audits).toEqual([
      { verb: "account.password.changed", metadata: { revokedOtherSessions: true } },
    ]);
  });

  it("explains a wrong current password, short passwords and non-people", async () => {
    const wrong = setup({
      respond: () => Response.json({ code: "INVALID_PASSWORD" }, { status: 400 }),
    });
    const wrongResponse = await wrong.app.inject({
      method: "POST",
      url: "/api/account/password",
      payload: { currentPassword: "nope", newPassword: "long-enough" },
    });
    const short = await setup().app.inject({
      method: "POST",
      url: "/api/account/password",
      payload: { currentPassword: "old", newPassword: "short" },
    });
    const agent = await setup({ actor: { ...person, type: "agent" } }).app.inject({
      method: "GET",
      url: "/api/account/sessions",
    });
    const anonymous = await setup({ actor: { ...person, id: "anonymous" } }).app.inject({
      method: "GET",
      url: "/api/account/sessions",
    });

    expect(wrongResponse.statusCode).toBe(400);
    expect(wrongResponse.json()).toMatchObject({ message: "Your current password is incorrect." });
    expect(wrong.audits).toEqual([]);
    expect(short.statusCode).toBe(400);
    expect(agent.statusCode).toBe(403);
    expect(anonymous.statusCode).toBe(401);
  });

  it("summarises common user agents", () => {
    expect(describeUserAgent("")).toEqual({
      browser: "Unknown",
      os: "Unknown",
      deviceType: "unknown",
    });
    expect(
      describeUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0",
      ),
    ).toEqual({ browser: "Edge", os: "Windows", deviceType: "desktop" });
  });
});
