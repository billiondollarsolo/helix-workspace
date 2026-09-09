import websocket from "@fastify/websocket";
import { initTRPC } from "@trpc/server";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createToolRegistry } from "../platform/tool-registry.js";
import { InMemoryOAuthClientStore } from "../platform/auth/oauth.js";
import { createPlatformMetrics } from "./metrics.js";
import { installUntrustedIdentityHeaderGuard, registerToolRestRoutes } from "../server.js";

const forgedIdentityHeaders = {
  "x-helix-actor-id": "forged-admin",
  "x-helix-org-id": "victim-org",
  "x-helix-scopes": "admin.*",
};

describe("reserved identity header boundary", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => app?.close());

  it("returns 401 for a forged REST request", async () => {
    app = guardedApp();
    app.get("/api/identity-check", async () => ({ ok: true }));

    expectRejected(
      await app.inject({
        method: "GET",
        url: "/api/identity-check",
        headers: forgedIdentityHeaders,
      }),
    );
  });

  it("returns 401 for a forged tRPC request", async () => {
    app = guardedApp();
    const trpc = initTRPC.create();
    await app.register(fastifyTRPCPlugin, {
      prefix: "/trpc",
      trpcOptions: { router: trpc.router({ health: trpc.procedure.query(() => ({ ok: true })) }) },
    });

    expectRejected(
      await app.inject({ method: "GET", url: "/trpc/health", headers: forgedIdentityHeaders }),
    );
  });

  it("returns 401 for a forged tool request", async () => {
    app = guardedApp();
    registerToolRestRoutes(app, {
      tools: createToolRegistry(),
      metrics: createPlatformMetrics(),
      tokenStore: new InMemoryOAuthClientStore(),
    });

    expectRejected(
      await app.inject({
        method: "GET",
        url: "/api/tools/unknown",
        headers: forgedIdentityHeaders,
      }),
    );
  });

  it("returns 401 for a forged WebSocket upgrade", async () => {
    app = guardedApp();
    await app.register(websocket);
    app.get("/ws/identity-check", { websocket: true }, () => undefined);
    await app.ready();

    await expect(
      app.injectWS("/ws/identity-check", { headers: forgedIdentityHeaders }),
    ).rejects.toThrow("Unexpected server response: 401");
  });
});

function guardedApp(): FastifyInstance {
  const app = fastify();
  installUntrustedIdentityHeaderGuard(app);
  return app;
}

function expectRejected(response: { readonly statusCode: number; json(): unknown }): void {
  expect(response.statusCode).toBe(401);
  expect(response.json()).toMatchObject({
    error: {
      code: "untrusted_identity_assertion",
      details: { header: "x-helix-actor-id" },
    },
  });
}
