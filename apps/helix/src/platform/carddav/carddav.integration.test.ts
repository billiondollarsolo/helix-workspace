import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresCardDavContactStore } from "./store.js";

const databaseUrl = process.env.CARD_DAV_DATABASE_URL;
const run = databaseUrl === undefined ? describe.skip : describe;

run("CardDAV PostgreSQL scalability and ACL", () => {
  const sql = postgres(databaseUrl as string, { max: 2 });
  const store = new PostgresCardDavContactStore(sql);
  const orgId = "16800000-0000-4000-8000-000000000001";
  const ownerId = "16800000-0000-4000-8000-000000000002";
  const memberId = "16800000-0000-4000-8000-000000000003";

  beforeAll(async () => {
    const ready = await sql<{ readonly ready: boolean }[]>`
      select to_regclass('carddav_addressbooks') is not null as ready
    `;
    if (ready[0]?.ready !== true) throw new Error("Run migration 0168 before this test.");
    await cleanup();
    await sql`insert into orgs(id, slug, display_name) values (${orgId}, 'carddav-168', 'CardDAV 168')`;
    await sql`insert into actors(id, org_id, type, email, display_name) values
      (${ownerId}, ${orgId}, 'user', 'owner-carddav@helix.test', 'Owner'),
      (${memberId}, ${orgId}, 'user', 'member-carddav@helix.test', 'Member')`;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  it("audits mutations, enforces shared-book ACLs, and pages 100001 contacts", async () => {
    const created = await store.upsertContactFromVcard({
      orgId,
      actorId: ownerId,
      href: "seed.vcf",
      vcard: "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:seed\r\nFN:Seed Contact\r\nEMAIL:seed@example.test\r\nEND:VCARD\r\n",
    });
    const bookId = created.contact.addressBookId;
    if (bookId === undefined) throw new Error("Expected default address book.");

    const rollback = new Error("rollback synthetic CardDAV scale data");
    try {
      await sql.begin(async (tx) => {
        await context(tx, ownerId);
        await tx`
        insert into carddav_contacts (
          org_id, owner_actor_id, addressbook_id, href, uid, display_name, email, vcard, etag
        )
        select ${orgId}, ${ownerId}, ${bookId},
          'contact-' || lpad(value::text, 6, '0') || '.vcf', 'uid-' || value::text,
          'Contact ' || lpad(value::text, 6, '0'), 'contact-' || value::text || '@example.test',
          'BEGIN:VCARD\r\nVERSION:4.0\r\nUID:uid-' || value::text || '\r\nFN:Contact ' || value::text || '\r\nEND:VCARD\r\n',
          '"bulk-' || value::text || '"'
        from generate_series(1, 100000) value
      `;
        await tx`insert into permissions (
          org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
        ) values (${orgId}, ${memberId}, 'addressbook', ${bookId}, 'viewer', ${ownerId})`;

        const page = await tx<{ readonly href: string }[]>`
          select href from carddav_contacts
          where org_id = ${orgId} and addressbook_id = ${bookId}
            and deleted_at is null and merged_into_id is null
          order by href limit 501
        `;
        expect(page).toHaveLength(501);
        // href is the keyset cursor, so fixed-width names make the stable bytewise
        // ordering explicit rather than implying locale-dependent natural sorting.
        expect(page[0]?.href).toBe("contact-000001.vcf");
        const changes = await tx<{ readonly sync_version: string }[]>`
          select sync_version::text as sync_version from carddav_contacts
          where org_id = ${orgId} and addressbook_id = ${bookId} and sync_version > 0
          order by sync_version, href limit 501
        `;
        expect(changes).toHaveLength(501);
        const shared = await tx<{ readonly can_read: boolean }[]>`
          select exists (
            select 1 from permissions where org_id = ${orgId}
              and actor_id = ${memberId} and resource_type = 'addressbook'
              and resource_id = ${bookId}
          ) as can_read
        `;
        expect(shared[0]?.can_read).toBe(true);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }

    expect(
      await store.shareAddressBook({
        orgId,
        actorId: ownerId,
        addressBookId: bookId,
        memberActorId: memberId,
        role: "viewer",
      }),
    ).toBe(true);
    expect(await store.listAddressBooksForActor({ orgId, actorId: memberId })).toContainEqual(
      expect.objectContaining({ id: bookId, ownerActorId: ownerId, canWrite: false }),
    );
    expect(
      await store.getContactByIdForActor({
        orgId,
        actorId: memberId,
        contactId: created.contact.id,
      }),
    ).toMatchObject({ id: created.contact.id });

    await sql.begin(async (tx) => {
      await context(tx, ownerId);
      const audit = await tx<{ readonly count: number }[]>`
        select count(*)::integer as count from activity
        where org_id = ${orgId} and object_id = ${created.contact.id}
          and verb = 'carddav.contact.created'
      `;
      const outbox = await tx<{ readonly count: number }[]>`
        select count(*)::integer as count from outbox
        where subject = 'activity.carddav.contact.created'
          and payload->>'contactId' = ${created.contact.id}
      `;
      expect(audit[0]?.count).toBe(1);
      expect(outbox[0]?.count).toBe(1);
    });
  }, 30_000);

  async function cleanup(): Promise<void> {
    await sql.begin(async (tx) => {
      await context(tx, ownerId);
      await tx`delete from outbox where payload->>'orgId' = ${orgId}`;
      await tx`delete from activity where org_id = ${orgId}`;
      await tx`delete from permissions where org_id = ${orgId}`;
      await tx`delete from carddav_contacts where org_id = ${orgId}`;
      await tx`delete from carddav_addressbooks where org_id = ${orgId}`;
      await tx`delete from actors where org_id = ${orgId}`;
      await tx`delete from orgs where id = ${orgId}`;
    });
  }

  async function context(tx: postgres.TransactionSql, actorId: string): Promise<void> {
    await tx`select set_config('helix.org_id', ${orgId}, true), set_config('helix.actor_id', ${actorId}, true)`;
  }
});
