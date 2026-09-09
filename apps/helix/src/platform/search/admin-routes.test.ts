import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/test-actor.js";
import { registerSearchAdminRoutes } from "./admin-routes.js";
import type { SearchReindexJobService } from "./durable.js";
import type { SearchReindexRequest, SearchReindexResult, SearchReindexType } from "./reindex.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";

describe("search admin routes", () => {
  it("reindexes search for admin config writers", async () => {
    const service = new FakeSearchReindexService();
    const app = fastify();
    await registerSearchAdminRoutes(app, { service, actorFromRequest });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/search/reindex",
      headers: adminHeaders(),
      payload: { all: true, types: ["mail", "drive"], batchSize: 25 },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "completed",
      engineId: "fake-search",
      totalDocuments: 2,
    });
    expect(service.calls).toEqual([{ types: ["mail", "drive"], batchSize: 25 }]);
  });

  it("passes org scoping and stale-prune options to the reindex service", async () => {
    const service = new FakeSearchReindexService();
    const app = fastify();
    await registerSearchAdminRoutes(app, { service, actorFromRequest });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/search/reindex",
      headers: adminHeaders("admin.search.write"),
      payload: {
        all: true,
        orgId,
        pruneStale: false,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(service.calls).toEqual([{ orgId, pruneStale: false }]);
  });

  it("requires an admin search or config scope", async () => {
    const service = new FakeSearchReindexService();
    const app = fastify();
    await registerSearchAdminRoutes(app, { service, actorFromRequest });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/search/reindex",
      headers: adminHeaders("admin.audit"),
      payload: { all: true },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Admin search reindex permission denied.",
      requiredScope: "admin.config.write",
    });
    expect(service.calls).toEqual([]);
  });

  it("rejects invalid type filters before reindexing", async () => {
    const service = new FakeSearchReindexService();
    const app = fastify();
    await registerSearchAdminRoutes(app, { service, actorFromRequest });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/search/reindex",
      headers: adminHeaders("admin.search.write"),
      payload: { types: ["mail", "not-real"] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Invalid search reindex request." });
    expect(service.calls).toEqual([]);
  });

  it("creates, reads, and cancels resumable full shadow jobs", async () => {
    const service = new FakeSearchReindexService();
    const calls: string[] = [];
    const job = {
      id: "33333333-3333-4333-8333-333333333333",
      orgId,
      requestedByActorId: actorId,
      types: ["mail", "chat", "docs", "drive", "calendar"] as const,
      batchSize: 50,
      shadowIndexUid: "shadow",
      status: "queued" as const,
      phase: "backfill" as const,
      sourceIndex: 0,
      startMutationId: 4n,
      replayMutationId: 4n,
      totalDocuments: 0n,
      attemptCount: 0,
    };
    const jobs: SearchReindexJobService = {
      create: async (_actor, input) => {
        calls.push(`create:${String(input?.batchSize)}`);
        return job;
      },
      get: async (id) => {
        calls.push(`get:${id}`);
        return job;
      },
      cancel: async (id) => {
        calls.push(`cancel:${id}`);
        return true;
      },
    };
    const app = fastify();
    await registerSearchAdminRoutes(app, { service, jobs, actorFromRequest });

    const created = await app.inject({
      method: "POST",
      url: "/api/admin/search/reindex/jobs",
      headers: adminHeaders(),
      payload: { all: true, batchSize: 50 },
    });
    const read = await app.inject({
      method: "GET",
      url: `/api/admin/search/reindex/jobs/${job.id}`,
      headers: adminHeaders(),
    });
    const cancelled = await app.inject({
      method: "POST",
      url: `/api/admin/search/reindex/jobs/${job.id}/cancel`,
      headers: adminHeaders(),
    });

    expect(created.json()).toMatchObject({ id: job.id, startMutationId: "4" });
    expect(read.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ status: "cancelled" });
    expect(calls).toEqual([`create:50`, `get:${job.id}`, `cancel:${job.id}`]);
  });
});

class FakeSearchReindexService {
  readonly calls: SearchReindexRequest[] = [];

  async reindex(input: SearchReindexRequest): Promise<SearchReindexResult> {
    this.calls.push(input);
    const types = input.types ?? ["mail", "chat", "docs", "drive", "calendar"];
    return {
      status: "completed",
      engineId: "fake-search",
      types,
      totalDocuments: 2,
      deletedDocuments: 0,
      counts: counts(types),
      batchSize: input.batchSize ?? 100,
    };
  }
}

function counts(types: readonly SearchReindexType[]): Record<SearchReindexType, number> {
  return {
    mail: types.includes("mail") ? 1 : 0,
    chat: types.includes("chat") ? 1 : 0,
    docs: types.includes("docs") ? 1 : 0,
    drive: types.includes("drive") ? 1 : 0,
    calendar: types.includes("calendar") ? 1 : 0,
  };
}

function adminHeaders(scopes = "admin.config.write"): Record<string, string> {
  return {
    "x-helix-actor-id": actorId,
    "x-helix-org-id": orgId,
    "x-helix-scopes": scopes,
  };
}
