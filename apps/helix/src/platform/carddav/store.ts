import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";

export interface CardDavContactRecord {
  readonly id: string;
  readonly orgId: string;
  readonly ownerActorId: string;
  readonly href: string;
  readonly uid: string;
  readonly displayName?: string | undefined;
  readonly email?: string | undefined;
  readonly vcard: string;
  readonly etag: string;
  readonly syncVersion: number;
  readonly deletedAt?: Date | undefined;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CardDavContactStore {
  listContactsForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly limit?: number | undefined;
  }): Promise<readonly CardDavContactRecord[]>;
  getContactForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly href: string;
  }): Promise<CardDavContactRecord | null>;
  upsertContactFromVcard(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly href: string;
    readonly vcard: string;
  }): Promise<{ readonly contact: CardDavContactRecord; readonly created: boolean }>;
  deleteContact(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly href: string;
  }): Promise<boolean>;
  listContactChangesForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly sinceSyncVersion: number;
  }): Promise<readonly CardDavContactRecord[]>;
  getContactSyncVersionForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<number>;
}

export class InMemoryCardDavContactStore implements CardDavContactStore {
  readonly #contacts = new Map<string, CardDavContactRecord>();
  #syncVersion = 0;

  async listContactsForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly limit?: number | undefined;
  }): Promise<readonly CardDavContactRecord[]> {
    return [...this.#contacts.values()]
      .filter(
        (contact) =>
          contact.orgId === input.orgId &&
          contact.ownerActorId === input.actorId &&
          contact.deletedAt === undefined,
      )
      .sort((left, right) => left.href.localeCompare(right.href))
      .slice(0, input.limit);
  }

  async getContactForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly href: string;
  }): Promise<CardDavContactRecord | null> {
    const contact = this.#contacts.get(contactKey(input.orgId, input.actorId, input.href));
    return contact === undefined || contact.deletedAt !== undefined ? null : contact;
  }

  async upsertContactFromVcard(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly href: string;
    readonly vcard: string;
  }): Promise<{ readonly contact: CardDavContactRecord; readonly created: boolean }> {
    const parsed = parseVcard(input.href, input.vcard);
    const key = contactKey(input.orgId, input.actorId, input.href);
    const existing = this.#contacts.get(key);
    const now = new Date();
    const contact: CardDavContactRecord = {
      id: existing?.id ?? randomUUID(),
      orgId: input.orgId,
      ownerActorId: input.actorId,
      href: input.href,
      uid: parsed.uid,
      displayName: parsed.displayName,
      email: parsed.email,
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
    readonly href: string;
  }): Promise<boolean> {
    const key = contactKey(input.orgId, input.actorId, input.href);
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
    readonly sinceSyncVersion: number;
  }): Promise<readonly CardDavContactRecord[]> {
    return [...this.#contacts.values()]
      .filter(
        (contact) =>
          contact.orgId === input.orgId &&
          contact.ownerActorId === input.actorId &&
          contact.syncVersion > input.sinceSyncVersion,
      )
      .sort(
        (left, right) => left.syncVersion - right.syncVersion || left.href.localeCompare(right.href),
      );
  }

  async getContactSyncVersionForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<number> {
    return Math.max(
      0,
      ...[...this.#contacts.values()]
        .filter(
          (contact) => contact.orgId === input.orgId && contact.ownerActorId === input.actorId,
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

  async listContactsForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly limit?: number | undefined;
  }): Promise<readonly CardDavContactRecord[]> {
    const rows = (await this.sql`
      select *
      from carddav_contacts
      where org_id = ${input.orgId}
        and owner_actor_id = ${input.actorId}
        and deleted_at is null
      order by href
      limit ${input.limit ?? 2147483647}
    `) as unknown as readonly ContactRow[];
    return rows.map(mapContact);
  }

  async getContactForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly href: string;
  }): Promise<CardDavContactRecord | null> {
    const rows = (await this.sql`
      select *
      from carddav_contacts
      where org_id = ${input.orgId}
        and owner_actor_id = ${input.actorId}
        and href = ${input.href}
        and deleted_at is null
      limit 1
    `) as unknown as readonly ContactRow[];
    return rows[0] === undefined ? null : mapContact(rows[0]);
  }

  async upsertContactFromVcard(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly href: string;
    readonly vcard: string;
  }): Promise<{ readonly contact: CardDavContactRecord; readonly created: boolean }> {
    const parsed = parseVcard(input.href, input.vcard);
    return this.sql.begin(async (transaction) => {
      const existing = await getActiveContact(transaction, input);
      const rows =
        existing === null
          ? ((await transaction`
              insert into carddav_contacts (
                org_id,
                owner_actor_id,
                href,
                uid,
                display_name,
                email,
                vcard,
                etag
              )
              values (
                ${input.orgId},
                ${input.actorId},
                ${input.href},
                ${parsed.uid},
                ${parsed.displayName ?? null},
                ${parsed.email ?? null},
                ${parsed.vcard},
                ${contactEtag(parsed.vcard)}
              )
              returning *
            `) as unknown as readonly ContactRow[])
          : ((await transaction`
              update carddav_contacts
              set uid = ${parsed.uid},
                  display_name = ${parsed.displayName ?? null},
                  email = ${parsed.email ?? null},
                  vcard = ${parsed.vcard},
                  etag = ${contactEtag(parsed.vcard)},
                  sync_version = nextval('carddav_contacts_sync_version_seq'),
                  deleted_at = null,
                  updated_at = now()
              where id = ${existing.id}
              returning *
            `) as unknown as readonly ContactRow[]);
      const row = rows[0];
      if (row === undefined) {
        throw new Error("CardDAV contact upsert did not return a row.");
      }
      return { contact: mapContact(row), created: existing === null };
    });
  }

  async deleteContact(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly href: string;
  }): Promise<boolean> {
    const rows = (await this.sql`
      update carddav_contacts
      set deleted_at = now(),
          updated_at = now(),
          sync_version = nextval('carddav_contacts_sync_version_seq')
      where org_id = ${input.orgId}
        and owner_actor_id = ${input.actorId}
        and href = ${input.href}
        and deleted_at is null
      returning id
    `) as unknown as readonly { readonly id: string }[];
    return rows[0] !== undefined;
  }

  async listContactChangesForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly sinceSyncVersion: number;
  }): Promise<readonly CardDavContactRecord[]> {
    const rows = (await this.sql`
      select *
      from carddav_contacts
      where org_id = ${input.orgId}
        and owner_actor_id = ${input.actorId}
        and sync_version > ${input.sinceSyncVersion}
      order by sync_version, href
    `) as unknown as readonly ContactRow[];
    return rows.map(mapContact);
  }

  async getContactSyncVersionForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
  }): Promise<number> {
    const rows = (await this.sql`
      select coalesce(max(sync_version), 0)::bigint as sync_version
      from carddav_contacts
      where org_id = ${input.orgId}
        and owner_actor_id = ${input.actorId}
    `) as unknown as readonly { readonly sync_version: string | number | bigint }[];
    return Number(rows[0]?.sync_version ?? 0);
  }
}

interface ParsedVcard {
  readonly uid: string;
  readonly displayName?: string | undefined;
  readonly email?: string | undefined;
  readonly vcard: string;
}

export function parseVcard(href: string, body: string): ParsedVcard {
  const normalized = body.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  const lines = normalized.split("\n").map((line) => line.trim());
  if (
    lines[0]?.toUpperCase() !== "BEGIN:VCARD" ||
    lines.at(-1)?.toUpperCase() !== "END:VCARD" ||
    !lines.some((line) => line.toUpperCase().startsWith("VERSION:"))
  ) {
    throw new InvalidVcardError("CardDAV PUT requires a valid vCard payload.");
  }
  const hrefUid = href.replace(/\.vcf$/i, "");
  const uid = valueForProperty(lines, "UID") ?? (hrefUid.length > 0 ? hrefUid : randomUUID());
  const displayName = valueForProperty(lines, "FN");
  const email = valueForProperty(lines, "EMAIL");
  return {
    uid,
    displayName,
    email,
    vcard: `${lines.join("\r\n")}\r\n`,
  };
}

export class InvalidVcardError extends Error {}

function valueForProperty(lines: readonly string[], property: string): string | undefined {
  const prefix = `${property.toUpperCase()}:`;
  const parameterizedPrefix = `${property.toUpperCase()};`;
  const line = lines.find((candidate) => {
    const upper = candidate.toUpperCase();
    return upper.startsWith(prefix) || upper.startsWith(parameterizedPrefix);
  });
  const separator = line?.indexOf(":") ?? -1;
  if (line === undefined || separator < 0) {
    return undefined;
  }
  const value = line.slice(separator + 1).trim();
  return value.length > 0 ? value : undefined;
}

function contactEtag(vcard: string): string {
  return `"contact-${createHash("sha256").update(vcard).digest("hex")}"`;
}

function contactKey(orgId: string, actorId: string, href: string): string {
  return `${orgId}:${actorId}:${href}`;
}

interface ContactRow {
  readonly id: string;
  readonly org_id: string;
  readonly owner_actor_id: string;
  readonly href: string;
  readonly uid: string;
  readonly display_name: string | null;
  readonly email: string | null;
  readonly vcard: string;
  readonly etag: string;
  readonly sync_version: string | number | bigint;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function mapContact(row: ContactRow): CardDavContactRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    ownerActorId: row.owner_actor_id,
    href: row.href,
    uid: row.uid,
    ...(row.display_name === null ? {} : { displayName: row.display_name }),
    ...(row.email === null ? {} : { email: row.email }),
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
  input: { readonly orgId: string; readonly actorId: string; readonly href: string },
): Promise<{ readonly id: string } | null> {
  const rows = (await sql`
    select id
    from carddav_contacts
    where org_id = ${input.orgId}
      and owner_actor_id = ${input.actorId}
      and href = ${input.href}
    limit 1
  `) as unknown as readonly { readonly id: string }[];
  return rows[0] ?? null;
}
