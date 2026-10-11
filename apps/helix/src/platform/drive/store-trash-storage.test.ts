import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDriveStore } from "./store.js";

const ORG_ID = "f1250000-0000-4000-8000-000000000001";
const ACTOR_ID = "f1250000-0000-4000-8000-000000000002";
const OTHER_ACTOR_ID = "f1250000-0000-4000-8000-000000000003";
const IDS = {
  kept: "f1250000-0000-4000-8000-000000000010",
  trashed: "f1250000-0000-4000-8000-000000000011",
  othersFile: "f1250000-0000-4000-8000-000000000012",
  folder: "f1250000-0000-4000-8000-000000000013",
} as const;
const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(process.env.DATABASE_URL === undefined)(
  "Drive trash deadlines and member storage",
  () => {
    const sql = postgres(process.env.DATABASE_URL ?? "", { prepare: false });
    const store = new PostgresDriveStore(sql);

    beforeAll(async () => {
      await sql`
        insert into orgs (id, slug, display_name)
        values (${ORG_ID}, 'drive-trash-storage-test', 'Drive Trash Storage Test')
        on conflict (id) do nothing
      `;
      await sql`
        insert into actors (id, org_id, type, display_name, scopes)
        values
          (${ACTOR_ID}, ${ORG_ID}, 'user', 'Drive Storage Owner', '{}'),
          (${OTHER_ACTOR_ID}, ${ORG_ID}, 'user', 'Drive Storage Other', '{}')
        on conflict (id) do nothing
      `;
      await sql`
        insert into drive_folders (id, org_id, name, owner_actor_id, created_by_actor_id)
        values (${IDS.folder}, ${ORG_ID}, 'Old plans', ${ACTOR_ID}, ${ACTOR_ID})
        on conflict (id) do nothing
      `;
      await sql`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, metadata)
        values
          (${IDS.kept}, ${ORG_ID}, ${ACTOR_ID}, 'file', 'drive/test/kept', 'text/plain', 1000, ${sql.json({ name: "Kept", status: "ready" })}),
          (${IDS.trashed}, ${ORG_ID}, ${ACTOR_ID}, 'file', 'drive/test/trashed', 'text/plain', 24, ${sql.json({ name: "Trashed", status: "ready" })}),
          (${IDS.othersFile}, ${ORG_ID}, ${OTHER_ACTOR_ID}, 'file', 'drive/test/other', 'text/plain', 5000, ${sql.json({ name: "Other", status: "ready" })})
        on conflict (id) do nothing
      `;
      await sql`update objects set deleted_at = now() where id = ${IDS.trashed}`;
      await sql`update drive_folders set deleted_at = now() where id = ${IDS.folder}`;
    });

    afterAll(async () => {
      await sql`delete from objects where org_id = ${ORG_ID}`;
      await sql`delete from drive_folders where org_id = ${ORG_ID}`;
      await sql`delete from resource_classifications where org_id = ${ORG_ID}`;
      await sql`delete from actors where org_id = ${ORG_ID}`;
      await sql`delete from orgs where id = ${ORG_ID}`;
      await sql.end();
    });

    it("lists when each trashed file and folder leaves its recovery window", async () => {
      const page = await store.list({ orgId: ORG_ID, actorId: ACTOR_ID, includeTrashed: true });
      const byName = new Map(page.entries.map((entry) => [entry.name, entry]));
      for (const name of ["Trashed", "Old plans"]) {
        const entry = byName.get(name);
        if (entry?.deletedAt == null || entry.trashPurgeAfter == null) {
          throw new Error(`Expected ${name} to carry a trash deadline`);
        }
        expect(entry.trashPurgeAfter.getTime() - entry.deletedAt.getTime()).toBe(30 * DAY_MS);
      }
      expect(byName.get("Kept")?.trashPurgeAfter).toBeNull();
    });

    it("sums only the member's own files, trash included", async () => {
      await expect(
        store.getMemberStorageUsage({ orgId: ORG_ID, actorId: ACTOR_ID }),
      ).resolves.toEqual({ usedBytes: 1024, limitBytes: null, organizationUsedBytes: null });
    });
  },
);
