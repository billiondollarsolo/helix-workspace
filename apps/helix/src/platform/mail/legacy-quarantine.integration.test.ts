import type { StorageObject } from "@helix/sdk-types";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { PostgresMailQuarantineStore } from "./quarantine.js";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(databaseUrl === undefined)("legacy quarantine upgrade", () => {
  it("preserves raw evidence and denies ordinary mailbox access before verified release or deletion", async () => {
    const sql = postgres(databaseUrl ?? "", { max: 1 });
    const rollback = new Error("fixture rollback");
    const orgId = randomUUID(),
      actorId = randomUUID(),
      id = randomUUID();
    const raw = Buffer.from(
      "From: sender@example.test\r\nSubject: Upgrade fixture\r\n\r\nSynthetic message.",
    );
    const migration = await readFile(
      new URL("../../db/migrations/0180_merge_mail_quarantine.sql", import.meta.url),
      "utf8",
    );
    const backfill = migration
      .slice(
        migration.indexOf("insert into mail_quarantines"),
        migration.indexOf("-- Legacy bytes"),
      )
      .trim()
      .replace(/;$/, " and org_id = $1;");
    try {
      await sql.begin(async (tx) => {
        await tx`insert into orgs (id, slug, display_name) values (${orgId}, ${orgId}, 'Quarantine upgrade')`;
        await tx`insert into actors (id, org_id, type, email, display_name, scopes)
          values (${actorId}, ${orgId}, 'agent', ${`${actorId}@example.test`}, 'Mail reader', array['mail.read'])`;
        await tx`insert into mail_quarantined_messages (id, org_id, dedup_key, envelope_to, subject, reasons, raw_message)
          values (${id}, ${orgId}, ${"a".repeat(64)}, array['owner@example.test'], 'Upgrade fixture', array['spam'], ${raw})`;
        await tx.unsafe(backfill, [orgId]);
        await tx`select set_config('helix.org_id', ${orgId}, true), set_config('helix.actor_id', ${actorId}, true)`;
        await tx.unsafe("set local role helix_app");
        await expect(tx`select id from mail_quarantines where org_id = ${orgId}`).resolves.toEqual(
          [],
        );
        await expect(
          tx`select raw_message from mail_quarantined_messages where org_id = ${orgId}`,
        ).resolves.toEqual([]);
        await tx.unsafe("reset role");
        await tx`update actors set scopes = array['mail.admin'] where id = ${actorId}`;
        await tx.unsafe("set local role helix_app");
        const storage = vi.fn(async () => undefined);
        const store = new PostgresMailQuarantineStore(tx as unknown as postgres.Sql, storage);
        expect(await store.listPending(orgId)).toMatchObject([
          { id, signature: "spam", status: "pending" },
        ]);
        const claimed = await store.claimRelease(orgId, id);
        expect(claimed?.raw).toEqual(raw);
        expect(claimed?.scanEvidence).toMatchObject({
          legacyReasons: ["spam"],
          legacyStatus: "quarantined",
        });
        if (claimed === null) throw new Error("expected claim");
        await store.abortRelease(orgId, id, claimed.releaseToken);
        await tx`update mail_quarantined_messages set raw_message = ${Buffer.from("tampered")} where org_id = ${orgId} and id = ${id}`;
        await expect(store.claimRelease(orgId, id)).rejects.toMatchObject({
          name: "MailQuarantineIntegrityError",
        });
        await tx`update mail_quarantined_messages set raw_message = ${raw} where org_id = ${orgId} and id = ${id}`;
        await expect(
          store.delete({ orgId, id, actorId, reason: "Fixture deletion" }),
        ).resolves.toEqual({ found: true, bytesDeleted: true });
        expect(
          await tx`select status, raw_message from mail_quarantined_messages where org_id = ${orgId} and id = ${id}`,
        ).toEqual([{ status: "deleted", raw_message: null }]);
        expect(storage).not.toHaveBeenCalled();
        const objects = new Map<string, StorageObject>();
        const current = new PostgresMailQuarantineStore(
          tx as unknown as postgres.Sql,
          async () => ({
            managedBy: "helix-default",
            prefix: "",
            client: {
              async put(object) {
                objects.set(object.key, object);
              },
              async get(key) {
                return objects.get(key) ?? null;
              },
              async delete(key) {
                objects.delete(key);
              },
            },
          }),
        );
        const created = await current.quarantine({
          orgId,
          raw,
          recipientAddresses: ["owner@example.test"],
          signature: "fixture",
          authentication: {},
          scanEvidence: {},
        });
        const currentClaim = await current.claimRelease(orgId, created.id);
        expect(currentClaim?.raw).toEqual(raw);
        if (currentClaim === null) throw new Error("expected current claim");
        await current.abortRelease(orgId, created.id, currentClaim.releaseToken);
        await expect(
          current.delete({ orgId, id: created.id, actorId, reason: "Fixture deletion" }),
        ).resolves.toEqual({ found: true, bytesDeleted: true });
        expect(objects.size).toBe(0);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await sql.end();
    }
  });
});
