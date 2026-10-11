import fastify from "fastify";
import { describe, expect, it } from "vitest";
import { actorFromRequest } from "../../api/test-actor.js";
import { registerSearchAdminRoutes } from "./admin-routes.js";
import type { SearchReindexJob, SearchReindexJobService } from "./durable.js";
import type { SearchReindexRequest } from "./reindex.js";

const actorId = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
const jobId = "33333333-3333-4333-8333-333333333333";

function reindexJob(overrides: Partial<SearchReindexJob> = {}): SearchReindexJob {
  return {
    id: jobId,
    orgId,
    requestedByActorId: actorId,
    mode: "in_place",
    targetOrgId: orgId,
    types: ["mail", "chat", "drive", "calendar"],
    batchSize: 100,
    shadowIndexUid: null,
    pruneStale: true,
    status: "queued",
    phase: "backfill",
    sourceIndex: 0,
    startMutationId: 4n,
    replayMutationId: 4n,
    totalDocuments: 0n,
    deletedDocuments: 0n,
    counts: {},
    attemptCount: 0,
    leaseToken: "lease-secret",
    createdAt: new Date("2026-10-11T12:00:00.000Z"),
    updatedAt: new Date("2026-10-11T12:00:00.000Z"),
    ...overrides,
  };
}

class FakeJobs implements SearchReindexJobService {
  readonly calls: string[] = [];
  readonly inPlace: SearchReindexRequest[] = [];
  job = reindexJob();

  async create(_actor: unknown, input?: SearchReindexRequest): Promise<SearchReindexJob> {
    this.calls.push(`create:${String(input?.batchSize)}`);
    return { ...this.job, mode: "shadow", shadowIndexUid: "shadow" };
  }
  async createInPlace(_actor: unknown, input?: SearchReindexRequest): Promise<SearchReindexJob> {
    this.inPlace.push(input ?? {});
    return this.job;
  }
  async get(id: string): Promise<SearchReindexJob | undefined> {
    this.calls.push(`get:${id}`);
    return id === this.job.id ? this.job : undefined;
  }
  async cancel(id: string): Promise<boolean> {
    this.calls.push(`cancel:${id}`);
    return true;
  }
}

async function app(jobs: SearchReindexJobService) {
  const server = fastify();
  await registerSearchAdminRoutes(server, { jobs, actorFromRequest });
  return server;
}

describe("search admin routes", () => {
  it("queues a reindex of the actor's organization and answers 202 with the job", async () => {
    const jobs = new FakeJobs();
    const response = await (
      await app(jobs)
    ).inject({
      method: "POST",
      url: "/api/admin/search/reindex",
      headers: adminHeaders(),
      payload: { all: true, types: ["mail", "drive"], batchSize: 25 },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      id: jobId,
      mode: "in_place",
      status: "queued",
      totalDocuments: "0",
      deletedDocuments: "0",
    });
    expect(response.json()).not.toHaveProperty("leaseToken");
    expect(jobs.inPlace).toEqual([{ types: ["mail", "drive"], batchSize: 25 }]);
  });

  it("passes the stale-prune option and accepts the actor's own org", async () => {
    const jobs = new FakeJobs();
    const response = await (
      await app(jobs)
    ).inject({
      method: "POST",
      url: "/api/admin/search/reindex",
      headers: adminHeaders("admin.search.write"),
      payload: { all: true, orgId, pruneStale: false },
    });

    expect(response.statusCode).toBe(202);
    expect(jobs.inPlace).toEqual([{ pruneStale: false }]);
  });

  it("reports progress through the job status endpoint", async () => {
    const jobs = new FakeJobs();
    jobs.job = reindexJob({
      status: "processing",
      sourceIndex: 2,
      totalDocuments: 1234n,
      counts: { mail: 1000, chat: 234 },
    });
    const response = await (
      await app(jobs)
    ).inject({
      method: "GET",
      url: `/api/admin/search/reindex/jobs/${jobId}`,
      headers: adminHeaders(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "processing",
      sourceIndex: 2,
      totalDocuments: "1234",
      counts: { mail: 1000, chat: 234 },
    });
  });

  it("denies cross-organization reindex requests before queueing", async () => {
    const jobs = new FakeJobs();
    const response = await (
      await app(jobs)
    ).inject({
      method: "POST",
      url: "/api/admin/search/reindex",
      headers: adminHeaders("admin.search.write"),
      payload: { all: true, orgId: "44444444-4444-4444-8444-444444444444", types: ["mail"] },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: "Cross-organization search reindex denied.",
      code: "cross_org_reindex_denied",
    });
    expect(jobs.inPlace).toEqual([]);
  });

  it("requires an admin search or config scope", async () => {
    const jobs = new FakeJobs();
    const response = await (
      await app(jobs)
    ).inject({
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
    expect(jobs.inPlace).toEqual([]);
  });

  it("rejects invalid type filters before queueing", async () => {
    const jobs = new FakeJobs();
    const response = await (
      await app(jobs)
    ).inject({
      method: "POST",
      url: "/api/admin/search/reindex",
      headers: adminHeaders("admin.search.write"),
      payload: { types: ["mail", "not-real"] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Invalid search reindex request." });
    expect(jobs.inPlace).toEqual([]);
  });

  it("creates, reads, and cancels resumable full shadow jobs", async () => {
    const jobs = new FakeJobs();
    const server = await app(jobs);

    const created = await server.inject({
      method: "POST",
      url: "/api/admin/search/reindex/jobs",
      headers: adminHeaders(),
      payload: { all: true, batchSize: 50 },
    });
    const read = await server.inject({
      method: "GET",
      url: `/api/admin/search/reindex/jobs/${jobId}`,
      headers: adminHeaders(),
    });
    const cancelled = await server.inject({
      method: "POST",
      url: `/api/admin/search/reindex/jobs/${jobId}/cancel`,
      headers: adminHeaders(),
    });

    expect(created.json()).toMatchObject({ id: jobId, mode: "shadow", startMutationId: "4" });
    expect(read.statusCode).toBe(200);
    expect(cancelled.json()).toEqual({ status: "cancelled" });
    expect(jobs.calls).toEqual([`create:50`, `get:${jobId}`, `cancel:${jobId}`]);
  });
});

function adminHeaders(scopes = "admin.config.write"): Record<string, string> {
  return {
    "x-helix-actor-id": actorId,
    "x-helix-org-id": orgId,
    "x-helix-scopes": scopes,
  };
}
