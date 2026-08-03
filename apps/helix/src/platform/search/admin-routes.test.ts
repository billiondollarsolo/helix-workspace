import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/actor.js";
import { registerSearchAdminRoutes } from "./admin-routes.js";
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
    expect(service.calls).toEqual([{ orgId, types: ["mail", "drive"], batchSize: 25 }]);
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

  it("defaults reindex org scope to the actor org when body omits orgId", async () => {
    const service = new FakeSearchReindexService();
    const app = fastify();
    await registerSearchAdminRoutes(app, { service, actorFromRequest });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/search/reindex",
      headers: adminHeaders("admin.search.write"),
      payload: { all: true, types: ["mail"] },
    });

    expect(response.statusCode).toBe(200);
    expect(service.calls).toEqual([{ orgId, types: ["mail"] }]);
  });

  it("denies cross-organization reindex requests before invoking the service", async () => {
    const foreignOrgId = "33333333-3333-4333-8333-333333333333";
    const service = new FakeSearchReindexService();
    const app = fastify();
    await registerSearchAdminRoutes(app, { service, actorFromRequest });

    const response = await app.inject({
      method: "POST",
      url: "/api/admin/search/reindex",
      headers: adminHeaders("admin.search.write"),
      payload: { all: true, orgId: foreignOrgId, types: ["mail"] },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Cross-organization search reindex denied.",
      code: "cross_org_reindex_denied",
    });
    expect(service.calls).toEqual([]);
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
