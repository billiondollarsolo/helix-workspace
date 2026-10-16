import { describe, expect, it, vi } from "vitest";
import fastify from "fastify";
import type postgres from "postgres";
import { InMemoryIdempotencyStore } from "./idempotency.js";
import { createPlatformMetrics } from "./metrics.js";
import { callMcpTool } from "./mcp-tools.js";
import { InMemoryOAuthClientStore } from "../platform/auth/oauth.js";
import { createToolRegistry } from "../platform/tool-registry.js";
import { registerToolRestRoutes } from "../bootstrap/tool-routes.js";
import { installTenantPostgresContextHook } from "../platform/tenancy/middleware.js";
import type { TenantContext } from "../platform/tenancy/context.js";
const orgId = "22222222-2222-4222-8222-222222222222";
const actor = {
  id: "11111111-1111-4111-8111-111111111111",
  orgId,
  type: "agent" as const,
  scopes: ["platform.read"],
};
const schema = { parse: (input: unknown) => input, toJsonSchema: () => ({ type: "object" }) };
function registry(handler = async () => ({ created: true })) {
  const tools = createToolRegistry();
  tools.register({
    id: "review.write",
    description: "Test write",
    permission: "platform.read",
    sideEffects: "write",
    inputSchema: schema,
    outputSchema: schema,
    handler,
  });
  return tools;
}
const request = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "review.write", arguments: {}, _meta: { idempotencyKey: "retry-safe-key" } },
};
describe("retry safety", () => {
  it("does not cache temporary MCP failures", async () => {
    const tools = registry();
    const invoke = vi
      .spyOn(tools, "invoke")
      .mockResolvedValueOnce({ ok: false, statusCode: 429, error: "Try again" })
      .mockResolvedValue({ ok: true, output: { created: true } });
    const context = {
      tools,
      principal: { actor },
      idempotencyStore: new InMemoryIdempotencyStore(),
    };
    expect(await callMcpTool(request, context)).toMatchObject({ result: { isError: true } });
    expect(await callMcpTool(request, context)).toMatchObject({
      result: { structuredContent: { created: true } },
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it("denies cached MCP results after credential permissions are removed", async () => {
    const tools = registry();
    const invoke = vi
      .spyOn(tools, "invoke")
      .mockResolvedValue({ ok: true, output: { created: true } });
    const context = {
      tools,
      principal: { actor },
      idempotencyStore: new InMemoryIdempotencyStore(),
    };
    expect(await callMcpTool(request, context)).toMatchObject({
      result: { structuredContent: { created: true } },
    });
    expect(
      await callMcpTool(request, { ...context, principal: { actor: { ...actor, scopes: [] } } }),
    ).toMatchObject({ result: { isError: true, structuredContent: { code: "forbidden" } } });
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("keeps an uncertain MCP commit claimed without reporting success", async () => {
    const tools = registry();
    const invoke = vi
      .spyOn(tools, "invoke")
      .mockResolvedValue({ ok: true, output: { created: true } });
    const context = {
      tools,
      principal: { actor },
      idempotencyStore: new InMemoryIdempotencyStore(),
      finishTransaction: async () => {
        throw new Error("commit failed");
      },
    };
    await expect(callMcpTool(request, context)).rejects.toThrow("commit failed");
    expect(await callMcpTool(request, context)).toMatchObject({
      result: { isError: true, structuredContent: { code: "conflict" } },
    });
    expect(invoke).toHaveBeenCalledOnce();
  });
  it("does not publish REST success before the tenant transaction commits", async () => {
    let failCommit = true,
      durableWrites = 0,
      stagedWrites = 0,
      calls = 0;
    const query = Object.assign(async () => [], {
      begin: async (callback: (sql: unknown) => Promise<unknown>) => {
        stagedWrites = 0;
        const result = await callback(query);
        if (failCommit) {
          failCommit = false;
          stagedWrites = 0;
          throw new Error("commit failed");
        }
        durableWrites += stagedWrites;
        return result;
      },
    });
    const app = fastify();
    app.decorateRequest("tenant", null);
    app.addHook("onRequest", async (request) => {
      request.tenant = { orgId } as TenantContext;
    });
    installTenantPostgresContextHook(app, query as unknown as postgres.Sql);
    const tokenStore = new InMemoryOAuthClientStore();
    await tokenStore.saveToken({
      token: "test-retry-token",
      clientId: "test",
      actorId: actor.id,
      orgId,
      actorType: "user",
      scopes: ["platform.read"],
      issuedAt: new Date(),
      expiresAt: new Date("2099-01-01"),
    });
    const tools = registry(async () => {
      calls++;
      stagedWrites++;
      return { created: true };
    });
    registerToolRestRoutes(
      app,
      {
        tools,
        tokenStore,
        metrics: createPlatformMetrics(),
        idempotencyStore: new InMemoryIdempotencyStore(),
      },
      ["POST"],
    );
    const post = () =>
      app.inject({
        method: "POST",
        url: "/api/tools/review.write",
        headers: {
          authorization: "Bearer test-retry-token",
          "idempotency-key": "transaction-retry",
        },
        payload: {},
      });
    try {
      expect((await post()).statusCode).toBe(500);
      expect((await post()).statusCode).toBe(409);
      expect(durableWrites).toBe(0);
      expect(calls).toBe(1);
    } finally {
      await app.close();
    }
  });
});
