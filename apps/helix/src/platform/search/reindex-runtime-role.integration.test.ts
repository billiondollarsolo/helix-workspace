import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { uniqueTestRole } from "../../test-support/test-role.js";
import { PostgresChatStore } from "../chat/index.js";
import { tenantAwarePostgresSql } from "../tenancy/postgres-roles.js";
import { createPostgresSearchReindexSources, SearchReindexService } from "./reindex.js";
import type { IndexDocument, SearchEngine, SearchRequest } from "./types.js";

const ORGS = [
  "fe5e0000-0000-4000-8000-000000000001",
  "fe5e0000-0000-4000-8000-000000000002",
] as const;
const skip = skipUnlessLiveDatabase("Cross-tenant search reindex under the runtime role");

/** Holds documents in memory and answers the listing queries pruning makes. */
class MemorySearchEngine implements SearchEngine {
  readonly id = "memory";
  readonly documents = new Map<string, IndexDocument>();

  index(document: IndexDocument): Promise<void> {
    return this.upsert([document]);
  }

  upsert(documents: readonly IndexDocument[]): Promise<void> {
    for (const document of documents) this.documents.set(document.id, document);
    return Promise.resolve();
  }

  delete(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.documents.delete(id);
    return Promise.resolve();
  }

  search(request: SearchRequest) {
    const hits = [...this.documents.values()].filter(
      (document) => request.types?.includes(document.type) ?? true,
    );
    const offset = request.offset ?? 0;
    return Promise.resolve({
      query: request.query,
      hits: hits.slice(offset, offset + (request.limit ?? hits.length)),
    });
  }
}

describe("Cross-tenant search reindex under the runtime role", { skip }, () => {
  const { name: role, password } = uniqueTestRole("helix_reindex_runtime");
  let admin: postgres.Sql;
  let runtimeRaw: postgres.Sql;
  const messageIds: string[] = [];

  beforeAll(async () => {
    const databaseUrl = process.env.DATABASE_URL ?? "";
    admin = postgres(databaseUrl, { max: 2, prepare: false });
    await cleanupTestTenants(admin, ORGS);
    await admin.unsafe(
      `create role ${role} login inherit nosuperuser nobypassrls password '${password}'`,
    );
    await admin.unsafe(`grant helix_app to ${role}`);
    const chat = new PostgresChatStore(admin);
    for (const [index, orgId] of ORGS.entries()) {
      await admin`
        insert into orgs (id, slug, display_name)
        values (${orgId}, ${`reindex-runtime-${String(index)}`}, 'Reindex runtime')
      `;
      const [actor] = await admin<{ id: string }[]>`
        insert into actors (org_id, type, email, display_name)
        values (${orgId}, 'user', ${`owner${String(index)}@reindex-runtime.test`}, 'Owner')
        returning id
      `;
      if (actor === undefined) throw new Error("Expected an actor");
      const room = await chat.createRoom({ orgId, actorId: actor.id, subject: "Reindex" });
      const message = await chat.sendMessage({
        orgId,
        actorId: actor.id,
        roomId: room.id,
        body: `indexed in org ${String(index)}`,
      });
      messageIds.push(message.id);
    }
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtimeRaw = postgres(runtimeUrl.href, { max: 4, prepare: false });
  });

  afterAll(async () => {
    await runtimeRaw.end();
    await cleanupTestTenants(admin, ORGS);
    await admin.unsafe(`drop role if exists ${role}`);
    await admin.end();
  });

  it("indexes every tenant and prunes only documents whose source is gone", async () => {
    const engine = new MemorySearchEngine();
    await engine.upsert([
      { id: "chat:gone", type: "chat", attributes: { orgId: ORGS[0] } },
      ...messageIds.map((id, index) => ({
        id: `chat:${id}`,
        type: "chat",
        attributes: { orgId: ORGS[index] ?? "" },
      })),
    ]);
    const service = new SearchReindexService({
      engine,
      sources: createPostgresSearchReindexSources(tenantAwarePostgresSql(runtimeRaw)),
    });

    // The reconciliation shape: no organization, stale documents pruned.
    const result = await service.reindex({ types: ["chat"], pruneStale: true });

    const indexed = [...engine.documents.values()].filter((document) =>
      ORGS.some((orgId) => document.attributes?.orgId === orgId),
    );
    expect(indexed.map((document) => document.id).sort()).toEqual(
      messageIds.map((id) => `chat:${id}`).sort(),
    );
    expect(result.counts.chat).toBeGreaterThanOrEqual(messageIds.length);
    expect(engine.documents.has("chat:gone")).toBe(false);
  });
});
