import Fastify from "fastify";
import { describe, it, expect, vi } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { registerAgentRuntimeRoutes } from "./admin-routes.js";
import type { AgentRuntimeStore } from "./store.js";
const id = "00000000-0000-4000-8000-000000000001";
describe("Agent hosting administration", () => {
  it.each(["agent", "service_account", "user"] as const)(
    "rejects an unauthorized %s without reading or changing hosting",
    async (type) => {
      const server = Fastify(),
        store = { list: vi.fn(), configure: vi.fn() } as unknown as AgentRuntimeStore;
      registerAgentRuntimeRoutes(server, {
        store,
        actorFromRequest: () => ({
          id,
          orgId: id,
          type,
          scopes: type === "user" ? [] : ["admin.agents"],
        }),
        auditSink: { append: vi.fn() },
        models: async () => ({ models: [] }),
      });
      try {
        expect(
          (await server.inject({ method: "GET", url: "/api/admin/agent-runtimes" })).statusCode,
        ).toBe(403);
        expect(
          (
            await server.inject({
              method: "PUT",
              url: "/api/admin/agent-runtimes/" + id,
              payload: { config: { mode: "external" } },
            })
          ).statusCode,
        ).toBe(403);
        expect(store.configure).not.toHaveBeenCalled();
      } finally {
        await server.close();
      }
    },
  );
  it("rejects enabling an unavailable model before a configuration write", async () => {
    const server = Fastify(),
      store = { configure: vi.fn() } as unknown as AgentRuntimeStore;
    const actor: Actor = { id, orgId: id, type: "user", scopes: ["admin.agents"] };
    registerAgentRuntimeRoutes(server, {
      store,
      actorFromRequest: () => actor,
      auditSink: { append: vi.fn() },
      models: async () => ({ models: [] }),
    });
    try {
      expect(
        (
          await server.inject({
            method: "PUT",
            url: "/api/admin/agent-runtimes/" + id,
            payload: {
              config: { mode: "helix", enabled: true, credentialId: id, modelId: "missing" },
            },
          })
        ).statusCode,
      ).toBe(400);
      expect(store.configure).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
