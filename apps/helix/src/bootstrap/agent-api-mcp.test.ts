import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { unauthenticatedActor } from "../api/actor.js";
import { handleMcpHttpPost } from "../api/mcp-http.js";
import { AllowAllToolAccessPolicy } from "../platform/permissions/tool-access.js";
import { createToolRegistry } from "../platform/tool-registry.js";
import { registerMcpWellKnownRoutes, sendMcpOutcome } from "./agent-api.js";

const publicUrl = "https://helix.example.com";

function wellKnownApp() {
  const app = fastify();
  registerMcpWellKnownRoutes(app, {
    bootEnv: { HELIX_PUBLIC_URL: publicUrl } as never,
    oauthIssuer: publicUrl,
    tools: createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() }),
  });
  return app;
}

describe("MCP well-known discovery routes (MC5)", () => {
  it("serves RFC 9728 metadata at the root and the resource-specific path", async () => {
    const app = wellKnownApp();
    for (const url of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/v1/mcp",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        resource: `${publicUrl}/v1/mcp`,
        authorization_servers: [publicUrl],
        bearer_methods_supported: ["header"],
        scopes_supported: expect.arrayContaining(["platform.read"]),
      });
    }
    await app.close();
  });

  it("serves issuer-relative RFC 8414 authorization server metadata at the root", async () => {
    const app = wellKnownApp();
    const response = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    expect(response.json()).toMatchObject({
      issuer: publicUrl,
      token_endpoint: `${publicUrl}/v1/oauth/token`,
      code_challenge_methods_supported: ["S256"],
    });
    await app.close();
  });
});

describe("MCP HTTP replies", () => {
  it("sends the 401 challenge as plain JSON even when the client accepts SSE", async () => {
    const app = fastify();
    app.post("/mcp", async (request, reply) =>
      sendMcpOutcome(
        reply,
        await handleMcpHttpPost({
          tools: createToolRegistry(),
          principal: { actor: unauthenticatedActor },
          body: request.body,
          headers: request.headers,
          acceptsEventStream: true,
          publicBaseUrl: publicUrl,
        }),
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { accept: "application/json, text/event-stream" },
      payload: { jsonrpc: "2.0", id: 1, method: "initialize" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["www-authenticate"]).toBe(
      `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`,
    );
    await app.close();
  });

  it("returns 202 with an empty body for notifications", async () => {
    const app = fastify();
    app.post("/mcp", async (request, reply) =>
      sendMcpOutcome(
        reply,
        await handleMcpHttpPost({
          tools: createToolRegistry(),
          principal: {
            actor: { id: "agent-1", orgId: "org-1", type: "agent", scopes: [] },
          },
          body: request.body,
          headers: request.headers,
          acceptsEventStream: false,
          publicBaseUrl: publicUrl,
        }),
      ),
    );
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(response.statusCode).toBe(202);
    expect(response.body).toBe("");
    await app.close();
  });
});
