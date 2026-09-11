import { SYSTEM_TENANT_CONFIG, type Actor } from "@helix/sdk-types";
import fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { InMemoryTenantApiRpsLimiter } from "../platform/limits/index.js";
import { installTenantContextHook } from "../platform/tenancy/index.js";
import {
  cacheSessionActorResolver,
  installTenantApiRpsLimitHook,
  installUntrustedIdentityHeaderGuard,
} from "./request-principal.js";

const orgId = "f1910000-0000-4000-8000-000000000010";
const servers: FastifyInstance[] = [];
const cookies = {
  alice: "helix.session_token=verified-alice",
  bob: "helix.session_token=verified-bob",
};

afterEach(async () => {
  for (const app of servers.splice(0)) await app.close();
  vi.restoreAllMocks();
});

function setup() {
  const app = fastify();
  servers.push(app);
  installUntrustedIdentityHeaderGuard(app);
  installTenantContextHook(app, {
    async resolveTenantContext() {
      return {
        orgId,
        orgSlug: "test",
        orgTier: "business",
        orgRegion: "us-east-1",
        effectiveConfig: {
          ...SYSTEM_TENANT_CONFIG,
          quotas: { ...SYSTEM_TENANT_CONFIG.quotas, api_rps_limit: 5 },
        },
        org: {
          id: orgId,
          slug: "test",
          displayName: "Test",
          status: "active",
          tier: "business",
          planId: "business",
          region: "us-east-1",
          byoConfig: {},
          featureFlags: {},
          quotas: { api_rps_limit: 5 },
          branding: {},
          suspendedAt: null,
          softDeletedAt: null,
          hardDeletedAt: null,
        },
      };
    },
  });
  // Model the session verifier contract: unknown/expired cookies resolve to null.
  const verify = vi.fn(async (request: FastifyRequest): Promise<Actor | null> => {
    const id = Object.entries(cookies).find(([, cookie]) => cookie === request.headers.cookie)?.[0];
    return id ? { id, orgId, type: "user", scopes: [] } : null;
  });
  const sessionResolver = cacheSessionActorResolver({ resolve: verify });
  installTenantApiRpsLimitHook(app, {
    limiter: new InMemoryTenantApiRpsLimiter(),
    sessionResolver,
  });
  for (const path of [
    "/api/data",
    "/api/admin/config",
    "/v1/api/admin/config",
    "/trpc/admin.overview",
  ])
    app.get(path, async (request) => ({
      actor: (await sessionResolver.resolve(request))?.id ?? null,
    }));
  return { app, verify, sessionResolver };
}

it("allows a full verified human page burst and resolves the session only once per request", async () => {
  const { app, verify } = setup();
  const responses = await Promise.all(
    Array.from({ length: 20 }, () =>
      app.inject({ method: "GET", url: "/api/data", headers: { cookie: cookies.alice } }),
    ),
  );
  expect(responses.every((response) => response.statusCode === 200)).toBe(true);
  expect(responses[0]?.headers["x-helix-rate-limit-policy"]).toBe("browser");
  expect(responses[0]?.headers["x-helix-rate-limit-window-ms"]).toBe("10000");
  expect(verify).toHaveBeenCalledTimes(20);
});

it("caps abusive browser bursts without consuming another human or admin recovery allowance", async () => {
  const { app } = setup();
  const burst = await Promise.all(
    Array.from({ length: 120 }, () =>
      app.inject({ method: "GET", url: "/api/data", headers: { cookie: cookies.alice } }),
    ),
  );
  expect(burst.every((response) => response.statusCode === 200)).toBe(true);
  const denied = await app.inject({
    method: "GET",
    url: "/api/data",
    headers: { cookie: cookies.alice },
  });
  expect(denied.statusCode).toBe(429);
  expect(Number(denied.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  expect(Number(denied.headers["retry-after"])).toBeLessThanOrEqual(10);
  expect(denied.json()).toMatchObject({
    error: {
      code: "rate_limit.browser.exceeded",
      details: { limit: 120, windowMs: 10_000, remaining: 0 },
    },
  });
  expect(
    (await app.inject({ method: "GET", url: "/api/data", headers: { cookie: cookies.bob } }))
      .statusCode,
  ).toBe(200);
  for (const url of ["/api/admin/config", "/v1/api/admin/config", "/trpc/admin.overview"]) {
    const response = await app.inject({ method: "GET", url, headers: { cookie: cookies.alice } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["x-helix-rate-limit-policy"]).toBe("browser-admin");
  }
  expect((await app.inject({ method: "GET", url: "/api/data" })).statusCode).toBe(200);
});

it.each([
  {},
  { cookie: "helix.session_token=forged" },
  { cookie: "helix.session_token=expired" },
  { cookie: cookies.alice, authorization: "Bearer api-token" },
  { cookie: cookies.alice, "x-api-key": "api-key" },
])(
  "retains the tenant API quota for unverified or credential-bearing requests: %j",
  async (headers) => {
    const { app } = setup();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => app.inject({ method: "GET", url: "/api/data", headers })),
    );
    expect(responses.filter((response) => response.statusCode === 200)).toHaveLength(5);
    const denied = responses.find((response) => response.statusCode === 429);
    expect(denied?.headers["retry-after"]).toBe("1");
    expect(denied?.json()).toMatchObject({
      error: { code: "quota.api_rps.exceeded", details: { limit: 5, windowMs: 1_000 } },
    });
  },
);

it("rejects forged identity headers before applying any browser allowance", async () => {
  const { app, verify } = setup();
  const response = await app.inject({
    method: "GET",
    url: "/api/data",
    headers: { cookie: cookies.alice, "x-helix-actor-id": "bob" },
  });
  expect(response.statusCode).toBe(401);
  expect(verify).not.toHaveBeenCalled();
});
