import type { Actor } from "@helix/sdk-types";
import fastify from "fastify";
import { expect, it } from "vitest";
import {
  InMemoryDomainsStore,
  readDomainsWithRecords,
  registerAdminDomainsRoutes,
} from "./domains.js";
import { registerAdminOverviewRoutes } from "./overview.js";

it("returns the same domain envelope through Overview and the Domains endpoint", async () => {
  const app = fastify();
  const actor: Actor = {
    id: "11111111-1111-4111-8111-111111111111",
    orgId: "22222222-2222-4222-8222-222222222222",
    type: "user",
    scopes: ["admin.console.read", "admin.console.write"],
  };
  const store = new InMemoryDomainsStore();
  await registerAdminDomainsRoutes(app, {
    store,
    actorFromRequest: () => actor,
    auditSink: { append: async () => ({ id: "audit", thisHash: "hash" }) },
  });
  registerAdminOverviewRoutes(app, {
    actorFromRequest: () => actor,
    readDomains: async (principal) => ({
      domains: await readDomainsWithRecords(store, principal.orgId),
    }),
    readPolicies: async () => ({ policies: [] }),
    readPlatformConfig: async () => ({}),
    readDirectory: async () => ({ users: [] }),
    readCoreApps: async () => ({}),
  });
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/domains",
          payload: { domain: "example.com" },
        })
      ).statusCode,
    ).toBe(201);
    const domains = await app.inject("/api/admin/domains");
    const overview = await app.inject("/api/admin/overview");
    expect(domains.statusCode).toBe(200);
    expect(overview.statusCode).toBe(200);
    expect(domains.json().domains).toHaveLength(1);
    expect(overview.json().signals.domains).toEqual({ status: "ok", data: domains.json() });
  } finally {
    await app.close();
  }
});
