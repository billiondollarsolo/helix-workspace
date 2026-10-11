/*
 * The Contacts app's storage: the signed-in member's own default CardDAV
 * address book. Every write goes through the same columns, sync version,
 * activity and outbox entries as a CardDAV PUT or DELETE, so CardDAV clients
 * and search see the change. Org members (Directory) are read-only.
 */
import {
  CONTACT_LIMITS,
  type Contact,
  type ContactDuplicateGroup,
  type ContactFields,
  type ContactPatch,
  type ContactLabel,
  type DirectoryMember,
} from "@helix/contracts";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { ConflictError, NotFoundError } from "../../api/api-error.js";
import { withTenantPostgresContext } from "../tenancy/postgres-roles.js";
import {
  readContactCard,
  sameLabel,
  uniqueLabels,
  writeContactCard,
  type ContactCard,
} from "./contact-card.js";
import type { ImportedCard } from "./contact-import.js";
import { contactEtag, parseVcard, recordContactMutation } from "./store.js";

export interface ContactsActor {
  readonly orgId: string;
  readonly actorId: string;
}

/** Cards read per request; larger books page through `offset`. */
const SCAN_LIMIT = 5000;

/** A `carddav_contacts` row; every query selects `contact.*`. */
interface ContactRow {
  readonly id: string;
  readonly addressbook_id: string;
  readonly owner_actor_id: string;
  readonly href: string;
  readonly uid: string;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly favorite: boolean;
  readonly avatar_data_url: string | null;
  readonly relationship: Record<string, string>;
  readonly vcard: string;
  readonly etag: string;
  readonly sync_version: string | number | bigint;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly deleted_at: Date | null;
}

type Tx = postgres.TransactionSql;

export class PostgresContactsStore {
  constructor(private readonly sql: postgres.Sql) {}

  list(
    actor: ContactsActor,
    input: {
      readonly view: "contacts" | "trash";
      readonly label?: string | undefined;
      readonly query?: string | undefined;
      readonly offset: number;
      readonly limit: number;
    },
  ): Promise<{ readonly contacts: readonly Contact[]; readonly total: number }> {
    return this.#run(actor, async (tx) => {
      const rows = await bookRows(tx, actor, { trash: input.view === "trash" });
      const query = input.query?.trim().toLocaleLowerCase() ?? "";
      const matching = rows
        .map((row) => ({ row, card: readContactCard(row.vcard) }))
        .filter(
          ({ card }) =>
            (input.label === undefined ||
              card.labels.some((label) => sameLabel(label, input.label ?? ""))) &&
            (query.length === 0 || searchText(card).includes(query)),
        );
      const page = matching.slice(input.offset, input.offset + input.limit);
      const members = await memberIds(
        tx,
        actor,
        page.map(({ card }) => card.emails[0]?.value),
      );
      return {
        contacts: page.map(({ row, card }) => toContact(row, card, members)),
        total: matching.length,
      };
    });
  }

  get(actor: ContactsActor, id: string): Promise<Contact> {
    return this.#run(actor, async (tx) => {
      const row = await ownRow(tx, actor, id, { includeTrash: true });
      return this.#contact(tx, actor, row);
    });
  }

  create(actor: ContactsActor, fields: ContactFields): Promise<Contact> {
    return this.#run(actor, async (tx) => {
      await ensureLabels(tx, actor, fields.labels);
      const row = await insertCard(tx, actor, writeContactCard(null, fields));
      return this.#contact(tx, actor, row);
    });
  }

  update(actor: ContactsActor, id: string, patch: ContactPatch): Promise<Contact> {
    return this.#run(actor, async (tx) => {
      const row = await ownRow(tx, actor, id, { lock: true });
      await ensureLabels(tx, actor, patch.labels ?? []);
      const updated = await updateCard(tx, actor, row, writeContactCard(row.vcard, patch));
      return this.#contact(tx, actor, updated);
    });
  }

  /** Moves contacts to Trash; they are deleted for good after 30 days. */
  trash(actor: ContactsActor, ids: readonly string[]): Promise<readonly string[]> {
    return this.#run(actor, async (tx) => {
      const rows = await tx<ContactRow[]>`
        update carddav_contacts contact
        set deleted_at = statement_timestamp(), updated_at = statement_timestamp(),
            sync_version = nextval('carddav_contacts_sync_version_seq')
        from carddav_addressbooks book
        where ${ownBook(tx, actor)} and contact.id = any(${[...ids]}::uuid[])
          and contact.deleted_at is null and contact.merged_into_id is null
        returning contact.*
      `;
      for (const row of rows) await record(tx, actor, row, "deleted");
      return rows.map((row) => row.id);
    });
  }

  restore(actor: ContactsActor, ids: readonly string[]): Promise<readonly string[]> {
    return this.#run(actor, async (tx) => {
      const rows = await tx<ContactRow[]>`
        update carddav_contacts contact
        set deleted_at = null, updated_at = statement_timestamp(),
            sync_version = nextval('carddav_contacts_sync_version_seq')
        from carddav_addressbooks book
        where ${ownBook(tx, actor)} and contact.id = any(${[...ids]}::uuid[])
          and contact.deleted_at is not null and contact.merged_into_id is null
          and contact.purge_after > statement_timestamp()
          and not exists (
            select 1 from carddav_contacts active
            where active.addressbook_id = contact.addressbook_id
              and active.href = contact.href and active.deleted_at is null
          )
        returning contact.*
      `;
      for (const row of rows) await record(tx, actor, row, "updated");
      return rows.map((row) => row.id);
    });
  }

  /** Deletes contacts in Trash now, unless a legal hold or retention keeps them. */
  purge(actor: ContactsActor, ids: readonly string[]): Promise<readonly string[]> {
    return this.#run(actor, async (tx) => {
      const rows = await tx<{ readonly id: string }[]>`
        delete from carddav_contacts contact
        using carddav_addressbooks book
        where ${ownBook(tx, actor)} and contact.id = any(${[...ids]}::uuid[])
          and contact.deleted_at is not null and not contact.legal_hold
          and (contact.retain_until is null or contact.retain_until <= statement_timestamp())
        returning contact.id
      `;
      return rows.map((row) => row.id);
    });
  }

  labels(
    actor: ContactsActor,
  ): Promise<{ readonly labels: readonly ContactLabel[]; readonly total: number }> {
    return this.#run(actor, async (tx) => {
      const rows = await bookRows(tx, actor, { trash: false });
      const counts = new Map<string, ContactLabel>();
      for (const name of await savedLabels(tx, actor)) {
        counts.set(name.toLocaleLowerCase(), { name, count: 0 });
      }
      for (const row of rows) {
        for (const name of readContactCard(row.vcard).labels) {
          const key = name.toLocaleLowerCase();
          const current = counts.get(key);
          counts.set(key, { name: current?.name ?? name, count: (current?.count ?? 0) + 1 });
        }
      }
      return {
        labels: [...counts.values()].sort((left, right) =>
          left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
        ),
        total: rows.length,
      };
    });
  }

  createLabel(actor: ContactsActor, name: string): Promise<ContactLabel> {
    return this.#run(actor, async (tx) => {
      if ((await savedLabels(tx, actor)).some((label) => sameLabel(label, name))) {
        throw new ConflictError(`A label named “${name}” already exists.`);
      }
      await ensureLabels(tx, actor, [name]);
      const count = (await bookRows(tx, actor, { trash: false })).filter((row) =>
        readContactCard(row.vcard).labels.some((label) => sameLabel(label, name)),
      ).length;
      return { name, count };
    });
  }

  renameLabel(actor: ContactsActor, name: string, newName: string): Promise<ContactLabel> {
    return this.#run(actor, async (tx) => {
      const saved = await savedLabels(tx, actor);
      if (!sameLabel(name, newName) && saved.some((label) => sameLabel(label, newName))) {
        throw new ConflictError(`A label named “${newName}” already exists.`);
      }
      const changed = await relabel(tx, actor, (labels) =>
        labels.map((label) => (sameLabel(label, name) ? newName : label)),
      );
      const known = saved.some((label) => sameLabel(label, name));
      if (!known && changed.length === 0) throw new NotFoundError("Label not found.");
      await tx`
        delete from carddav_contact_labels
        where org_id = ${actor.orgId} and owner_actor_id = ${actor.actorId}
          and lower(name) = lower(${name})
      `;
      await ensureLabels(tx, actor, [newName]);
      return { name: newName, count: changed.filter((row) => row.deleted_at === null).length };
    });
  }

  /** Removes the label from its contacts; the contacts themselves stay. */
  deleteLabel(actor: ContactsActor, name: string): Promise<void> {
    return this.#run(actor, async (tx) => {
      const removed = await tx`
        delete from carddav_contact_labels
        where org_id = ${actor.orgId} and owner_actor_id = ${actor.actorId}
          and lower(name) = lower(${name})
        returning id
      `;
      const changed = await relabel(tx, actor, (labels) =>
        labels.filter((label) => !sameLabel(label, name)),
      );
      if (removed.length === 0 && changed.length === 0) throw new NotFoundError("Label not found.");
    });
  }

  applyLabels(
    actor: ContactsActor,
    input: {
      readonly ids: readonly string[];
      readonly add: readonly string[];
      readonly remove: readonly string[];
    },
  ): Promise<readonly Contact[]> {
    return this.#run(actor, async (tx) => {
      await ensureLabels(tx, actor, input.add);
      const rows = await tx<ContactRow[]>`
        select contact.* from carddav_contacts contact
        join carddav_addressbooks book on book.id = contact.addressbook_id
        where ${ownBook(tx, actor)} and contact.id = any(${[...input.ids]}::uuid[])
          and contact.deleted_at is null and contact.merged_into_id is null
        order by contact.id
        for update of contact
      `;
      if (rows.length !== new Set(input.ids).size) throw new NotFoundError("Contact not found.");
      const updated: ContactRow[] = [];
      for (const row of rows) {
        const current = readContactCard(row.vcard).labels;
        const next = uniqueLabels([
          ...current.filter((label) => !input.remove.some((removed) => sameLabel(removed, label))),
          ...input.add,
        ]);
        updated.push(
          next.join("\n") === current.join("\n")
            ? row
            : await updateCard(tx, actor, row, writeContactCard(row.vcard, { labels: next })),
        );
      }
      const members = await memberIds(
        tx,
        actor,
        updated.map((row) => readContactCard(row.vcard).emails[0]?.value),
      );
      return updated.map((row) => toContact(row, readContactCard(row.vcard), members));
    });
  }

  /**
   * Stores parsed cards. A card whose UID is already in the book replaces the
   * stored card and keeps the labels it had.
   */
  importCards(actor: ContactsActor, cards: readonly ImportedCard[]): Promise<number> {
    return this.#run(actor, async (tx) => {
      const labels = cards.flatMap((card) => readContactCard(card.vcard).labels);
      await ensureLabels(tx, actor, labels);
      const existing = new Map(
        (
          await tx<(ContactRow & { readonly uid: string })[]>`
            select contact.* from carddav_contacts contact
            join carddav_addressbooks book on book.id = contact.addressbook_id
            where ${ownBook(tx, actor)} and contact.deleted_at is null
              and contact.merged_into_id is null
              and contact.uid = any(${cards.map((card) => card.uid)}::text[])
            for update of contact
          `
        ).map((row) => [row.uid, row] as const),
      );
      for (const card of cards) {
        const row = existing.get(card.uid);
        if (row === undefined) {
          await insertCard(tx, actor, card.vcard);
          continue;
        }
        const labels = uniqueLabels([
          ...readContactCard(card.vcard).labels,
          ...readContactCard(row.vcard).labels,
        ]);
        await updateCard(tx, actor, row, writeContactCard(card.vcard, { labels }));
      }
      return cards.length;
    });
  }

  /** The stored vCards, in display order. */
  exportCards(
    actor: ContactsActor,
    input: { readonly ids?: readonly string[] | undefined; readonly label?: string | undefined },
  ): Promise<readonly string[]> {
    return this.#run(actor, async (tx) => {
      const wanted = input.ids === undefined ? null : new Set(input.ids);
      return (await bookRows(tx, actor, { trash: false }))
        .filter((row) => wanted === null || wanted.has(row.id))
        .filter(
          (row) =>
            input.label === undefined ||
            readContactCard(row.vcard).labels.some((label) => sameLabel(label, input.label ?? "")),
        )
        .map((row) => row.vcard);
    });
  }

  /** Contacts that share an email address or phone number. */
  duplicates(actor: ContactsActor): Promise<readonly ContactDuplicateGroup[]> {
    return this.#run(actor, async (tx) => {
      const entries = (await bookRows(tx, actor, { trash: false })).map((row) => ({
        row,
        card: readContactCard(row.vcard),
      }));
      const members = await memberIds(
        tx,
        actor,
        entries.map(({ card }) => card.emails[0]?.value),
      );
      const groups = new Map<
        string,
        { reason: "email" | "phone"; value: string; ids: Set<string> }
      >();
      const claimed = new Set<string>();
      const add = (reason: "email" | "phone", key: string, value: string, id: string) => {
        const group = groups.get(`${reason}:${key}`) ?? { reason, value, ids: new Set<string>() };
        group.ids.add(id);
        groups.set(`${reason}:${key}`, group);
      };
      for (const { row, card } of entries) {
        for (const email of card.emails)
          add("email", email.value.toLowerCase(), email.value, row.id);
        for (const phone of card.phones) {
          const digits = phone.value.replace(/\D/gu, "");
          if (digits.length >= 7) add("phone", digits, phone.value, row.id);
        }
      }
      const byId = new Map(entries.map((entry) => [entry.row.id, entry]));
      const result: ContactDuplicateGroup[] = [];
      for (const group of groups.values()) {
        const ids = [...group.ids].filter((id) => !claimed.has(id));
        if (ids.length < 2) continue;
        for (const id of ids) claimed.add(id);
        result.push({
          reason: group.reason,
          value: group.value,
          contacts: ids.flatMap((id) => {
            const entry = byId.get(id);
            return entry === undefined ? [] : [toContact(entry.row, entry.card, members)];
          }),
        });
      }
      return result;
    });
  }

  /** Folds each source into the target; the sources move to Trash. */
  merge(actor: ContactsActor, targetId: string, sourceIds: readonly string[]): Promise<Contact> {
    return this.#run(actor, async (tx) => {
      const target = await ownRow(tx, actor, targetId, { lock: true });
      const original = readContactCard(target.vcard);
      let merged: ContactFields = original;
      for (const sourceId of sourceIds) {
        const source = await ownRow(tx, actor, sourceId, { lock: true });
        const card = readContactCard(source.vcard);
        merged = mergeFields(merged, card);
        const rows = await tx<ContactRow[]>`
          update carddav_contacts
          set deleted_at = statement_timestamp(), merged_into_id = ${target.id},
              updated_at = statement_timestamp(),
              sync_version = nextval('carddav_contacts_sync_version_seq')
          where id = ${source.id} and org_id = ${actor.orgId}
          returning *
        `;
        for (const row of rows) await record(tx, actor, row, "deleted");
      }
      const updated = await updateCard(
        tx,
        actor,
        target,
        writeContactCard(target.vcard, changedFields(original, merged)),
      );
      return this.#contact(tx, actor, updated);
    });
  }

  /** Active members the actor may see, as the people directory lists them. */
  directory(
    actor: ContactsActor,
    input: { readonly query?: string | undefined; readonly offset: number; readonly limit: number },
  ): Promise<{ readonly members: readonly DirectoryMember[]; readonly total: number }> {
    return this.#run(actor, async (tx) => {
      const query = input.query?.trim().toLocaleLowerCase() ?? "";
      const pattern = `%${query.replace(/[\\%_]/gu, "\\$&")}%`;
      const rows = await tx<(DirectoryMember & { readonly total: number })[]>`
        select actor.id as "actorId",
          coalesce(nullif(actor.display_name, ''), actor.email, 'Unnamed person') as "displayName",
          actor.email,
          nullif(btrim(actor.metadata->'profile'->>'jobTitle'), '') as "jobTitle",
          case when actor.metadata->>'avatarDataUrl' ~ '^data:image/(png|jpeg|webp);base64,'
            then actor.metadata->>'avatarDataUrl' else null end as "avatarDataUrl",
          (count(*) over ())::integer as total
        from actors actor
        where ${visibleMember(tx, actor)}
          and (${query} = '' or lower(coalesce(actor.display_name, '')) like ${pattern} escape '\\'
            or lower(coalesce(actor.email, '')) like ${pattern} escape '\\')
        order by lower(coalesce(nullif(actor.display_name, ''), actor.email, '')), actor.id
        offset ${input.offset} limit ${input.limit}
      `;
      return {
        members: rows.map(({ total: _total, ...member }) => member),
        total: rows[0]?.total ?? 0,
      };
    });
  }

  async #contact(tx: Tx, actor: ContactsActor, row: ContactRow): Promise<Contact> {
    const card = readContactCard(row.vcard);
    return toContact(row, card, await memberIds(tx, actor, [card.emails[0]?.value]));
  }

  #run<T>(actor: ContactsActor, work: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantPostgresContext(this.sql, actor, work);
  }
}

function ownBook(tx: Tx, actor: ContactsActor): postgres.PendingQuery<postgres.Row[]> {
  return tx`
    book.id = contact.addressbook_id and book.org_id = ${actor.orgId}
    and book.owner_actor_id = ${actor.actorId} and book.is_default
    and contact.org_id = ${actor.orgId}
  `;
}

function visibleMember(tx: Tx, actor: ContactsActor): postgres.PendingQuery<postgres.Row[]> {
  return tx`
    actor.org_id = ${actor.orgId} and actor.type = 'user' and actor.disabled_at is null
    and (actor.id = ${actor.actorId}
      or coalesce(actor.metadata->>'directoryVisibility', 'organization') <> 'private')
    and (actor.id = ${actor.actorId} or not exists (
      select 1 from organization_memberships membership
      where membership.org_id = actor.org_id and membership.actor_id = actor.id
    ) or exists (
      select 1 from organization_memberships membership
      where membership.org_id = actor.org_id and membership.actor_id = actor.id
        and membership.status = 'active'
    ))
  `;
}

async function bookRows(
  tx: Tx,
  actor: ContactsActor,
  input: { readonly trash: boolean },
): Promise<readonly ContactRow[]> {
  return tx<ContactRow[]>`
    select contact.* from carddav_contacts contact
    join carddav_addressbooks book on book.id = contact.addressbook_id
    where ${ownBook(tx, actor)} and contact.merged_into_id is null
      and (case when ${input.trash}::boolean
        then contact.deleted_at is not null and contact.purge_after > statement_timestamp()
        else contact.deleted_at is null end)
    order by lower(coalesce(contact.display_name, '')), contact.id
    limit ${SCAN_LIMIT}
  `;
}

async function ownRow(
  tx: Tx,
  actor: ContactsActor,
  id: string,
  options: { readonly includeTrash?: boolean; readonly lock?: boolean },
): Promise<ContactRow> {
  const rows = await tx<ContactRow[]>`
    select contact.* from carddav_contacts contact
    join carddav_addressbooks book on book.id = contact.addressbook_id
    where ${ownBook(tx, actor)} and contact.id = ${id} and contact.merged_into_id is null
      and (${options.includeTrash === true}::boolean or contact.deleted_at is null)
    ${options.lock === true ? tx`for update of contact` : tx``}
  `;
  const row = rows[0];
  if (row === undefined) throw new NotFoundError("Contact not found.");
  return row;
}

async function insertCard(tx: Tx, actor: ContactsActor, vcard: string): Promise<ContactRow> {
  const books = await tx<{ readonly id: string }[]>`
    insert into carddav_addressbooks (org_id, owner_actor_id, is_default)
    values (${actor.orgId}, ${actor.actorId}, true)
    on conflict (org_id, owner_actor_id) where is_default
    do update set updated_at = carddav_addressbooks.updated_at
    returning id
  `;
  const bookId = books[0]?.id;
  if (bookId === undefined) throw new Error("The default address book was not available.");
  const href = `${randomUUID()}.vcf`;
  const parsed = parseVcard(href, vcard);
  const rows = await tx<ContactRow[]>`
    insert into carddav_contacts (
      org_id, owner_actor_id, addressbook_id, href, uid, display_name, email, favorite,
      avatar_data_url, relationship, vcard, etag
    ) values (
      ${actor.orgId}, ${actor.actorId}, ${bookId}, ${href}, ${parsed.uid},
      ${parsed.displayName ?? null}, ${parsed.email ?? null}, ${parsed.favorite},
      ${parsed.avatarDataUrl ?? null}, ${tx.json(parsed.relationship)},
      ${parsed.vcard}, ${contactEtag(parsed.vcard)}
    )
    returning *
  `;
  const row = rows[0];
  if (row === undefined) throw new Error("The contact was not saved.");
  await record(tx, actor, row, "created");
  return row;
}

async function updateCard(
  tx: Tx,
  actor: ContactsActor,
  row: ContactRow,
  vcard: string,
): Promise<ContactRow> {
  const parsed = parseVcard(row.href, vcard);
  const rows = await tx<ContactRow[]>`
    update carddav_contacts
    set uid = ${parsed.uid}, display_name = ${parsed.displayName ?? null},
        email = ${parsed.email ?? null}, favorite = ${parsed.favorite},
        avatar_data_url = ${parsed.avatarDataUrl ?? null},
        relationship = ${tx.json(parsed.relationship)}, vcard = ${parsed.vcard},
        etag = ${contactEtag(parsed.vcard)},
        sync_version = nextval('carddav_contacts_sync_version_seq'),
        updated_at = statement_timestamp()
    where id = ${row.id} and org_id = ${actor.orgId}
    returning *
  `;
  const updated = rows[0];
  if (updated === undefined) throw new NotFoundError("Contact not found.");
  await record(tx, actor, updated, "updated");
  return updated;
}

/** Rewrites the labels of every contact (Trash included) that `change` alters. */
async function relabel(
  tx: Tx,
  actor: ContactsActor,
  change: (labels: readonly string[]) => readonly string[],
): Promise<readonly ContactRow[]> {
  const rows = [
    ...(await bookRows(tx, actor, { trash: false })),
    ...(await bookRows(tx, actor, { trash: true })),
  ];
  const changed: ContactRow[] = [];
  for (const row of rows) {
    const current = readContactCard(row.vcard).labels;
    const next = uniqueLabels(change(current));
    if (next.join("\n") === current.join("\n")) continue;
    changed.push(await updateCard(tx, actor, row, writeContactCard(row.vcard, { labels: next })));
  }
  return changed;
}

async function savedLabels(tx: Tx, actor: ContactsActor): Promise<readonly string[]> {
  const rows = await tx<{ readonly name: string }[]>`
    select name from carddav_contact_labels
    where org_id = ${actor.orgId} and owner_actor_id = ${actor.actorId}
    order by lower(name)
  `;
  return rows.map((row) => row.name);
}

async function ensureLabels(
  tx: Tx,
  actor: ContactsActor,
  labels: readonly string[],
): Promise<void> {
  const unique = uniqueLabels(labels);
  if (unique.length === 0) return;
  await tx`
    insert into carddav_contact_labels (org_id, owner_actor_id, name)
    select ${actor.orgId}, ${actor.actorId}, name from unnest(${unique}::text[]) as label(name)
    on conflict do nothing
  `;
}

async function memberIds(
  tx: Tx,
  actor: ContactsActor,
  emails: readonly (string | undefined)[],
): Promise<ReadonlyMap<string, string>> {
  const wanted = [
    ...new Set(
      emails
        .filter((email): email is string => email !== undefined)
        .map((email) => email.toLowerCase()),
    ),
  ];
  if (wanted.length === 0) return new Map();
  const rows = await tx<{ readonly id: string; readonly email: string }[]>`
    select actor.id, lower(actor.email) as email from actors actor
    where ${visibleMember(tx, actor)} and lower(actor.email) = any(${wanted}::text[])
  `;
  return new Map(rows.map((row) => [row.email, row.id]));
}

async function record(
  tx: Tx,
  actor: ContactsActor,
  row: ContactRow,
  operation: "created" | "updated" | "deleted",
): Promise<void> {
  await recordContactMutation(
    tx,
    {
      id: row.id,
      orgId: actor.orgId,
      ownerActorId: row.owner_actor_id,
      addressBookId: row.addressbook_id,
      href: row.href,
      uid: row.uid,
      displayName: row.display_name ?? undefined,
      email: row.email ?? undefined,
      favorite: row.favorite,
      avatarDataUrl: row.avatar_data_url ?? undefined,
      relationship: row.relationship,
      vcard: row.vcard,
      etag: row.etag,
      syncVersion: Number(row.sync_version),
      deletedAt: row.deleted_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    operation,
    actor.actorId,
  );
}

function toContact(
  row: ContactRow,
  card: ContactCard,
  members: ReadonlyMap<string, string>,
): Contact {
  return {
    ...card,
    id: row.id,
    memberActorId: members.get(card.emails[0]?.value.toLowerCase() ?? "") ?? null,
    updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null,
  };
}

function searchText(card: ContactCard): string {
  return [
    card.displayName,
    card.givenName,
    card.familyName,
    card.company,
    card.jobTitle,
    ...card.emails.map((email) => email.value),
    ...card.phones.flatMap((phone) => [phone.value, phone.value.replace(/\D/gu, "")]),
  ]
    .join("\n")
    .toLocaleLowerCase();
}

/** Only the fields whose value differs, so untouched properties stay as stored. */
function changedFields(before: ContactFields, after: ContactFields): ContactPatch {
  return Object.fromEntries(
    (Object.keys(after) as (keyof ContactFields)[])
      .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      .map((key) => [key, after[key]]),
  );
}

/** Keeps the target's values and adds what only the source has. */
function mergeFields(target: ContactFields, source: ContactFields): ContactFields {
  const fill = (left: string, right: string) => (left.length > 0 ? left : right);
  const union = <T>(left: readonly T[], right: readonly T[], key: (entry: T) => string) => {
    const seen = new Set(left.map(key));
    return [...left, ...right.filter((entry) => !seen.has(key(entry)))].slice(
      0,
      CONTACT_LIMITS.entries,
    );
  };
  return {
    givenName: fill(target.givenName, source.givenName),
    familyName: fill(target.familyName, source.familyName),
    company: fill(target.company, source.company),
    jobTitle: fill(target.jobTitle, source.jobTitle),
    emails: union(target.emails, source.emails, (email) => email.value.toLowerCase()),
    phones: union(target.phones, source.phones, (phone) => phone.value.replace(/\D/gu, "")),
    addresses: union(target.addresses, source.addresses, (address) =>
      [address.street, address.city, address.postalCode].join("|").toLowerCase(),
    ),
    birthday: target.birthday ?? source.birthday,
    notes: [target.notes, source.notes]
      .filter((note) => note.length > 0)
      .join("\n\n")
      .slice(0, CONTACT_LIMITS.notes),
    labels: uniqueLabels([...target.labels, ...source.labels]).slice(0, CONTACT_LIMITS.labels),
    photoDataUrl: target.photoDataUrl ?? source.photoDataUrl,
    starred: target.starred || source.starred,
  };
}
