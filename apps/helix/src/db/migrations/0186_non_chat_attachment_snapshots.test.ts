import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { skipUnlessLiveDatabase } from "../../test-support/live-suite.js";

const migration = readFileSync(
  new URL("./0186_non_chat_attachment_snapshots.sql", import.meta.url),
  "utf8",
);

describe.skipIf(skipUnlessLiveDatabase("Non-chat attachment snapshots"))(
  "attachment snapshots",
  () => {
    const sql = postgres(process.env.DATABASE_URL ?? "", { max: 1 });
    beforeAll(async () => {
      if (
        !(await sql`select 1 from pg_proc where proname = 'helix_bind_non_chat_message_attachment'`)
          .length
      ) {
        await sql.unsafe(migration);
      }
    });
    afterAll(() => sql.end());

    it("snapshots tenant-matched Mail and Meet objects while preserving tenant and chat guards", async () => {
      const rollback = new Error("Rollback attachment fixtures");
      try {
        await sql.begin(async (tx) => {
          const org = randomUUID();
          const otherOrg = randomUUID();
          const actor = randomUUID();
          const thread = randomUUID();
          const object = randomUUID();
          const foreignObject = randomUUID();
          await tx`insert into orgs (id, slug, display_name) values
          (${org}, ${org}, 'Snapshot test'), (${otherOrg}, ${otherOrg}, 'Other tenant')`;
          await tx`insert into actors (id, org_id, type, display_name)
          values (${actor}, ${org}, 'user', 'Owner')`;
          await tx`insert into threads (id, org_id, kind, subject)
          values (${thread}, ${org}, 'mail', 'Snapshot test')`;
          await tx`insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
          values
            (${object}, ${org}, ${actor}, 'file', ${object}, 'text/plain', 12, repeat('a',64), '{"name":"note.txt","status":"ready"}'),
            (${foreignObject}, ${otherOrg}, null, 'file', ${foreignObject}, 'text/plain', 8, repeat('b',64), '{"status":"ready"}')`;
          for (const kind of ["mail", "system"] as const) {
            const message = randomUUID();
            await tx`insert into messages (id, org_id, thread_id, actor_id, kind, body)
            values (${message}, ${org}, ${thread}, ${actor}, ${kind}, 'Attachment')`;
            const rows = await tx`insert into message_attachments (org_id, message_id, object_id)
            values (${org}, ${message}, ${object}) returning snapshot, access_mode, authorized_at`;
            expect(rows[0]).toMatchObject({
              access_mode: "current_acl",
              snapshot: {
                filename: "note.txt",
                mimeType: "text/plain",
                byteSize: 12,
                classification: "standard",
              },
            });
            expect(rows[0]?.authorized_at).toBeInstanceOf(Date);
            expect(rows[0]?.snapshot).not.toHaveProperty("storageKey");
            await expect(
              tx.savepoint(
                (sp) => sp`insert into message_attachments (org_id, message_id, object_id)
            values (${org}, ${message}, ${foreignObject})`,
              ),
            ).rejects.toMatchObject({ code: "23503" });
          }
          const chatThread = randomUUID();
          const chatMessage = randomUUID();
          await tx`insert into threads (id, org_id, kind, subject) values (${chatThread}, ${org}, 'chat_room', 'Chat')`;
          await tx`insert into chat_room_settings (thread_id, org_id) values (${chatThread}, ${org})`;
          await tx`insert into messages (id, org_id, thread_id, actor_id, kind, body)
          values (${chatMessage}, ${org}, ${chatThread}, ${actor}, 'chat', 'Guard test')`;
          await expect(
            tx.savepoint(
              (sp) => sp`insert into message_attachments (org_id, message_id, object_id)
          values (${org}, ${chatMessage}, ${object})`,
            ),
          ).rejects.toThrow("chat attachment actor mismatch");
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
    });
  },
);
