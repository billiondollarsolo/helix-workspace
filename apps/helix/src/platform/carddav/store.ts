import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { DavStandardsParseError, parseVCard } from "../dav/standards.js";

export interface CardDavContactRecord {
  readonly id: string;
  readonly orgId: string;
  readonly ownerActorId: string;
  readonly addressBookId?: string | undefined;
  readonly href: string;
  readonly uid: string;
  readonly displayName?: string | undefined;
  readonly email?: string | undefined;
  readonly favorite: boolean;
  readonly avatarDataUrl?: string | undefined;
  readonly relationship: Readonly<Record<string, string>>;
  readonly vcard: string;
  readonly etag: string;
  readonly syncVersion: number;
  readonly deletedAt?: Date | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type CardDavFilterProperty = "FN" | "EMAIL" | "UID";
export type CardDavMatchType = "contains" | "equals" | "starts-with" | "ends-with";

export interface CardDavContactFilter {
  readonly property: CardDavFilterProperty;
  readonly value: string;
  readonly matchType: CardDavMatchType;
  readonly negate: boolean;
}

export interface CardDavAddressBookRecord {
  readonly id: string;
  readonly ownerActorId: string;
  readonly displayName: string;
  readonly canWrite: boolean;
}

export interface CardDavContactStore {
  createAddressBook(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId: string;
    readonly displayName: string;
  }): Promise<CardDavAddressBookRecord | null>;
  shareAddressBook(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId: string;
    readonly memberActorId: string;
    readonly role: "viewer" | "editor";
  }): Promise<boolean>;
  listContactsForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
    readonly afterHref?: string | undefined;
    readonly filter?: CardDavContactFilter | undefined;
    readonly limit: number;
  }): Promise<readonly CardDavContactRecord[]>;
  listAddressBooksForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<readonly CardDavAddressBookRecord[]>;
  getContactForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
    readonly href: string;
  }): Promise<CardDavContactRecord | null>;
  getContactByIdForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly contactId: string;
  }): Promise<CardDavContactRecord | null>;
  upsertContactFromVcard(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
    readonly href: string;
    readonly vcard: string;
  }): Promise<{ readonly contact: CardDavContactRecord; readonly created: boolean }>;
  deleteContact(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
    readonly href: string;
  }): Promise<boolean>;
  listContactChangesForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
    readonly sinceSyncVersion: number;
    readonly limit: number;
  }): Promise<readonly CardDavContactRecord[]>;
  getContactSyncVersionForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
  }): Promise<number>;
}

export class InMemoryCardDavContactStore implements CardDavContactStore {
  readonly #contacts = new Map<string, CardDavContactRecord>();
  readonly #books = new Map<string, CardDavAddressBookRecord>();
  #syncVersion = 0;

  async createAddressBook(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId: string;
    readonly displayName: string;
  }): Promise<CardDavAddressBookRecord | null> {
    if (this.#books.has(input.addressBookId)) return null;
    const book = {
      id: input.addressBookId,
      ownerActorId: input.actorId,
      displayName: input.displayName,
      canWrite: true,
    };
    this.#books.set(book.id, book);
    return book;
  }

  async shareAddressBook(): Promise<boolean> {
    return true;
  }

  async listContactsForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
    readonly afterHref?: string | undefined;
    readonly filter?: CardDavContactFilter | undefined;
    readonly limit: number;
  }): Promise<readonly CardDavContactRecord[]> {
    return [...this.#contacts.values()]
      .filter(
        (contact) =>
          contact.orgId === input.orgId &&
          contact.ownerActorId === input.actorId &&
          contact.addressBookId === (input.addressBookId ?? input.actorId) &&
          contact.deletedAt === undefined &&
          (input.afterHref === undefined || contact.href > input.afterHref) &&
          matchesFilter(contact, input.filter),
      )
      .sort((left, right) => left.href.localeCompare(right.href))
      .slice(0, input.limit);
  }

  async listAddressBooksForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<readonly CardDavAddressBookRecord[]> {
    return [
      { id: input.actorId, ownerActorId: input.actorId, displayName: "Contacts", canWrite: true },
      ...this.#books.values(),
    ];
  }

  async getContactForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
    readonly href: string;
  }): Promise<CardDavContactRecord | null> {
    const contact = this.#contacts.get(
      contactKey(input.orgId, input.actorId, input.addressBookId, input.href),
    );
    return contact === undefined || contact.deletedAt !== undefined ? null : contact;
  }

  async getContactByIdForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly contactId: string;
  }): Promise<CardDavContactRecord | null> {
    return (
      [...this.#contacts.values()].find(
        (contact) =>
          contact.orgId === input.orgId &&
          contact.ownerActorId === input.actorId &&
          contact.id === input.contactId &&
          contact.deletedAt === undefined,
      ) ?? null
    );
  }

  async upsertContactFromVcard(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
    readonly href: string;
    readonly vcard: string;
  }): Promise<{ readonly contact: CardDavContactRecord; readonly created: boolean }> {
    const parsed = parseVcard(input.href, input.vcard);
    const key = contactKey(input.orgId, input.actorId, input.addressBookId, input.href);
    const existing = this.#contacts.get(key);
    const now = new Date();
    const contact: CardDavContactRecord = {
      id: existing?.id ?? randomUUID(),
      orgId: input.orgId,
      ownerActorId: input.actorId,
      addressBookId: input.addressBookId ?? input.actorId,
      href: input.href,
      uid: parsed.uid,
      displayName: parsed.displayName,
      email: parsed.email,
      favorite: parsed.favorite,
      avatarDataUrl: parsed.avatarDataUrl,
      relationship: parsed.relationship,
      vcard: parsed.vcard,
      etag: contactEtag(parsed.vcard),
      syncVersion: this.#nextSyncVersion(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.#contacts.set(key, contact);
    return { contact, created: existing === undefined };
  }

  async deleteContact(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
    readonly href: string;
  }): Promise<boolean> {
    const key = contactKey(input.orgId, input.actorId, input.addressBookId, input.href);
    const existing = this.#contacts.get(key);
    if (existing === undefined || existing.deletedAt !== undefined) {
      return false;
    }
    const now = new Date();
    this.#contacts.set(key, {
      ...existing,
      deletedAt: now,
      updatedAt: now,
      syncVersion: this.#nextSyncVersion(),
    });
    return true;
  }

  async listContactChangesForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
    readonly sinceSyncVersion: number;
    readonly limit: number;
  }): Promise<readonly CardDavContactRecord[]> {
    return [...this.#contacts.values()]
      .filter(
        (contact) =>
          contact.orgId === input.orgId &&
          contact.ownerActorId === input.actorId &&
          contact.addressBookId === (input.addressBookId ?? input.actorId) &&
          contact.syncVersion > input.sinceSyncVersion,
      )
      .sort(
        (left, right) =>
          left.syncVersion - right.syncVersion || left.href.localeCompare(right.href),
      )
      .slice(0, input.limit);
  }

  async getContactSyncVersionForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
  }): Promise<number> {
    return Math.max(
      0,
      ...[...this.#contacts.values()]
        .filter(
          (contact) =>
            contact.orgId === input.orgId &&
            contact.ownerActorId === input.actorId &&
            contact.addressBookId === (input.addressBookId ?? input.actorId),
        )
        .map((contact) => contact.syncVersion),
    );
  }

  #nextSyncVersion(): number {
    this.#syncVersion += 1;
    return this.#syncVersion;
  }
}

type SqlLike = postgres.Sql | postgres.TransactionSql;

export class PostgresCardDavContactStore implements CardDavContactStore {
  constructor(private readonly sql: postgres.Sql) {}

  async createAddressBook(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId: string;
    readonly displayName: string;
  }): Promise<CardDavAddressBookRecord | null> {
    return this.sql.begin(async (tx) => {
      await setCardDavContext(tx, input.orgId, input.actorId);
      const rows = await tx<AddressBookRow[]>`
        insert into carddav_addressbooks (id, org_id, owner_actor_id, display_name)
        select ${input.addressBookId}, ${input.orgId}, ${input.actorId}, ${input.displayName}
        where exists (
          select 1 from actors where org_id = ${input.orgId} and id = ${input.actorId}
            and disabled_at is null
        )
        on conflict do nothing
        returning id, owner_actor_id, display_name, true as can_write
      `;
      const row = rows[0];
      if (row === undefined) return null;
      await recordAddressBookMutation(tx, input, "created");
      return {
        id: row.id,
        ownerActorId: row.owner_actor_id,
        displayName: row.display_name,
        canWrite: true,
      };
    });
  }

  async shareAddressBook(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId: string;
    readonly memberActorId: string;
    readonly role: "viewer" | "editor";
  }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      await setCardDavContext(tx, input.orgId, input.actorId);
      const books = await tx<{ readonly id: string }[]>`
        select id from carddav_addressbooks
        where org_id = ${input.orgId} and id = ${input.addressBookId}
          and owner_actor_id = ${input.actorId}
          and exists (
            select 1 from actors where org_id = ${input.orgId} and id = ${input.memberActorId}
              and disabled_at is null
          )
        for update
      `;
      if (books[0] === undefined) return false;
      await tx`
        delete from permissions where org_id = ${input.orgId}
          and resource_type = 'addressbook' and resource_id = ${input.addressBookId}
          and actor_id = ${input.memberActorId}
      `;
      await tx`
        insert into permissions (
          org_id, actor_id, resource_type, resource_id, role, granted_by_actor_id
        ) values (
          ${input.orgId}, ${input.memberActorId}, 'addressbook', ${input.addressBookId},
          ${input.role}, ${input.actorId}
        )
      `;
      await recordAddressBookMutation(tx, input, "shared");
      return true;
    });
  }

  async listContactsForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
    readonly afterHref?: string | undefined;
    readonly filter?: CardDavContactFilter | undefined;
    readonly limit: number;
  }): Promise<readonly CardDavContactRecord[]> {
    assertPageLimit(input.limit);
    return withCardDavContext(this.sql, input, async (tx) => {
      const filter = input.filter;
      const filterValue = filter?.value.toLocaleLowerCase() ?? null;
      const pattern = filter === undefined ? null : filterPattern(filter);
      const rows = await tx<ContactRow[]>`
        select contact.*
        from carddav_contacts contact
        join carddav_addressbooks book on book.id = contact.addressbook_id
        where contact.org_id = ${input.orgId}
          and ${readableBookSql(tx, input.actorId, input.addressBookId)}
          and contact.deleted_at is null and contact.merged_into_id is null
          and (${input.afterHref ?? null}::text is null or contact.href > ${input.afterHref ?? null})
          and (
            ${filterValue}::text is null
            or (${filter?.negate ?? false}::boolean <> (
              case ${filter?.property ?? null}::text
                when 'FN' then lower(coalesce(contact.display_name, ''))
                when 'EMAIL' then lower(coalesce(contact.email, ''))
                when 'UID' then lower(contact.uid)
                else ''
              end like ${pattern}::text escape '\\'
            ))
          )
        order by contact.href
        limit ${input.limit}
      `;
      return rows.map(mapContact);
    });
  }

  async listAddressBooksForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<readonly CardDavAddressBookRecord[]> {
    return withCardDavContext(this.sql, input, async (tx) => {
      const rows = await tx<AddressBookRow[]>`
        select book.id, book.owner_actor_id, book.display_name,
          (book.owner_actor_id = ${input.actorId} or exists (
            select 1 from permissions permission
            where permission.org_id = book.org_id and permission.resource_type = 'addressbook'
              and permission.resource_id = book.id and permission.actor_id = ${input.actorId}
              and permission.role in ('owner', 'editor')
              and (permission.expires_at is null or permission.expires_at > statement_timestamp())
          )) as can_write
        from carddav_addressbooks book
        where book.org_id = ${input.orgId} and (
          book.owner_actor_id = ${input.actorId} or exists (
            select 1 from permissions permission
            where permission.org_id = book.org_id and permission.resource_type = 'addressbook'
              and permission.resource_id = book.id and permission.actor_id = ${input.actorId}
              and (permission.expires_at is null or permission.expires_at > statement_timestamp())
          )
        )
        order by (book.owner_actor_id = ${input.actorId}) desc, lower(book.display_name), book.id
        limit 1000
      `;
      return rows.map((row) => ({
        id: row.id,
        ownerActorId: row.owner_actor_id,
        displayName: row.display_name,
        canWrite: row.can_write,
      }));
    });
  }

  async getContactForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
    readonly href: string;
  }): Promise<CardDavContactRecord | null> {
    return withCardDavContext(this.sql, input, async (tx) => {
      const rows = await tx<ContactRow[]>`
        select contact.* from carddav_contacts contact
        join carddav_addressbooks book on book.id = contact.addressbook_id
        where contact.org_id = ${input.orgId}
          and ${readableBookSql(tx, input.actorId, input.addressBookId)}
          and contact.href = ${input.href} and contact.deleted_at is null
        limit 1
      `;
      return rows[0] === undefined ? null : mapContact(rows[0]);
    });
  }

  async getContactByIdForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly contactId: string;
  }): Promise<CardDavContactRecord | null> {
    return withCardDavContext(this.sql, input, async (tx) => {
      const rows = await tx<ContactRow[]>`
        select contact.* from carddav_contacts contact
        join carddav_addressbooks book on book.id = contact.addressbook_id
        where contact.org_id = ${input.orgId} and contact.id = ${input.contactId}
          and contact.deleted_at is null
          and (book.owner_actor_id = ${input.actorId} or exists (
            select 1 from permissions permission
            where permission.org_id = book.org_id and permission.resource_type = 'addressbook'
              and permission.resource_id = book.id and permission.actor_id = ${input.actorId}
              and (permission.expires_at is null or permission.expires_at > statement_timestamp())
          ))
        limit 1
      `;
      return rows[0] === undefined ? null : mapContact(rows[0]);
    });
  }

  async upsertContactFromVcard(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
    readonly href: string;
    readonly vcard: string;
  }): Promise<{ readonly contact: CardDavContactRecord; readonly created: boolean }> {
    const parsed = parseVcard(input.href, input.vcard);
    return this.sql.begin(async (transaction) => {
      await setCardDavContext(transaction, input.orgId, input.actorId);
      const addressBook = await writableAddressBook(transaction, input);
      const existing = await getActiveContact(transaction, { ...input, addressBookId: addressBook.id });
      const rows =
        existing === null
          ? await transaction<ContactRow[]>`
              insert into carddav_contacts (
                org_id,
                owner_actor_id,
                addressbook_id,
                href,
                uid,
                display_name,
                email,
                favorite,
                avatar_data_url,
                relationship,
                vcard,
                etag
              )
              values (
                ${input.orgId},
                ${addressBook.ownerActorId},
                ${addressBook.id},
                ${input.href},
                ${parsed.uid},
                ${parsed.displayName ?? null},
                ${parsed.email ?? null},
                ${parsed.favorite},
                ${parsed.avatarDataUrl ?? null},
                ${transaction.json(parsed.relationship)},
                ${parsed.vcard},
                ${contactEtag(parsed.vcard)}
              )
              returning *
            `
          : await transaction<ContactRow[]>`
              update carddav_contacts
              set uid = ${parsed.uid},
                  display_name = ${parsed.displayName ?? null},
                  email = ${parsed.email ?? null},
                  favorite = ${parsed.favorite},
                  avatar_data_url = ${parsed.avatarDataUrl ?? null},
                  relationship = ${transaction.json(parsed.relationship)},
                  vcard = ${parsed.vcard},
                  etag = ${contactEtag(parsed.vcard)},
                  sync_version = nextval('carddav_contacts_sync_version_seq'),
                  deleted_at = null,
                  updated_at = now()
              where id = ${existing.id}
              returning *
            `;
      const row = rows[0];
      if (row === undefined) {
        throw new Error("CardDAV contact upsert did not return a row.");
      }
      await recordContactMutation(
        transaction,
        mapContact(row),
        existing === null ? "created" : "updated",
        input.actorId,
      );
      return { contact: mapContact(row), created: existing === null };
    });
  }

  async deleteContact(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
    readonly href: string;
  }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      await setCardDavContext(tx, input.orgId, input.actorId);
      const rows = await tx<ContactRow[]>`
        update carddav_contacts contact
        set deleted_at = statement_timestamp(), updated_at = statement_timestamp(),
            sync_version = nextval('carddav_contacts_sync_version_seq')
        from carddav_addressbooks book
        where contact.addressbook_id = book.id and contact.org_id = ${input.orgId}
          and ${writableBookSql(tx, input.actorId, input.addressBookId)}
          and contact.href = ${input.href} and contact.deleted_at is null
        returning contact.*
      `;
      const deleted = rows[0];
      if (deleted === undefined) return false;
      await recordContactMutation(tx, mapContact(deleted), "deleted", input.actorId);
      return true;
    });
  }

  async listContactChangesForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
    readonly sinceSyncVersion: number;
    readonly limit: number;
  }): Promise<readonly CardDavContactRecord[]> {
    assertPageLimit(input.limit);
    return withCardDavContext(this.sql, input, async (tx) => {
      const rows = await tx<ContactRow[]>`
        select contact.* from carddav_contacts contact
        join carddav_addressbooks book on book.id = contact.addressbook_id
        where contact.org_id = ${input.orgId}
          and ${readableBookSql(tx, input.actorId, input.addressBookId)}
          and contact.sync_version > ${input.sinceSyncVersion}
        order by contact.sync_version, contact.href
        limit ${input.limit}
      `;
      return rows.map(mapContact);
    });
  }

  async getContactSyncVersionForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
  }): Promise<number> {
    return withCardDavContext(this.sql, input, async (tx) => {
      const rows = await tx<{ readonly sync_version: string | number | bigint }[]>`
        select coalesce(max(contact.sync_version), 0)::bigint as sync_version
        from carddav_contacts contact
        join carddav_addressbooks book on book.id = contact.addressbook_id
        where contact.org_id = ${input.orgId}
          and ${readableBookSql(tx, input.actorId, input.addressBookId)}
      `;
      return Number(rows[0]?.sync_version ?? 0);
    });
  }
}

interface ParsedVcard {
  readonly uid: string;
  readonly displayName?: string | undefined;
  readonly email?: string | undefined;
  readonly favorite: boolean;
  readonly avatarDataUrl?: string | undefined;
  readonly relationship: Record<string, string>;
  readonly vcard: string;
}

export function parseVcard(href: string, body: string): ParsedVcard {
  try {
    const card = parseVCard(body);
    const version = stringValue(card.getFirstPropertyValue("version"));
    if (version !== "3.0" && version !== "4.0") {
      throw new DavStandardsParseError("vcard", "invalid");
    }
    const hrefUid = href.replace(/\.vcf$/iu, "");
    const uid =
      stringValue(card.getFirstPropertyValue("uid")) ??
      (hrefUid.length > 0 ? hrefUid : randomUUID());
    const displayName = stringValue(card.getFirstPropertyValue("fn"));
    const email = stringValue(card.getFirstPropertyValue("email"));
    const avatarDataUrl = boundedAvatarDataUrl(stringValue(card.getFirstPropertyValue("photo")));
    const relationship = Object.fromEntries(
      card
        .getAllProperties("related")
        .slice(0, 20)
        .flatMap((property) => {
          const type = property.getFirstParameter("type").trim().toLowerCase();
          const value = stringValue(property.getFirstValue());
          return /^[a-z0-9_-]{1,64}$/u.test(type) && value !== undefined
            ? [[type, value.slice(0, 512)] as const]
            : [];
        }),
    );
    return {
      uid,
      ...(displayName === undefined ? {} : { displayName }),
      ...(email === undefined ? {} : { email }),
      favorite: stringValue(card.getFirstPropertyValue("x-helix-favorite")) === "true",
      ...(avatarDataUrl === undefined ? {} : { avatarDataUrl }),
      relationship,
      vcard: `${card.toString().trimEnd()}\r\n`,
    };
  } catch (error) {
    if (!(error instanceof DavStandardsParseError)) throw error;
    throw new InvalidVcardError("CardDAV PUT requires a valid vCard payload.");
  }
}

export class InvalidVcardError extends DavStandardsParseError {
  constructor(message: string) {
    super("vcard", "invalid");
    this.name = "InvalidVcardError";
    this.message = message;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function boundedAvatarDataUrl(value: string | undefined): string | undefined {
  return value !== undefined &&
    Buffer.byteLength(value) <= 350_000 &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u.test(value)
    ? value
    : undefined;
}

function contactEtag(vcard: string): string {
  return `"contact-${createHash("sha256").update(vcard).digest("hex")}"`;
}

function contactKey(
  orgId: string,
  actorId: string,
  addressBookId: string | undefined,
  href: string,
): string {
  return `${orgId}:${actorId}:${addressBookId ?? actorId}:${href}`;
}

interface ContactRow {
  readonly id: string;
  readonly org_id: string;
  readonly owner_actor_id: string;
  readonly addressbook_id: string;
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
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface AddressBookRow {
  readonly id: string;
  readonly owner_actor_id: string;
  readonly display_name: string;
  readonly can_write: boolean;
}

function mapContact(row: ContactRow): CardDavContactRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    ownerActorId: row.owner_actor_id,
    addressBookId: row.addressbook_id,
    href: row.href,
    uid: row.uid,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.email === null ? {} : { email: row.email }),
    favorite: row.favorite,
    ...(row.avatar_data_url === null ? {} : { avatarDataUrl: row.avatar_data_url }),
    relationship: row.relationship,
    vcard: row.vcard,
    etag: row.etag,
    syncVersion: Number(row.sync_version),
    ...(row.deleted_at === null ? {} : { deletedAt: row.deleted_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getActiveContact(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId: string;
    readonly href: string;
  },
): Promise<{ readonly id: string } | null> {
  const rows = await sql<{ readonly id: string }[]>`
    select id
    from carddav_contacts
    where org_id = ${input.orgId}
      and addressbook_id = ${input.addressBookId}
      and href = ${input.href}
    limit 1
  `;
  return rows[0] ?? null;
}

function assertPageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1001) {
    throw new RangeError("CardDAV page limit must be between 1 and 1001.");
  }
}

function filterPattern(filter: CardDavContactFilter): string {
  const escaped = filter.value.toLocaleLowerCase().replace(/[\\%_]/gu, "\\$&");
  if (filter.matchType === "equals") return escaped;
  if (filter.matchType === "starts-with") return `${escaped}%`;
  if (filter.matchType === "ends-with") return `%${escaped}`;
  return `%${escaped}%`;
}

function matchesFilter(
  contact: CardDavContactRecord,
  filter: CardDavContactFilter | undefined,
): boolean {
  if (filter === undefined) return true;
  const actual =
    filter.property === "FN"
      ? contact.displayName
      : filter.property === "EMAIL"
        ? contact.email
        : contact.uid;
  const left = actual?.toLocaleLowerCase() ?? "";
  const right = filter.value.toLocaleLowerCase();
  const matched =
    filter.matchType === "equals"
      ? left === right
      : filter.matchType === "starts-with"
        ? left.startsWith(right)
        : filter.matchType === "ends-with"
          ? left.endsWith(right)
          : left.includes(right);
  return filter.negate ? !matched : matched;
}

function readableBookSql(
  sql: SqlLike,
  actorId: string,
  addressBookId: string | undefined,
): postgres.PendingQuery<postgres.Row[]> {
  return sql`
    (${addressBookId ?? null}::uuid is null and book.owner_actor_id = ${actorId} and book.is_default)
    or (${addressBookId ?? null}::uuid is not null and book.id = ${addressBookId ?? null}::uuid and (
      book.owner_actor_id = ${actorId} or exists (
        select 1 from permissions permission
        where permission.org_id = book.org_id and permission.resource_type = 'addressbook'
          and permission.resource_id = book.id and permission.actor_id = ${actorId}
          and (permission.expires_at is null or permission.expires_at > statement_timestamp())
      )
    ))
  `;
}

function writableBookSql(
  sql: SqlLike,
  actorId: string,
  addressBookId: string | undefined,
): postgres.PendingQuery<postgres.Row[]> {
  return sql`
    (${addressBookId ?? null}::uuid is null and book.owner_actor_id = ${actorId} and book.is_default)
    or (${addressBookId ?? null}::uuid is not null and book.id = ${addressBookId ?? null}::uuid and (
      book.owner_actor_id = ${actorId} or exists (
        select 1 from permissions permission
        where permission.org_id = book.org_id and permission.resource_type = 'addressbook'
          and permission.resource_id = book.id and permission.actor_id = ${actorId}
          and permission.role in ('owner', 'editor')
          and (permission.expires_at is null or permission.expires_at > statement_timestamp())
      )
    ))
  `;
}

async function writableAddressBook(
  tx: postgres.TransactionSql,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId?: string | undefined;
  },
): Promise<{ readonly id: string; readonly ownerActorId: string }> {
  if (input.addressBookId === undefined) {
    const rows = await tx<{ readonly id: string; readonly owner_actor_id: string }[]>`
      insert into carddav_addressbooks (org_id, owner_actor_id, is_default)
      values (${input.orgId}, ${input.actorId}, true)
      on conflict (org_id, owner_actor_id) where is_default
      do update set updated_at = carddav_addressbooks.updated_at
      returning id, owner_actor_id
    `;
    const book = rows[0];
    if (book === undefined) throw new Error("Default CardDAV address book was not available.");
    return { id: book.id, ownerActorId: book.owner_actor_id };
  }
  const rows = await tx<{ readonly id: string; readonly owner_actor_id: string }[]>`
    select book.id, book.owner_actor_id from carddav_addressbooks book
    where book.org_id = ${input.orgId} and book.id = ${input.addressBookId}
      and (book.owner_actor_id = ${input.actorId} or exists (
        select 1 from permissions permission
        where permission.org_id = book.org_id and permission.resource_type = 'addressbook'
          and permission.resource_id = book.id and permission.actor_id = ${input.actorId}
          and permission.role in ('owner', 'editor')
          and (permission.expires_at is null or permission.expires_at > statement_timestamp())
      ))
    limit 1
  `;
  const book = rows[0];
  if (book === undefined) throw new CardDavAccessError();
  return { id: book.id, ownerActorId: book.owner_actor_id };
}

export class CardDavAccessError extends Error {
  constructor() {
    super("CardDAV address book is not writable.");
    this.name = "CardDavAccessError";
  }
}

async function withCardDavContext<T>(
  sql: postgres.Sql,
  input: { readonly orgId: string; readonly actorId: string },
  operation: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await setCardDavContext(tx, input.orgId, input.actorId);
    return operation(tx);
  })) as T;
}

async function setCardDavContext(
  sql: SqlLike,
  orgId: string,
  actorId: string,
): Promise<void> {
  await sql`select set_config('helix.org_id', ${orgId}, true), set_config('helix.actor_id', ${actorId}, true)`;
}

async function recordContactMutation(
  sql: SqlLike,
  contact: CardDavContactRecord,
  operation: "created" | "updated" | "deleted",
  actorId: string,
): Promise<void> {
  const payload = {
    version: 1,
    orgId: contact.orgId,
    actorId,
    contactId: contact.id,
    addressBookId: contact.addressBookId ?? null,
    ownerActorId: contact.ownerActorId,
    href: contact.href,
    displayName: contact.displayName ?? null,
    email: contact.email ?? null,
  };
  await sql`
    insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
    values (${contact.orgId}, ${actorId}, ${`carddav.contact.${operation}`}, 'carddav.contact',
      ${contact.id}, ${sql.json(payload)}, null, '')
  `;
  await sql`
    insert into outbox (subject, payload)
    values (${`activity.carddav.contact.${operation}`}, ${sql.json(payload)})
  `;
}

async function recordAddressBookMutation(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly addressBookId: string;
    readonly displayName?: string | undefined;
    readonly memberActorId?: string | undefined;
    readonly role?: string | undefined;
  },
  operation: "created" | "shared",
): Promise<void> {
  const payload = {
    version: 1,
    orgId: input.orgId,
    actorId: input.actorId,
    addressBookId: input.addressBookId,
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    ...(input.memberActorId === undefined ? {} : { memberActorId: input.memberActorId }),
    ...(input.role === undefined ? {} : { role: input.role }),
  };
  await sql`
    insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
    values (${input.orgId}, ${input.actorId}, ${`carddav.addressbook.${operation}`},
      'carddav.addressbook', ${input.addressBookId}, ${sql.json(payload)}, null, '')
  `;
  await sql`
    insert into outbox (subject, payload)
    values (${`activity.carddav.addressbook.${operation}`}, ${sql.json(payload)})
  `;
}
