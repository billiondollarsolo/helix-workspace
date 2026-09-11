import { createHash, randomUUID } from "node:crypto";
import type { StorageClient } from "@helix/sdk-types";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { driveRecordToIndexDocument, PostgresDriveStore } from "../drive/index.js";
import { tenantAwarePostgresSql, withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import { AuthorizingSearchEngine, authorizeWorkspaceSearchHit } from "./authorized.js";
import { chunkDocument } from "./chunks.js";
import { SemanticSearchRuntime } from "./semantic-runtime.js";
import { resolveSearchSourceDocument } from "./source-documents.js";
import type { SearchHit, SearchRequest } from "./types.js";

describe.skipIf(skipUnlessLiveDatabase("Drive full-text search projection"))(
  "Drive full-text search with runtime-role authorization",
  () => {
    const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 1 });
    const sql = tenantAwarePostgresSql(
      postgres(process.env.HELIX_RLS_APP_DATABASE_URL ?? "", { max: 3 }),
    );
    const orgId = randomUUID(),
      otherOrg = randomUUID();
    const alice = randomUUID(),
      bob = randomUUID(),
      outsider = randomUUID();
    const bytes = new Map<string, Uint8Array>();
    let duringRead: (() => Promise<void>) | undefined;
    const getStream = vi.fn<NonNullable<StorageClient["getStream"]>>(async (key) => {
      const body = bytes.get(key);
      if (body === undefined) return null;
      await duringRead?.();
      return {
        key,
        body: (async function* () {
          // Split a multi-byte character in the first UTF-8 fixture.
          yield body.subarray(0, 1);
          yield body.subarray(1, 777);
          yield body.subarray(777);
        })(),
      };
    });
    const storage: StorageClient = {
      getStream,
      get: getStream,
      put: async () => {
        throw new Error("Unexpected search storage write");
      },
      delete: async () => {
        throw new Error("Unexpected search storage deletion");
      },
    };
    const drive = new PostgresDriveStore(sql, storage);
    const tenant = <T>(actorId: string, fn: () => Promise<T>, tenantId = orgId) =>
      withTenantPostgresContext(sql, { orgId: tenantId, actorId }, fn);
    const fullText = "é🙂 source detail ".repeat(180) + "FINAL-PASSAGE-VERIFIED";
    const hash = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");

    async function file(
      options: {
        status?: string | null;
        mimeType?: string;
        byteSize?: number;
        sha256?: null;
        content?: Uint8Array;
      } = {},
    ) {
      const id = randomUUID();
      const content = options.content ?? new TextEncoder().encode(fullText);
      bytes.set(id, content);
      const metadata = {
        name: "Source.txt",
        ...(options.status === null ? {} : { status: options.status ?? "ready" }),
      };
      await admin`insert into objects(id,org_id,kind,owner_actor_id,storage_key,mime_type,byte_size,sha256,metadata)
        values(${id},${orgId},'file',${alice},${id},${options.mimeType ?? "text/plain"},${options.byteSize ?? content.byteLength},${options.sha256 === null ? null : hash(content)},${admin.json(metadata)})`;
      return id;
    }

    function engine(hit: SearchHit) {
      const runtime = new SemanticSearchRuntime({
        sql,
        getConfig: () => ({ security: { tier: "personal" } }),
        classifications: { get: async () => null },
        resolveDocument: (request, candidate) =>
          resolveSearchSourceDocument(
            {
              drive: { getDriveSearchRecord: (id) => drive.getDriveSearchRecord(id, true) },
              mail: { getMailSearchRecord: async () => null },
              chat: { getChatSearchRecord: async () => null },
              calendar: {
                getCalendarSearchRecord: async () => null,
                getEventForActor: async () => null,
              },
            },
            request,
            candidate,
          ),
      });
      return new AuthorizingSearchEngine({
        engine: {
          id: "stale-index",
          index: async () => {},
          upsert: async () => {},
          delete: async () => {},
          search: async (request) => ({ query: request.query, hits: [hit] }),
        },
        authorize: (request, candidate) =>
          authorizeWorkspaceSearchHit(
            {
              drive,
              mail: { getMailSearchRecord: async () => null },
              chat: { getRoomForActor: async () => null },
              contacts: { getContactByIdForActor: async () => null },
            },
            request,
            candidate,
          ),
        hydrate: (request, candidate) => runtime.classifyHit(request, candidate),
      });
    }

    beforeAll(async () => {
      await admin`insert into orgs(id,slug,display_name,status) values(${orgId},${orgId},'Projection test','active'),(${otherOrg},${otherOrg},'Other','active')`;
      for (const [id, tenantId, name] of [
        [alice, orgId, "Alice"],
        [bob, orgId, "Bob"],
        [outsider, otherOrg, "Other"],
      ] as const)
        await admin`insert into actors(id,org_id,type,display_name,email) values(${id},${tenantId},'user',${name},${`${id}@test.invalid`})`;
      expect(
        (await tenant(alice, () => sql<{ role: string }[]>`select current_user as role`))[0]?.role,
      ).toBe("helix_app");
    });
    beforeEach(() => {
      duringRead = undefined;
      getStream.mockClear();
    });
    afterAll(async () => {
      await cleanupTestTenants(admin, [orgId, otherOrg]);
      await Promise.all([admin.end(), sql.end()]);
    });

    it("loads complete scan-clean UTF-8 content only when explicitly requested", async () => {
      const id = await file();
      expect(
        (await tenant(alice, () => drive.getDriveSearchRecord(id)))?.textContent,
      ).toBeUndefined();
      expect(getStream).not.toHaveBeenCalled();
      const record = await tenant(alice, () => drive.getDriveSearchRecord(id, true));
      expect(record?.textContent).toBe(fullText);
      expect(record?.textContent?.length).toBeGreaterThan(1024);
      expect(record?.allowedActorIds).toContain(alice);
      expect(getStream).toHaveBeenCalledOnce();
    });

    it.each([
      { status: "pending_upload" },
      { status: "scanning" },
      { status: "quarantined" },
      { status: "scan_failed" },
      { status: null },
      { sha256: null },
      { mimeType: "application/pdf" },
      { byteSize: 512 * 1024 + 1 },
    ])("does not fetch unscanned, unsupported or oversized content: %j", async (options) => {
      const id = await file(options);
      expect(
        (await tenant(alice, () => drive.getDriveSearchRecord(id, true)))?.textContent,
      ).toBeUndefined();
      expect(getStream).not.toHaveBeenCalled();
    });

    it("rejects storage tampering and a stream larger than its declared size", async () => {
      const id = await file();
      bytes.set(id, new TextEncoder().encode("Tampered source"));
      await expect(tenant(alice, () => drive.getDriveSearchRecord(id, true))).rejects.toThrow(
        "differs from the scanned file",
      );
      bytes.set(id, new Uint8Array(512 * 1024 + 1));
      await expect(tenant(alice, () => drive.getDriveSearchRecord(id, true))).rejects.toThrow(
        "512 KiB",
      );
    });

    it("hydrates a late passage and rejects revoked, deleted and cross-tenant hits", async () => {
      const id = await file();
      await admin`insert into permissions(org_id,actor_id,resource_type,resource_id,role) values(${orgId},${bob},'object',${id},'reader')`;
      const record = await tenant(alice, () => drive.getDriveSearchRecord(id, true));
      if (record === null) throw new Error("Missing source fixture");
      const last = chunkDocument(driveRecordToIndexDocument(record), { size: 256, overlap: 32 }).at(
        -1,
      );
      if (last === undefined) throw new Error("Missing source passage");
      const search = engine({ ...last.document, body: "DO NOT TRUST INDEXED BODY" });
      const request: SearchRequest = { query: "FINAL-PASSAGE", forOrgId: orgId, forActorId: bob };
      expect((await tenant(bob, () => search.search(request))).hits[0]?.body).toContain(
        "FINAL-PASSAGE-VERIFIED",
      );
      getStream.mockClear();
      expect(
        (
          await tenant(
            outsider,
            () => search.search({ ...request, forOrgId: otherOrg, forActorId: outsider }),
            otherOrg,
          )
        ).hits,
      ).toEqual([]);
      expect(getStream).not.toHaveBeenCalled();
      duringRead = async () => {
        await admin`update permissions set status='revoked',revoked_at=now(),revocation_epoch=1 where org_id=${orgId} and actor_id=${bob} and resource_id=${id}`;
      };
      expect((await tenant(bob, () => search.search(request))).hits).toEqual([]);
      expect(getStream).toHaveBeenCalledOnce();
      duringRead = undefined;
      getStream.mockClear();
      expect((await tenant(bob, () => search.search(request))).hits).toEqual([]);
      expect(getStream).not.toHaveBeenCalled();
      await admin`update objects set deleted_at=now() where id=${id}`;
      expect(
        (await tenant(alice, () => search.search({ ...request, forActorId: alice }))).hits,
      ).toEqual([]);
      expect(getStream).not.toHaveBeenCalled();
    });

    it("drops passages after an edit and rechecks source changes during storage reads", async () => {
      const id = await file();
      const record = await tenant(alice, () => drive.getDriveSearchRecord(id, true));
      if (record === null) throw new Error("Missing source fixture");
      const last = chunkDocument(driveRecordToIndexDocument(record), { size: 256, overlap: 32 }).at(
        -1,
      );
      if (last === undefined) throw new Error("Missing source passage");
      const search = engine(last.document);
      const request: SearchRequest = { query: "FINAL-PASSAGE", forOrgId: orgId, forActorId: alice };
      const changed = new TextEncoder().encode("Revised source without the prior passage");
      duringRead = async () => {
        await admin`update objects set sha256=${hash(changed)},byte_size=${changed.byteLength} where id=${id}`;
        bytes.set(id, changed);
      };
      expect((await tenant(alice, () => search.search(request))).hits).toEqual([]);
      duringRead = undefined;
      expect((await tenant(alice, () => search.search(request))).hits).toEqual([]);
    });
  },
);
