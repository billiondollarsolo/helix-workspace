import type { Actor } from "@helix/sdk-types";
import swagger from "@fastify/swagger";
import fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { buildOpenApiDocument, sessionCookieSecurityScheme } from "../../api/openapi.js";
import { registerPasswordVaultRoutes } from "./routes.js";

const actor: Actor = {
  id: "b7300000-0000-4000-8000-000000000001",
  orgId: "b7300000-0000-4000-8000-000000000002",
  type: "user",
  scopes: [],
};
const bytes = Buffer.alloc(64);
bytes.writeUInt32LE(0x9aa2d903, 0);
bytes.writeUInt32LE(0xb54bfb67, 4);
bytes.writeUInt16LE(4, 10);
async function fixture(principal: Actor | null = actor, enabled = true) {
  const app = fastify();
  await app.register(swagger, {
    openapi: {
      info: { title: "Vault regression", version: "1" },
      components: { securitySchemes: { sessionCookie: sessionCookieSecurityScheme } },
    },
  });
  const store = {
    get: vi.fn(async () => ({ vault: null, previous: null })),
    put: vi.fn(async (): Promise<number | null> => 1),
  };
  const audit = { append: vi.fn(async () => ({ id: "audit", thisHash: "hash" })) };
  registerPasswordVaultRoutes(app, {
    store,
    sessionActorResolver: { resolve: async () => principal },
    enabled: async () => enabled,
    audit,
  });
  return { app, store, audit };
}
describe("personal vault routes", () => {
  it("generates OpenAPI with the human-only session requirement", async () => {
    const { app } = await fixture();
    try {
      await app.ready();
      const document = buildOpenApiDocument(app.swagger(), []);
      expect(document).toMatchObject({
        paths: {
          "/api/passwords/vault": {
            get: { security: [{ sessionCookie: [] }] },
            put: { security: [{ sessionCookie: [] }] },
          },
        },
        components: { securitySchemes: { sessionCookie: sessionCookieSecurityScheme } },
      });
    } finally {
      await app.close();
    }
  });
  it("refuses an account switch before reading or replacing another vault", async () => {
    const { app, store } = await fixture();
    try {
      for (const method of ["GET", "PUT"] as const) {
        const response = await app.inject({
          method,
          url: "/api/passwords/vault",
          headers: { "x-helix-vault-owner": "b7300000-0000-4000-8000-000000000099" },
          ...(method === "PUT"
            ? { payload: { expectedVersion: 0, ciphertext: bytes.toString("base64") } }
            : {}),
        });
        expect(response.statusCode).toBe(403);
      }
      expect((await app.inject("/api/passwords/vault")).statusCode).toBe(403);
      expect(store.get).not.toHaveBeenCalled();
      expect(store.put).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it("binds all storage to the human session and audits only revision metadata", async () => {
    const { app, store, audit } = await fixture();
    try {
      const read = await app.inject({
        method: "GET",
        url: "/api/passwords/vault?actorId=someone-else",
        headers: { "x-helix-vault-owner": actor.id },
      });
      expect(read.statusCode).toBe(200);
      expect(read.headers["cache-control"]).toBe("no-store");
      expect(store.get).toHaveBeenCalledWith(actor.orgId, actor.id);
      const saved = await app.inject({
        headers: { "x-helix-vault-owner": actor.id },
        method: "PUT",
        url: "/api/passwords/vault",
        payload: { expectedVersion: 0, ciphertext: bytes.toString("base64") },
      });
      expect(saved.statusCode).toBe(200);
      expect(store.put).toHaveBeenCalledWith(actor.orgId, actor.id, 0, bytes);
      expect(JSON.stringify(audit.append.mock.calls)).not.toContain(bytes.toString("base64"));
      store.put.mockResolvedValueOnce(null);
      expect(
        (
          await app.inject({
            headers: { "x-helix-vault-owner": actor.id },
            method: "PUT",
            url: "/api/passwords/vault",
            payload: { expectedVersion: 1, ciphertext: bytes.toString("base64") },
          })
        ).statusCode,
      ).toBe(409);
    } finally {
      await app.close();
    }
  });
  it("denies anonymous, agent/service, and disabled-feature access before touching storage", async () => {
    for (const [principal, enabled, status] of [
      [null, true, 401],
      [{ ...actor, type: "agent" }, true, 403],
      [{ ...actor, type: "service_account" }, true, 403],
      [actor, false, 403],
    ] as const) {
      const { app, store } = await fixture(principal, enabled);
      try {
        expect(
          (
            await app.inject({
              method: "GET",
              url: "/api/passwords/vault",
              headers: { "x-helix-vault-owner": actor.id },
            })
          ).statusCode,
        ).toBe(status);
        expect(store.get).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    }
  });
  it("refuses plaintext, extra identity fields, noncanonical base64 and unsupported files", async () => {
    const { app, store } = await fixture();
    try {
      for (const payload of [
        { expectedVersion: 0, ciphertext: bytes.toString("base64"), actorId: "foreign" },
        {
          expectedVersion: 0,
          ciphertext: Buffer.from("plain master password".repeat(10)).toString("base64"),
        },
        { expectedVersion: -1, ciphertext: bytes.toString("base64") },
        { expectedVersion: 0, ciphertext: "not base64" },
      ])
        expect(
          (
            await app.inject({
              method: "PUT",
              url: "/api/passwords/vault",
              payload,
              headers: { "x-helix-vault-owner": actor.id },
            })
          ).statusCode,
        ).toBe(400);
      expect(store.put).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
