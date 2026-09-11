import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HelixConfig } from "@helix/sdk-types";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { PostgresCalendarStore, calendarRecordToIndexDocument } from "../calendar/index.js";
import { resolveSearchSourceDocument } from "./source-documents.js";
import { PostgresDriveStore } from "../drive/index.js";
import { PgVectorStore } from "../ai/vector/pgvector.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { AuthorizingSearchEngine, authorizeWorkspaceSearchHit } from "./authorized.js";
import { SemanticSearchRuntime } from "./semantic-runtime.js";
import type { IndexDocument, SearchEngine } from "./types.js";

describe.skipIf(skipUnlessLiveDatabase("semantic search privacy"))(
  "semantic search with runtime-role pgvector",
  () => {
    const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 1 });
    const sql = tenantAwarePostgresSql(
      postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 3 }),
    );
    const orgId = randomUUID(),
      otherOrg = randomUUID(),
      alice = randomUUID(),
      bob = randomUUID(),
      fileId = randomUUID();
    const tenant = <T>(actorId: string, fn: () => Promise<T>) =>
      withTenantPostgresContext(sql, { orgId, actorId }, fn);
    let config: HelixConfig;
    const texts: string[] = [];
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const input = (
        JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { input: string[] }
      ).input;
      texts.push(...input);
      return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })) });
    };
    const runtime = new SemanticSearchRuntime({
      sql,
      getConfig: () => config,
      fetch,
      classifications: { get: async () => null },
    });
    const keyword: SearchEngine = {
      id: "keyword",
      index: async () => {},
      upsert: async () => {},
      delete: async () => {},
      search: async (request) => ({ query: request.query, hits: [] }),
    };
    beforeAll(async () => {
      await admin`insert into orgs(id,slug,display_name,status) values(${orgId},${orgId},'Vector test','active'),(${otherOrg},${otherOrg},'Other','active')`;
      for (const id of [alice, bob])
        await admin`insert into actors(id,org_id,type,display_name,email) values(${id},${orgId},'user',${id},${`${id}@test.invalid`})`;
      config = {
        security: { tier: "personal" },
        ai: {
          enabled: true,
          vectorStore: { plugin: "pgvector" },
          embeddingProvider: {
            plugin: "openai-compatible",
            config: { baseUrl: "http://127.0.0.1:11435/v1", model: "test", dimensions: 3 },
          },
        },
      };
    });
    afterAll(async () => {
      await cleanupTestTenants(admin, [orgId, otherOrg]);
      await Promise.all([admin.end(), sql.end()]);
    });

    it("backfills from an actor-free worker, isolates private vectors and hot-switches model collections", async () => {
      const engine = runtime.wrap(keyword);
      const docs = [alice, bob].map((id): IndexDocument => ({
        id: `mail:${id}:message`,
        type: "mail",
        body: `${id} launch`,
        attributes: {
          orgId,
          messageId: randomUUID(),
          threadId: randomUUID(),
          ragVisibility: "private",
          ragOwnerActorId: id,
        },
      }));
      await engine.upsert(docs);
      for (const id of [alice, bob]) {
        const result = await tenant(id, () =>
          engine.search({ query: "launch", forOrgId: orgId, forActorId: id }),
        );
        expect(result.hits.map((hit) => hit.id)).toEqual([`mail:${id}:message`]);
      }
      const initial = runtime.status().collection;
      config = {
        ...config,
        ai: {
          ...config.ai,
          embeddingProvider: {
            plugin: "openai-compatible",
            config: { baseUrl: "http://127.0.0.1:11435/v1", model: "changed", dimensions: 3 },
          },
        },
      };
      expect(runtime.status().collection).not.toBe(initial);
      expect(
        (
          await tenant(alice, () =>
            engine.search({ query: "launch", forOrgId: orgId, forActorId: alice }),
          )
        ).hits,
      ).toEqual([]);
      const count = texts.length;
      config = {
        ...config,
        ai: { ...config.ai, vectorStore: { plugin: "pgvector", config: { enabled: false } } },
      };
      expect(runtime.status().enabled).toBe(false);
      await tenant(alice, () =>
        engine.search({ query: "launch", forOrgId: orgId, forActorId: alice }),
      );
      expect(texts).toHaveLength(count);
    });

    it("rejects incompatible dimensions without changing an existing collection", async () => {
      await tenant(alice, async () => {
        const store = new PgVectorStore(sql);
        await store.createCollection(orgId, "dimensions", 3, "cosine");
        await store.createCollection(orgId, "dimensions", 3, "cosine");
        await expect(store.createCollection(orgId, "dimensions", 4, "cosine")).rejects.toThrow(
          "do not match",
        );
        expect(await store.getCollection(orgId, "dimensions")).toEqual({
          dim: 3,
          metric: "cosine",
        });
        expect(await store.getCollection(otherOrg, "dimensions")).toBeUndefined();
      });
    });

    it("classifies the complete source before chunking and blocks remote sensitive queries", async () => {
      config = {
        security: { tier: "personal" },
        ai: {
          enabled: true,
          vectorStore: { plugin: "pgvector" },
          embeddingProvider: {
            plugin: "openai-compatible",
            config: {
              baseUrl: "https://embeddings.example.test/v1",
              model: "preview",
              dimensions: 3,
              maxInputChars: 64,
            },
          },
        },
      };
      const engine = runtime.wrap(keyword);
      const document: IndexDocument = {
        id: `mail:${alice}:preview`,
        type: "mail",
        body: "ordinary workspace content ".repeat(100) + "Final source detail",
        attributes: {
          orgId,
          messageId: randomUUID(),
          threadId: randomUUID(),
          ragVisibility: "private",
          ragOwnerActorId: alice,
        },
      };
      const before = texts.length;
      await engine.index(document);
      expect(texts.slice(before).every((text) => text.length <= 64)).toBe(true);
      expect(texts.at(-1)).toContain("Final source detail");
      expect(runtime.status()).toMatchObject({ truncatedDocuments: 0, chunkedDocuments: 1 });
      expect(
        (
          await tenant(alice, () =>
            engine.search({ query: "ordinary", forOrgId: orgId, forActorId: alice }),
          )
        ).hits[0]?.body,
      ).toBe(texts[before]);
      const count = texts.length;
      await engine.index({
        ...document,
        body: `${document.body ?? ""}\nClassification: restricted`,
      });
      expect(runtime.status().blockedDocuments).toBe(1);
      expect(texts).toHaveLength(count);
      await tenant(alice, () =>
        engine.search({ query: "restricted", forOrgId: orgId, forActorId: alice }),
      );
      expect(texts).toHaveLength(count);
      const credential = ["api_key", "abcdefghijklmnopqrstuvwx"].join("=");
      await engine.index({ ...document, body: `${document.body ?? ""} ${credential}` });
      await tenant(alice, () =>
        engine.search({ query: credential, forOrgId: orgId, forActorId: alice }),
      );
      await tenant(alice, () =>
        engine.search({
          query: "ordinary",
          classification: "restricted",
          forOrgId: orgId,
          forActorId: alice,
        }),
      );
      expect(texts).toHaveLength(count);
      expect(
        (
          await tenant(alice, () =>
            engine.search({ query: "ordinary", forOrgId: orgId, forActorId: alice }),
          )
        ).hits,
      ).toEqual([]);
      expect(() => {
        runtime.validate({ ...config, security: { tier: "sovereign" } });
      }).toThrow("local embedding and vector");
      config = {
        ...config,
        ai: {
          ...config.ai,
          embeddingProvider: {
            plugin: "openai-compatible",
            config: {
              baseUrl: "https://embeddings.example.test/v1",
              model: "wrong-dimension",
              dimensions: 4,
            },
          },
        },
      };
      expect(await tenant(alice, () => runtime.test(orgId))).toMatchObject({
        ok: false,
        message: expect.stringContaining("dimension"),
      });
    });

    it("hydrates Calendar results only for current members after source reload", async () => {
      const calendar = new PostgresCalendarStore(sql);
      const event = await tenant(alice, () =>
        calendar.createEvent({
          orgId,
          actorId: alice,
          title: "Private calendar plan",
          metadata: { visibility: "default" },
          startsAt: new Date("2026-10-01T14:00:00Z"),
          endsAt: new Date("2026-10-01T15:00:00Z"),
        }),
      );
      const record = await tenant(alice, () => calendar.getCalendarSearchRecord(event.id));
      if (record === null) throw new Error("Calendar fixture missing");
      const stale = calendarRecordToIndexDocument(record);
      const stores = {
        calendar,
        drive: new PostgresDriveStore(sql),
        mail: { getMailSearchRecord: async () => null },
        chat: { getChatSearchRecord: async () => null },
      };
      const resolve = (actorId: string) =>
        tenant(actorId, () =>
          resolveSearchSourceDocument(
            stores,
            { query: "plan", forOrgId: orgId, forActorId: actorId },
            stale,
          ),
        );
      expect(await resolve(alice)).toMatchObject({ title: "Private calendar plan" });
      expect(await resolve(bob)).toBeNull();
      await admin`insert into cal_calendar_memberships(org_id,calendar_id,actor_id,role) values(${orgId},${event.calendarId},${bob},'reader')`;
      expect(await resolve(bob)).not.toBeNull();
      const racing = {
        ...stores,
        calendar: {
          getEventForActor: calendar.getEventForActor.bind(calendar),
          getCalendarSearchRecord: async (id: string) => {
            const fresh = await calendar.getCalendarSearchRecord(id);
            await admin`delete from cal_calendar_memberships where org_id=${orgId} and calendar_id=${event.calendarId} and actor_id=${bob}`;
            return fresh;
          },
        },
      };
      expect(
        await tenant(bob, () =>
          resolveSearchSourceDocument(
            racing,
            { query: "plan", forOrgId: orgId, forActorId: bob },
            stale,
          ),
        ),
      ).toBeNull();
      expect(await resolve(bob)).toBeNull();
      expect(await resolve(alice)).not.toBeNull();
    });

    it("rechecks canonical Drive grants after stale keyword and vector results", async () => {
      await admin`insert into objects(id,org_id,kind,owner_actor_id,storage_key,mime_type,byte_size,metadata) values(${fileId},${orgId},'file',${alice},${fileId},'text/plain',10,'{"name":"Private plan","status":"ready"}')`;
      await admin`insert into permissions(org_id,actor_id,resource_type,resource_id,role) values(${orgId},${bob},'object',${fileId},'reader')`;
      const stale: IndexDocument = {
        id: `drive:${fileId}`,
        type: "drive",
        body: "private",
        attributes: { orgId, fileId, allowedActorIds: [alice, bob] },
      };
      const engine = new AuthorizingSearchEngine({
        engine: {
          ...keyword,
          search: async (request) => ({ query: request.query, hits: [stale] }),
        },
        authorize: (request, hit) =>
          authorizeWorkspaceSearchHit(
            {
              drive: new PostgresDriveStore(sql),
              mail: { getMailSearchRecord: async () => null },
              chat: { getRoomForActor: async () => null },
              contacts: { getContactByIdForActor: async () => null },
            },
            request,
            hit,
          ),
      });
      const request = { query: "private", forOrgId: orgId, forActorId: bob };
      expect((await tenant(bob, () => engine.search(request))).hits).toHaveLength(1);
      await admin`update permissions set status='revoked',revoked_at=now(),revocation_epoch=1 where org_id=${orgId} and actor_id=${bob} and resource_id=${fileId}`;
      expect((await tenant(bob, () => engine.search(request))).hits).toEqual([]);
      expect(
        (await tenant(alice, () => engine.search({ ...request, forActorId: alice }))).hits,
      ).toHaveLength(1);
    });
  },
);
