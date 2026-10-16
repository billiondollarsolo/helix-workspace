import type { Actor } from "@helix/sdk-types";
import { describe, expect, it } from "vitest";
import { AllowAllToolAccessPolicy } from "../platform/permissions/tool-access.js";
import { createToolRegistry } from "../platform/tool-registry.js";
import { unauthenticatedActor } from "./actor.js";
import {
  buildProtectedResourceMetadata,
  handleMcpHttpPost,
  mcpMethodNotAllowedOutcome,
  type McpHttpOutcome,
} from "./mcp-http.js";
import { MCP_LEGACY_PROTOCOL_VERSION } from "./version.js";

const agentActor: Actor = {
  id: "agent-http",
  orgId: "org-http",
  type: "agent",
  scopes: ["platform.read"],
};
const base = "https://helix.example.com";

async function post(
  body: unknown,
  options: {
    readonly actor?: Actor;
    readonly headers?: Record<string, string>;
    readonly stream?: boolean;
  } = {},
): Promise<McpHttpOutcome> {
  return handleMcpHttpPost({
    tools: createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() }),
    principal: { actor: options.actor ?? agentActor },
    body,
    headers: options.headers ?? {},
    acceptsEventStream: options.stream ?? false,
    publicBaseUrl: base,
  });
}

describe("MCP Streamable HTTP transport (MC5 / MC6)", () => {
  it.each(["user", "agent", "service_account"] as const)(
    "accepts an authenticated %s in the default workspace",
    async (type) => {
      const outcome = await post(
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { actor: { ...agentActor, type, orgId: "00000000-0000-0000-0000-000000000000" } },
      );
      expect(outcome).toMatchObject({
        statusCode: 200,
        body: { result: { capabilities: { tools: {}, resources: {} } } },
      });
    },
  );

  it("returns 401 with a resource_metadata challenge before opening an SSE stream", async () => {
    const outcome = await post(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { actor: unauthenticatedActor, stream: true },
    );
    expect(outcome).toMatchObject({
      kind: "json",
      statusCode: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      },
    });
  });

  it("answers notifications and client responses with 202 and no body", async () => {
    for (const body of [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } },
      { jsonrpc: "2.0", id: "server-1", result: {} },
    ]) {
      const outcome = await post(body);
      expect(outcome).toEqual({ kind: "json", statusCode: 202, headers: {} });
    }
  });

  it("validates MCP-Protocol-Version when present and accepts it when missing", async () => {
    const ping = { jsonrpc: "2.0", id: "p", method: "ping" };
    await expect(
      post(ping, { headers: { "mcp-protocol-version": "1999-01-01" } }),
    ).resolves.toMatchObject({
      statusCode: 400,
      body: { id: "p", error: { code: -32022 } },
    });
    await expect(
      post(ping, { headers: { "mcp-protocol-version": MCP_LEGACY_PROTOCOL_VERSION } }),
    ).resolves.toMatchObject({ statusCode: 200, body: { id: "p", result: {} } });
    await expect(post(ping)).resolves.toMatchObject({ statusCode: 200 });
  });

  it("negotiates the protocol version and issues a session id on initialize", async () => {
    const older = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    });
    expect(older).toMatchObject({
      statusCode: 200,
      headers: { "mcp-session-id": expect.any(String) },
      body: { result: { protocolVersion: "2025-03-26" } },
    });
    const unknown = await post({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    expect(unknown).toMatchObject({
      body: { result: { protocolVersion: MCP_LEGACY_PROTOCOL_VERSION } },
    });
    const later = await post(
      { jsonrpc: "2.0", id: 3, method: "ping" },
      { headers: { "mcp-session-id": "session-1" } },
    );
    expect(later).toMatchObject({ statusCode: 200, headers: {} });
  });

  it("rejects GET with 405 and Allow: POST", () => {
    expect(mcpMethodNotAllowedOutcome()).toMatchObject({
      statusCode: 405,
      headers: { allow: "POST" },
    });
  });

  it("streams JSON-RPC responses as SSE message events for event-stream clients", async () => {
    const outcome = await post({ jsonrpc: "2.0", id: "s", method: "ping" }, { stream: true });
    if (outcome.kind !== "stream") throw new Error("Expected a stream outcome.");
    const events = [];
    for await (const event of outcome.events) events.push(event);
    expect(events).toEqual([{ event: "message", data: { jsonrpc: "2.0", id: "s", result: {} } }]);
  });
});

describe("RFC 9728 protected resource metadata", () => {
  it("names the MCP resource, the OAuth issuer, header bearer tokens, and tool scopes", () => {
    const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
    tools.register({
      id: "mail.send",
      description: "Send mail.",
      permission: "mail.send",
      sideEffects: "external_communication",
      inputSchema: { parse: (value) => value, toJsonSchema: () => ({ type: "object" }) },
      outputSchema: { parse: (value) => value, toJsonSchema: () => ({ type: "object" }) },
      scopeComposition: {
        conditionalScopes: [{ scope: "mail.external", reason: "external", when: () => true }],
      },
      handler: async () => ({}),
    });
    expect(
      buildProtectedResourceMetadata({
        publicBaseUrl: `${base}/`,
        authorizationServer: "https://auth.example.com/",
        tools: tools.list(),
      }),
    ).toEqual({
      resource: `${base}/v1/mcp`,
      authorization_servers: ["https://auth.example.com"],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mail.external", "mail.send", "platform.read"],
      resource_name: "Helix Workspace MCP",
    });
  });
});
