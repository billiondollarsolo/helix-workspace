/**
 * Adversarial tenant-isolation fixture.
 *
 * Requires a live PostgreSQL instance with migrations applied. This first
 * slice covers Drive because Drive is the shared object surface used by docs,
 * sheets, slides, uploads, and recordings.
 */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresDriveStore } from "../drive/index.js";
import { skipUnlessLiveDatabase } from "../test/live-suite.js";

const ACME_ORG_ID = "f9000000-0000-4000-8000-000000000001";
const ACME_ACTOR_ID = "f9000000-0000-4000-8000-000000000002";
const ACME_OBJECT_ID = "f9000000-0000-4000-8000-000000000003";
const BETA_ORG_ID = "f9000000-0000-4000-8000-000000000101";
const BETA_ACTOR_ID = "f9000000-0000-4000-8000-000000000102";
const BETA_FOLDER_ID = "f9000000-0000-4000-8000-000000000103";
const BETA_OBJECT_ID = "f9000000-0000-4000-8000-000000000104";
const BETA_TITLE = "Beta Secret Roadmap";
const BETA_STORAGE_KEY = "drive/beta-corp/secret-roadmap.txt";
const BETA_METADATA_MARKER = "beta-classified-content";

function createSql(): postgres.Sql {
  const url =
    process.env.DATABASE_URL ?? "postgres://helix:helix_dev_password@localhost:28432/helix";
  return postgres(url, { max: 2, prepare: false });
}

describe(
  "cross-tenant isolation adversarial fixture",
  {
    skip: skipUnlessLiveDatabase("cross-tenant isolation adversarial fixture"),
  },
  () => {
    let sql: postgres.Sql;
    let store: PostgresDriveStore;

    beforeAll(async () => {
      sql = createSql();
      store = new PostgresDriveStore(sql);
      await cleanupFixture(sql);
      await seedFixture(sql);
    });

    afterAll(async () => {
      await cleanupFixture(sql);
      await sql.end();
    });

    it("rejects permission rows that assign an actor to another tenant", async () => {
      await expect(
        sql`
          insert into permissions (
            org_id,
            actor_id,
            resource_type,
            resource_id,
            role,
            granted_by_actor_id
          )
          values (
            ${BETA_ORG_ID},
            ${ACME_ACTOR_ID},
            'object',
            ${BETA_OBJECT_ID},
            'reader',
            ${BETA_ACTOR_ID}
          )
        `,
      ).rejects.toMatchObject({
        code: "23503",
        constraint_name: "permissions_chat_actor_org_fk",
      });
    });

    it("does not expose beta Drive data to an acme actor", async () => {
      const readError = await captureError(() =>
        store.readFile({
          orgId: ACME_ORG_ID,
          actorId: ACME_ACTOR_ID,
          objectId: BETA_OBJECT_ID,
        }),
      );
      expect(readError?.message).toContain("Unknown or inaccessible Drive object");

      const folderError = await captureError(() =>
        store.list({
          orgId: ACME_ORG_ID,
          actorId: ACME_ACTOR_ID,
          folderId: BETA_FOLDER_ID,
        }),
      );
      expect(folderError?.message).toContain("Unknown or inaccessible Drive folder");

      const acmeFiles = await store.list({
        orgId: ACME_ORG_ID,
        actorId: ACME_ACTOR_ID,
        acrossFolders: true,
      });
      expect(acmeFiles.map((entry) => entry.id)).toContain(ACME_OBJECT_ID);
      expect(acmeFiles.map((entry) => entry.id)).not.toContain(BETA_OBJECT_ID);
      expect(serialized(acmeFiles)).not.toContain(BETA_TITLE);
      expect(serialized(acmeFiles)).not.toContain(BETA_STORAGE_KEY);
      expect(serialized(acmeFiles)).not.toContain(BETA_METADATA_MARKER);

      const searchHits = await store.search({
        orgId: ACME_ORG_ID,
        actorId: ACME_ACTOR_ID,
        query: "Beta Secret",
      });
      expect(searchHits).toHaveLength(0);
      expect(serialized(searchHits)).not.toContain(BETA_TITLE);

      await expect(
        store.share({
          orgId: ACME_ORG_ID,
          actorId: ACME_ACTOR_ID,
          objectId: BETA_OBJECT_ID,
          targetActorIds: [ACME_ACTOR_ID],
          role: "reader",
        }),
      ).rejects.toThrow("Unknown or inaccessible Drive object");

      await expect(
        store.move({
          orgId: ACME_ORG_ID,
          actorId: ACME_ACTOR_ID,
          objectId: BETA_OBJECT_ID,
          folderId: null,
        }),
      ).rejects.toThrow("Unknown or inaccessible Drive object");

      await expect(
        store.trash({
          orgId: ACME_ORG_ID,
          actorId: ACME_ACTOR_ID,
          objectId: BETA_OBJECT_ID,
        }),
      ).rejects.toThrow("Unknown or inaccessible Drive object");

      await expect(
        store.delete({
          orgId: ACME_ORG_ID,
          actorId: ACME_ACTOR_ID,
          objectId: BETA_OBJECT_ID,
        }),
      ).rejects.toThrow("Unknown or inaccessible Drive object");

      const betaRows = await sql<{ deleted_at: Date | null }[]>`
        select deleted_at from objects where id = ${BETA_OBJECT_ID} and org_id = ${BETA_ORG_ID}
      `;
      expect(betaRows[0]?.deleted_at).toBeNull();
      for (const output of [readError, folderError]) {
        expect(serialized(output)).not.toContain(BETA_TITLE);
        expect(serialized(output)).not.toContain(BETA_STORAGE_KEY);
        expect(serialized(output)).not.toContain(BETA_METADATA_MARKER);
      }
    });
  },
);

async function seedFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    insert into orgs (id, slug, display_name, status, tier, region)
    values
      (${ACME_ORG_ID}, 'acme-co-isolation-test', 'Acme Co Isolation Test', 'active', 'business', 'test'),
      (${BETA_ORG_ID}, 'beta-corp-isolation-test', 'Beta Corp Isolation Test', 'active', 'business', 'test')
    on conflict (id) do nothing
  `;
  await sql`
    insert into actors (id, org_id, type, email, display_name, scopes)
    values
      (${ACME_ACTOR_ID}, ${ACME_ORG_ID}, 'user', 'acme-isolation@example.com', 'Acme Isolation Actor', '{}'),
      (${BETA_ACTOR_ID}, ${BETA_ORG_ID}, 'user', 'beta-isolation@example.com', 'Beta Isolation Actor', '{}')
    on conflict (id) do nothing
  `;
  await sql`
    insert into drive_folders (
      id,
      org_id,
      name,
      owner_actor_id,
      created_by_actor_id,
      metadata
    )
    values (
      ${BETA_FOLDER_ID},
      ${BETA_ORG_ID},
      ${BETA_TITLE},
      ${BETA_ACTOR_ID},
      ${BETA_ACTOR_ID},
      ${sql.json({ marker: BETA_METADATA_MARKER })}
    )
  `;
  await sql`
    insert into objects (
      id,
      org_id,
      owner_actor_id,
      kind,
      storage_key,
      mime_type,
      byte_size,
      sha256,
      metadata
    )
    values
      (
        ${ACME_OBJECT_ID},
        ${ACME_ORG_ID},
        ${ACME_ACTOR_ID},
        'file',
        'drive/acme-co/visible.txt',
        'text/plain',
        12,
        null,
        ${sql.json({ name: "Acme Visible File", folderId: null, status: "ready" })}
      ),
      (
        ${BETA_OBJECT_ID},
        ${BETA_ORG_ID},
        ${BETA_ACTOR_ID},
        'file',
        ${BETA_STORAGE_KEY},
        'text/plain',
        42,
        null,
        ${sql.json({
          name: BETA_TITLE,
          folderId: BETA_FOLDER_ID,
          marker: BETA_METADATA_MARKER,
          status: "ready",
        })}
      )
  `;
  await sql`
    insert into drive_versions (
      org_id,
      object_id,
      version_number,
      storage_key,
      mime_type,
      byte_size,
      sha256,
      metadata,
      created_by_actor_id
    )
    values
      (
        ${ACME_ORG_ID},
        ${ACME_OBJECT_ID},
        1,
        'drive/acme-co/visible.txt',
        'text/plain',
        12,
        repeat('a', 64),
        '{}',
        ${ACME_ACTOR_ID}
      ),
      (
        ${BETA_ORG_ID},
        ${BETA_OBJECT_ID},
        1,
        ${BETA_STORAGE_KEY},
        'text/plain',
        42,
        repeat('b', 64),
        ${sql.json({ marker: BETA_METADATA_MARKER })},
        ${BETA_ACTOR_ID}
      )
  `;
  await sql`
    insert into permissions (org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id)
    values
      (${ACME_ORG_ID}, ${ACME_ACTOR_ID}, 'object', ${ACME_OBJECT_ID}, 'owner', ${ACME_ACTOR_ID}),
      (${BETA_ORG_ID}, ${BETA_ACTOR_ID}, 'object', ${BETA_OBJECT_ID}, 'owner', ${BETA_ACTOR_ID}),
      (${BETA_ORG_ID}, ${BETA_ACTOR_ID}, 'drive_folder', ${BETA_FOLDER_ID}, 'owner', ${BETA_ACTOR_ID})
  `;
}

async function cleanupFixture(sql: postgres.Sql): Promise<void> {
  await sql`
    delete from outbox
    where payload->>'actorId' in (${ACME_ACTOR_ID}, ${BETA_ACTOR_ID})
       or payload->>'objectId' in (${ACME_OBJECT_ID}, ${BETA_OBJECT_ID}, ${BETA_FOLDER_ID})
  `;
  await sql`
    delete from activity
    where actor_id in (${ACME_ACTOR_ID}, ${BETA_ACTOR_ID})
       or object_id in (${ACME_OBJECT_ID}, ${BETA_OBJECT_ID}, ${BETA_FOLDER_ID})
  `;
  await sql`
    delete from permissions
    where actor_id in (${ACME_ACTOR_ID}, ${BETA_ACTOR_ID})
       or resource_id in (${ACME_OBJECT_ID}, ${BETA_OBJECT_ID}, ${BETA_FOLDER_ID})
  `;
  await sql`delete from drive_versions where object_id in (${ACME_OBJECT_ID}, ${BETA_OBJECT_ID})`;
  await sql`delete from objects where id in (${ACME_OBJECT_ID}, ${BETA_OBJECT_ID})`;
  await sql`delete from drive_folders where id = ${BETA_FOLDER_ID}`;
  await sql`delete from actors where id in (${ACME_ACTOR_ID}, ${BETA_ACTOR_ID})`;
  await sql`delete from orgs where id in (${ACME_ORG_ID}, ${BETA_ORG_ID})`;
}

async function captureError(run: () => Promise<unknown>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function serialized(value: unknown): string {
  return JSON.stringify(value, errorReplacer);
}

function errorReplacer(_key: string, next: unknown): unknown {
  return next instanceof Error ? errorJson(next) : next;
}

function errorJson(error: Error): { readonly name: string; readonly message: string } {
  return { name: error.name, message: error.message };
}
