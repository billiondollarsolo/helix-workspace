import type { Actor, HelixConfig } from "@helix/sdk-types";
import fastify from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import {
  registerAiRetrievalRoutes,
  type RegisterAiRetrievalRoutesOptions,
} from "./ai-retrieval-routes.js";
import type { SearchReindexJob } from "../search/durable.js";

const actor: Actor = {
  id: "00000000-0000-4000-8000-000000000001",
  orgId: "00000000-0000-4000-8000-000000000100",
  type: "user",
  scopes: ["admin.config.write"],
};
const check = {
  ok: true,
  message: "Connected",
  latencyMs: 4,
  checkedAt: "2026-09-10T12:00:00.000Z",
};
const status = {
  enabled: true,
  backend: "pgvector",
  embeddingModel: "test",
  dimensions: 384,
  collection: "search",
};
const job: SearchReindexJob = {
  id: "job-one",
  orgId: actor.orgId,
  requestedByActorId: actor.id,
  types: ["drive"],
  batchSize: 100,
  shadowIndexUid: "shadow",
  status: "queued",
  phase: "backfill",
  sourceIndex: 0,
  startMutationId: 1n,
  replayMutationId: 1n,
  totalDocuments: 0n,
  attemptCount: 0,
};
const apps: ReturnType<typeof fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function setup(
  scopes: readonly string[] = actor.scopes ?? [],
  overrides: Partial<RegisterAiRetrievalRoutesOptions> = {},
) {
  const vectorTest = vi.fn(async () => check);
  const webTest = vi.fn(async () => check);
  const create = vi.fn(async () => job);
  const options: RegisterAiRetrievalRoutesOptions = {
    actorFromRequest: () => ({ ...actor, scopes }),
    config: () => ({
      security: { tier: "personal" },
      ai: { webSearch: { enabled: true, provider: "brave", apiKey: "private-key" } },
    }),
    vector: { test: vectorTest, status: () => status },
    web: { test: webTest, enabled: () => true },
    jobs: { create },
    ...overrides,
  };
  const app = fastify();
  apps.push(app);
  await registerAiRetrievalRoutes(app, options);
  return { app, vectorTest, webTest, create };
}

it("tests saved settings and scopes vector probing to the authenticated organization", async () => {
  const { app, vectorTest, webTest } = await setup();
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/admin/ai-retrieval/test",
        payload: { target: "vector" },
      })
    ).json(),
  ).toEqual(check);
  expect(vectorTest).toHaveBeenCalledWith(actor.orgId);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/admin/ai-retrieval/test",
        payload: { target: "web" },
      })
    ).json(),
  ).toEqual(check);
  expect(webTest).toHaveBeenCalledWith({ enabled: true, provider: "brave", apiKey: "private-key" });
  expect((await app.inject({ url: "/api/admin/ai-retrieval/status" })).json()).toEqual({
    vector: status,
    web: { enabled: true },
  });
  const forged = await app.inject({
    method: "POST",
    url: "/api/admin/ai-retrieval/test",
    payload: { target: "web", apiKey: "injected", baseUrl: "http://localhost" },
  });
  expect(forged.statusCode).toBe(400);
  expect(webTest).toHaveBeenCalledTimes(1);
});

it.each<HelixConfig>([
  { security: { tier: "personal" }, ai: { enabled: false } },
  { security: { tier: "sovereign", overrides: { localAiOnly: false } } },
  { security: { tier: "business", overrides: { localAiOnly: true } } },
  {
    security: { tier: "personal" },
    ai: { privacy: { blockExternalForClassifications: ["standard"] } },
  },
])("blocks web connection tests and readiness under AI/privacy policy: %j", async (config) => {
  const { app, webTest } = await setup(undefined, { config: () => config });
  expect((await app.inject({ url: "/api/admin/ai-retrieval/status" })).json()).toMatchObject({
    web: { enabled: false },
  });
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/admin/ai-retrieval/test",
        payload: { target: "web" },
      })
    ).statusCode,
  ).toBe(403);
  expect(webTest).not.toHaveBeenCalled();
});

it("tests disabled saved web drafts without enabling search or changing settings", async () => {
  const config: HelixConfig = {
    security: { tier: "personal" },
    ai: { webSearch: { enabled: false, provider: "searxng", baseUrl: "http://localhost:8888" } },
  };
  const { app, webTest } = await setup(undefined, { config: () => config });
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/admin/ai-retrieval/test",
        payload: { target: "web" },
      })
    ).statusCode,
  ).toBe(200);
  expect(webTest).toHaveBeenCalledWith(config.ai?.webSearch);
  expect(config.ai?.webSearch?.enabled).toBe(false);
});

it("refuses to enqueue a rebuild when retrieval is disabled", async () => {
  const { app, create } = await setup(undefined, {
    vector: { test: async () => check, status: () => ({ ...status, enabled: false }) },
  });
  expect(
    (await app.inject({ method: "POST", url: "/api/admin/ai-retrieval/reindex", payload: {} }))
      .statusCode,
  ).toBe(409);
  expect(create).not.toHaveBeenCalled();
});

it("read-only config access cannot spend connection tests or enqueue rebuilds", async () => {
  const { app, vectorTest, create } = await setup(["admin.config.read"]);
  expect((await app.inject({ url: "/api/admin/ai-retrieval/status" })).statusCode).toBe(200);
  for (const suffix of ["test", "reindex"])
    expect(
      (await app.inject({ method: "POST", url: `/api/admin/ai-retrieval/${suffix}`, payload: {} }))
        .statusCode,
    ).toBe(403);
  expect(vectorTest).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
});

it("denies ordinary members all admin retrieval routes", async () => {
  const { app } = await setup(["assistant.read"]);
  expect((await app.inject({ url: "/api/admin/ai-retrieval/status" })).statusCode).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/admin/ai-retrieval/test",
        payload: { target: "web" },
      })
    ).statusCode,
  ).toBe(403);
});

it("enqueues the existing durable job without accepting a foreign org and serializes bigint progress", async () => {
  const { app, create } = await setup();
  const result = await app.inject({
    method: "POST",
    url: "/api/admin/ai-retrieval/reindex",
    payload: {},
  });
  expect(result.statusCode).toBe(202);
  expect(result.json()).toMatchObject({ id: job.id, totalDocuments: "0", startMutationId: "1" });
  expect(create).toHaveBeenCalledWith(actor, {});
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/admin/ai-retrieval/reindex",
        payload: { orgId: "foreign" },
      })
    ).statusCode,
  ).toBe(400);
  expect(create).toHaveBeenCalledTimes(1);
});

it("returns safe connection diagnostics without provider exceptions or credentials", async () => {
  const { app, webTest } = await setup();
  webTest.mockRejectedValueOnce(new Error("private-key https://user:password@provider/"));
  const response = await app.inject({
    method: "POST",
    url: "/api/admin/ai-retrieval/test",
    payload: { target: "web" },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ ok: false });
  expect(response.body).not.toMatch(/private-key|password/);
});
