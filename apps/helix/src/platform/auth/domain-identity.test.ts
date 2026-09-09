import fastify from "fastify";
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  PostgresDomainIdentityStore,
  registerDomainIdentityDiscoveryRoute,
} from "./domain-identity.js";

function recordingSql(rows: readonly unknown[]) {
  const calls: unknown[][] = [];
  const tag = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return Promise.resolve(rows);
  };
  return { sql: tag as unknown as postgres.Sql, calls };
}

describe("domain identity discovery", () => {
  it("returns only the managed login routing projection", async () => {
    const recording = recordingSql([
      { org_slug: "acme", canonical_email: "alex@acme.example", protocol: "oidc" },
    ]);
    const store = new PostgresDomainIdentityStore(recording.sql);
    const app = fastify();
    registerDomainIdentityDiscoveryRoute(app, store);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/domain-discovery",
      payload: { email: "Alex@alias.example" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      managed: true,
      orgSlug: "acme",
      canonicalEmail: "alex@acme.example",
      protocol: "oidc",
    });
    expect(recording.calls[0]).toContain("alex@alias.example");
    await app.close();
  });

  it("does not disclose an organization for unknown domains", async () => {
    const store = { discover: vi.fn().mockResolvedValue(null) };
    const app = fastify();
    registerDomainIdentityDiscoveryRoute(app, store);
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/domain-discovery",
      payload: { email: "guest@outside.example" },
    });
    expect(response.json()).toEqual({
      managed: false,
      canonicalEmail: "guest@outside.example",
      orgSlug: null,
      protocol: null,
    });
    await app.close();
  });
});
