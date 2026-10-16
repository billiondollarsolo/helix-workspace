import { describe, expect, it } from "vitest";
import { createToolRegistry } from "../platform/tool-registry.js";
import { AllowAllToolAccessPolicy } from "../platform/permissions/tool-access.js";
import { handleMcpHttpPost } from "./mcp-http.js";
import { MCP_PROTOCOL_VERSION } from "./version.js";
import { MCP_VERSION_META, MCP_CAPABILITIES_META } from "./mcp-modern.js";
const meta = { [MCP_VERSION_META]: MCP_PROTOCOL_VERSION, [MCP_CAPABILITIES_META]: {} };
const principal = {
  actor: {
    id: "modern-agent",
    orgId: "modern-org",
    type: "agent" as const,
    scopes: ["notifications.read"],
  },
};
const tools = createToolRegistry({ accessPolicy: new AllowAllToolAccessPolicy() });
const call = (
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  stream = false,
) =>
  handleMcpHttpPost({
    tools,
    principal,
    body: { jsonrpc: "2.0", id: 7, method, params: { _meta: meta, ...params } },
    headers: { "mcp-protocol-version": MCP_PROTOCOL_VERSION, "mcp-method": method, ...headers },
    acceptsEventStream: stream,
    publicBaseUrl: "https://helix.test",
    live: { read: async (_actor, uri) => ({ uri, text: "{}", mimeType: "application/json" }) },
  });
describe("Modern MCP stateless transport", () => {
  it("discovers without initialize or session and marks actor-specific results private", async () => {
    expect(await call("server/discover")).toMatchObject({
      kind: "json",
      statusCode: 200,
      headers: { "cache-control": "no-store" },
      body: {
        result: {
          supportedVersions: [MCP_PROTOCOL_VERSION, "2025-06-18", "2025-03-26"],
          capabilities: { resources: { subscribe: true } },
          ttlMs: 0,
          cacheScope: "private",
        },
      },
    });
    expect(await call("tools/list", {}, { "mcp-session-id": "ignored" })).toMatchObject({
      body: { result: { tools: expect.any(Array), ttlMs: 0, cacheScope: "private" } },
    });
  });
  it("validates metadata, routing headers and origin before opening a subscription", async () => {
    for (const headers of [
      { "mcp-method": "tools/call" },
      { "mcp-protocol-version": "2025-06-18" },
    ])
      expect(await call("subscriptions/listen", {}, headers, true)).toMatchObject({
        statusCode: 400,
        body: { error: { code: -32020 } },
      });
    expect(
      await call("ping", { _meta: { [MCP_VERSION_META]: MCP_PROTOCOL_VERSION } }),
    ).toMatchObject({ statusCode: 400, body: { error: { code: -32602 } } });
    expect(await call("ping", {}, { origin: "https://evil.test" })).toMatchObject({
      statusCode: 403,
    });
    expect(await call("ping", {}, { "mcp-protocol-version": "2099-01-01" })).toMatchObject({
      statusCode: 400,
      body: {
        error: { code: -32022, data: { requested: "2099-01-01", supported: expect.any(Array) } },
      },
    });
  });
  it("decodes header names strictly and rejects mismatches", async () => {
    const uri = "helix://events/inbox";
    expect(
      await call(
        "resources/read",
        { uri },
        { "mcp-name": `=?base64?${Buffer.from(uri).toString("base64")}?=` },
      ),
    ).toMatchObject({ statusCode: 200, body: { result: { contents: [{ uri }] } } });
    for (const name of ["different", "=?base64?%%%%?=", "bad\nheader"])
      expect(await call("resources/read", { uri }, { "mcp-name": name })).toMatchObject({
        statusCode: 400,
        body: { error: { code: -32020 } },
      });
  });
  it("requires SSE for listen and returns 404 for legacy or unknown methods", async () => {
    expect(await call("subscriptions/listen", { notifications: {} })).toMatchObject({
      statusCode: 406,
    });
    expect(await call("subscriptions/listen", { notifications: {} }, {}, true)).toEqual({
      kind: "listen",
    });
    for (const method of ["initialize", "resources/subscribe", "not-a-method"])
      expect(await call(method)).toMatchObject({
        statusCode: 404,
        body: { error: { code: -32601 } },
      });
  });
});
