import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTestTenants } from "../../test-support/cleanup-tenants.js";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";
import { createPostgresSearchReindexSources, type SearchReindexCursor } from "./reindex.js";

const FILE_COUNT = 25;
const PAGE_SIZE = 10;

describe.skipIf(skipUnlessLiveDatabase("search reindex keyset paging"))(
  "search reindex keyset paging",
  () => {
    const admin = postgres(process.env.HELIX_MIGRATION_DATABASE_URL ?? "", { max: 2 });
    const orgId = randomUUID();
    const actorId = randomUUID();

    beforeAll(async () => {
      await admin`insert into orgs(id,slug,display_name,status) values(${orgId},${orgId},'Reindex keyset','active')`;
      await admin`insert into actors(id,org_id,type,display_name,email) values(${actorId},${orgId},'user','Owner',${`${actorId}@test.invalid`})`;
      // One statement: every row shares a single microsecond-precision timestamp,
      // as bulk seeds and imports do.
      await admin`
        insert into objects(id,org_id,kind,owner_actor_id,storage_key,mime_type,byte_size,metadata,updated_at)
        select gen_random_uuid(), ${orgId}, 'file', ${actorId}, gen_random_uuid()::text, 'text/plain', 1,
          jsonb_build_object('name', 'File ' || n || '.txt', 'status', 'ready'),
          timestamptz '2026-01-01 00:00:00.123456+00'
        from generate_series(1, ${FILE_COUNT}) as n
      `;
    });

    afterAll(async () => {
      await cleanupTestTenants(admin, [orgId]);
      await admin.end();
    });

    it("pages through rows that share a sub-millisecond timestamp and stops", async () => {
      const drive = createPostgresSearchReindexSources(admin, { pageSize: PAGE_SIZE }).find(
        (source) => source.type === "drive",
      );
      if (drive?.collectPage === undefined) throw new Error("Drive reindex source is missing.");
      const seen = new Set<string>();
      let cursor: SearchReindexCursor | undefined;
      let pages = 0;
      for (;;) {
        pages += 1;
        expect(pages, "reindex paging must not loop").toBeLessThanOrEqual(5);
        const page = await drive.collectPage({
          orgId,
          batchSize: PAGE_SIZE,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const document of page.documents) seen.add(document.id);
        if (page.done || page.cursor === undefined) break;
        expect(page.cursor.updatedAt).toBe("2026-01-01T00:00:00.123456Z");
        cursor = page.cursor;
      }
      expect(pages).toBe(3);
      expect(seen.size).toBe(FILE_COUNT);
    });
  },
);
