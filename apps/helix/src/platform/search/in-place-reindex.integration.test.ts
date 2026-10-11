import type { Actor } from "@helix/sdk-types";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import {
  detachedFromTenantPostgresContext,
  tenantAwarePostgresSql,
  withTenantPostgresContext,
} from "../tenancy/postgres-roles.js";
import { PostgresSearchDurabilityStore } from "./durable.js";
import { SearchInPlaceReindexWorker } from "./in-place-reindex.js";
import type { SearchReindexRequest, SearchReindexResult } from "./reindex.js";

const SKIP = skipUnlessLiveDatabase("search reindex jobs (0216)");
const adminUrl = process.env.HELIX_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const runtimeUrl = process.env.HELIX_RLS_APP_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
const ORG = "d2161000-0000-4000-8000-00000000000a";
const ADMIN = "d2161000-0000-4000-8000-0000000000a1";
const admin: Actor = { id: ADMIN, orgId: ORG, type: "user", scopes: ["admin.config.write"] };

describe.skipIf(SKIP)("search reindex jobs (0216)", () => {
  const owner = postgres(adminUrl, { max: 1, prepare: false });
  const runtime = tenantAwarePostgresSql(postgres(runtimeUrl, { max: 4, prepare: false }));
  const store = new PostgresSearchDurabilityStore(runtime);
  /** An admin's API request, on its own connection even while a worker job runs. */
  const asAdmin = <T>(work: () => Promise<T>): Promise<T> =>
    detachedFromTenantPostgresContext(() =>
      withTenantPostgresContext(runtime, { orgId: ORG, actorId: ADMIN }, work),
    );

  beforeAll(async () => {
    await cleanupTestTenants(owner, [ORG]);
    await owner`insert into orgs (id, slug, display_name) values (${ORG}, 'reindex-jobs', 'Reindex')`;
    await withTenantPostgresContext(
      owner,
      { orgId: ORG },
      (tx) => tx`
        insert into actors (id, org_id, type, email, display_name, scopes)
        values (${ADMIN}, ${ORG}, 'user', 'admin@reindex-jobs.test', 'Admin',
          array['admin.config.write'])
      `,
    );
  });

  afterAll(async () => {
    await cleanupTestTenants(owner, [ORG]);
    await owner.end();
    await runtime.end();
  });

  it("runs one in-place job per organization to completion with progress", async () => {
    const first = await asAdmin(() =>
      store.createInPlaceJob(admin, { types: ["mail", "drive"], pruneStale: false }),
    );
    // A retried request joins the queued job instead of starting another.
    const again = await asAdmin(() => store.createInPlaceJob(admin, {}));
    expect(again.id).toBe(first.id);
    expect(first).toMatchObject({
      mode: "in_place",
      targetOrgId: ORG,
      shadowIndexUid: null,
      types: ["mail", "drive"],
      pruneStale: false,
      status: "queued",
    });

    // The shadow worker never claims it, and it adds no shadow index.
    expect(
      await store.claimJobs({ owner: "shadow", mode: "shadow", limit: 10, leaseSeconds: 60 }),
    ).toEqual([]);
    expect(await store.activeShadowIndexUids()).not.toContain(null);

    const seen: SearchReindexRequest[] = [];
    const service = {
      async reindex(input: SearchReindexRequest): Promise<SearchReindexResult> {
        seen.push(input);
        await input.onProgress?.({
          sourceIndex: 0,
          totalDocuments: 7,
          deletedDocuments: 0,
          counts: { mail: 7 },
        });
        const running = await asAdmin(() => store.getJob(first.id, ORG));
        expect(running).toMatchObject({ status: "processing", totalDocuments: 7n });
        return {
          status: "completed",
          engineId: "test",
          types: ["mail", "drive"],
          totalDocuments: 9,
          deletedDocuments: 0,
          counts: { mail: 7, chat: 0, drive: 2, calendar: 0 },
          batchSize: 100,
        };
      },
    };
    const worker = new SearchInPlaceReindexWorker({ store, service });
    await expect(worker.drainOnce()).resolves.toBe(1);
    await expect(worker.drainOnce()).resolves.toBe(0);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ orgId: ORG, types: ["mail", "drive"], pruneStale: false });
    const done = await asAdmin(() => store.getJob(first.id, ORG));
    expect(done).toMatchObject({
      status: "completed",
      sourceIndex: 2,
      totalDocuments: 9n,
      counts: { mail: 7, drive: 2 },
    });
    expect(done?.completedAt).toBeInstanceOf(Date);

    // With the first one finished, a new request queues a new job.
    const next = await asAdmin(() => store.createInPlaceJob(admin, {}));
    expect(next.id).not.toBe(first.id);
    expect(next.pruneStale).toBe(true);
    expect(await asAdmin(() => store.cancelJob(next.id, ORG))).toBe(true);
  });

  it("stops a job that was cancelled while it ran", async () => {
    const job = await asAdmin(() => store.createInPlaceJob(admin, { types: ["chat"] }));
    const service = {
      async reindex(input: SearchReindexRequest): Promise<SearchReindexResult> {
        expect(await asAdmin(() => store.cancelJob(job.id, ORG))).toBe(true);
        await input.onProgress?.({
          sourceIndex: 0,
          totalDocuments: 1,
          deletedDocuments: 0,
          counts: { chat: 1 },
        });
        throw new Error("the cancelled job kept running");
      },
    };
    await expect(new SearchInPlaceReindexWorker({ store, service }).drainOnce()).resolves.toBe(1);
    expect(await asAdmin(() => store.getJob(job.id, ORG))).toMatchObject({
      status: "cancelled",
      totalDocuments: 0n,
    });
  });
});
