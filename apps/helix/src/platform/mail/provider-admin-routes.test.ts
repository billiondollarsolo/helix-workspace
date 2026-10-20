import fastify from "fastify";
import { expect, it, vi } from "vitest";
import type { Actor } from "@helix/sdk-types";
import { InMemoryOutboundProviderStore } from "./admin-store.js";
import { registerMailProviderAdminRoutes } from "./provider-admin-routes.js";

it("keeps credentials write-only, tenant-scoped and audited; checks without sending", async () => {
  const orgId = "11111111-1111-4111-8111-111111111111";
  let actor: Actor = {
    id: "admin",
    orgId,
    type: "user",
    displayName: "Admin",
    scopes: ["mail.admin"],
  };
  const providers = new InMemoryOutboundProviderStore();
  const provider = await providers.createProvider({
    orgId,
    name: "mail",
    kind: "smtp",
    enabled: true,
    isDefault: false,
    config: { host: "smtp.example.com" },
    secretRef: null,
    webhookSecretRef: null,
    createdBy: actor.id,
  });
  const write = vi.fn(async () => true),
    append = vi.fn(async () => ({ id: "audit", thisHash: "hash" })),
    check = vi.fn(async () => undefined);
  const app = fastify();
  await registerMailProviderAdminRoutes(app, {
    providers,
    credentials: {
      read: async () => undefined,
      write,
      status: async () => ({ sending: false, feedback: false }),
    },
    secrets: {
      resolveSecret: async () => undefined,
      resolveProviderSecret: async () => "private-credential",
    },
    actorFromRequest: () => actor,
    auditSink: { append },
    check,
  });
  const url = `/api/admin/mail/providers/${provider.id}`;
  const saved = await app.inject({
    method: "POST",
    url: `${url}/credentials`,
    payload: { purpose: "sending", value: "private-credential" },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.body).not.toContain("private-credential");
  expect(JSON.stringify(append.mock.calls)).not.toContain("private-credential");
  expect(write).toHaveBeenCalledWith(orgId, provider.id, "sending", "private-credential");
  expect((await app.inject({ method: "POST", url: `${url}/check` })).statusCode).toBe(200);
  expect(check).toHaveBeenCalledWith(provider, "private-credential");
  check.mockRejectedValueOnce(new Error("leaked private-credential"));
  const failed = await app.inject({ method: "POST", url: `${url}/check` });
  expect(failed.statusCode).toBe(422);
  expect(failed.body).not.toContain("private-credential");
  actor = { ...actor, orgId: "22222222-2222-4222-8222-222222222222" };
  expect(
    (
      await app.inject({
        method: "POST",
        url: `${url}/credentials`,
        payload: { purpose: "sending", value: "another" },
      })
    ).statusCode,
  ).toBe(404);
  actor = { ...actor, orgId, scopes: ["admin.console.read"] };
  expect((await app.inject({ method: "POST", url: `${url}/check` })).statusCode).toBe(403);
  expect(write).toHaveBeenCalledTimes(1);
  await app.close();
});
