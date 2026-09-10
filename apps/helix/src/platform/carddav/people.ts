import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import { parseVCard } from "../dav/standards.js";
import { InvalidVcardError, parseVcard } from "./store.js";

const uuid = z.string().uuid();
const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(25),
  query: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((value) => value || undefined),
  favorites: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
});
const importSchema = z.object({
  href: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{1,200}\.vcf$/u)
    .optional(),
  vcard: z.string().min(1).max(1_048_576),
});
const relationshipSchema = z
  .record(z.string().regex(/^[a-z0-9_-]{1,64}$/u), z.string().trim().min(1).max(512))
  .refine((value) => Object.keys(value).length <= 20, "At most 20 relationships are allowed.");
const avatarSchema = z
  .string()
  .max(350_000)
  .regex(/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u)
  .nullable();
const updateSchema = z
  .object({
    favorite: z.boolean().optional(),
    avatarDataUrl: avatarSchema.optional(),
    relationship: relationshipSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "A contact change is required.");
const mergeSchema = z
  .object({ sourceId: uuid, targetId: uuid })
  .refine((value) => value.sourceId !== value.targetId, "Merge contacts must be distinct.");

export interface PeopleRecord {
  readonly id: string;
  readonly kind: "personal" | "directory" | "group";
  readonly email: string | null;
  readonly displayName: string;
  readonly favorite: boolean;
  readonly avatarDataUrl: string | null;
  readonly relationship: Readonly<Record<string, string>>;
}

export interface PeopleStore {
  list(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string | undefined;
    readonly favorites?: boolean | undefined;
    readonly limit: number;
  }): Promise<readonly PeopleRecord[]>;
  importContact(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly href?: string | undefined;
    readonly vcard: string;
  }): Promise<PeopleRecord>;
  exportContact(orgId: string, actorId: string, id: string): Promise<string | null>;
  updateContact(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
    readonly favorite?: boolean | undefined;
    readonly avatarDataUrl?: string | null | undefined;
    readonly relationship?: Readonly<Record<string, string>> | undefined;
  }): Promise<PeopleRecord | null>;
  deleteContact(orgId: string, actorId: string, id: string): Promise<boolean>;
  mergeContacts(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly sourceId: string;
    readonly targetId: string;
  }): Promise<PeopleRecord | null>;
}

export class PostgresPeopleStore implements PeopleStore {
  constructor(private readonly sql: postgres.Sql) {}

  async list(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly query?: string | undefined;
    readonly favorites?: boolean | undefined;
    readonly limit: number;
  }): Promise<readonly PeopleRecord[]> {
    const query = input.query?.toLowerCase() ?? null;
    const pattern = query === null ? null : `%${escapeLike(query)}%`;
    return this.withActor(input.orgId, input.actorId, async (tx) => {
      const rows = await tx<PeopleRow[]>`
      with candidates as (
        select contact.id, 'personal'::text as kind, contact.email,
          coalesce(nullif(contact.display_name, ''), contact.email, 'Unnamed contact') as display_name,
          contact.favorite, contact.avatar_data_url,
          contact.relationship, 0 as source_rank
        from carddav_contacts contact
        where contact.org_id = ${input.orgId} and contact.owner_actor_id = ${input.actorId}
          and contact.deleted_at is null and contact.merged_into_id is null
        union all
        select actor.id, 'directory', actor.email,
          coalesce(nullif(actor.display_name, ''), actor.email, 'Unnamed person'), false,
          case when actor.metadata->>'avatarDataUrl' ~ '^data:image/(png|jpeg|webp);base64,'
            then actor.metadata->>'avatarDataUrl' else null end,
          '{}'::jsonb, 1
        from actors actor
        where actor.org_id = ${input.orgId} and actor.type = 'user' and actor.disabled_at is null
          and (actor.id = ${input.actorId} or coalesce(actor.metadata->>'directoryVisibility', 'organization') <> 'private')
          and (actor.id = ${input.actorId} or not exists (
            select 1 from organization_memberships membership
            where membership.org_id = actor.org_id and membership.actor_id = actor.id
          ) or exists (
            select 1 from organization_memberships membership
            where membership.org_id = actor.org_id and membership.actor_id = actor.id
              and membership.status = 'active'
          ))
        union all
        select group_record.id, 'group', group_record.email, group_record.name, false, null,
          jsonb_build_object('groupKind', group_record.kind, 'description', group_record.description), 2
        from admin_groups group_record where group_record.org_id = ${input.orgId}
      ), ranked as (
        select candidates.*, row_number() over (
          partition by coalesce(lower(email), kind || ':' || id::text)
          order by source_rank, favorite desc, id
        ) as duplicate_rank
        from candidates
        where (${query}::text is null
          or lower(display_name) like ${pattern}::text escape '\\'
          or lower(coalesce(email, '')) like ${pattern}::text escape '\\')
          and (${input.favorites ?? false}::boolean = false or favorite)
      )
      select id, kind, email, display_name, favorite, avatar_data_url, relationship
      from ranked where duplicate_rank = 1
      order by favorite desc, lower(display_name), id
      limit ${input.limit}
    `;
      return rows.map(mapPerson);
    });
  }

  async importContact(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly href?: string | undefined;
    readonly vcard: string;
  }): Promise<PeopleRecord> {
    return this.withActor(input.orgId, input.actorId, async (tx) => {
      const parsed = parseVcard(input.href ?? "contact.vcf", input.vcard);
      const href = input.href ?? `${safeHrefStem(parsed.uid) || randomUUID()}.vcf`;
      const books = await tx<{ readonly id: string }[]>`
        insert into carddav_addressbooks (org_id, owner_actor_id, is_default)
        values (${input.orgId}, ${input.actorId}, true)
        on conflict (org_id, owner_actor_id) where is_default
        do update set updated_at = carddav_addressbooks.updated_at
        returning id
      `;
      const addressBookId = books[0]?.id;
      if (addressBookId === undefined) throw new Error("Default address book was not available.");
      const existing = await tx<{ readonly id: string }[]>`
        select id from carddav_contacts
        where org_id = ${input.orgId} and owner_actor_id = ${input.actorId}
          and addressbook_id = ${addressBookId} and href = ${href} and deleted_at is null
        limit 1 for update
      `;
      const rows =
        existing[0] === undefined
          ? await tx<PeopleRow[]>`
            insert into carddav_contacts (
              org_id, owner_actor_id, addressbook_id, href, uid, display_name, email, favorite,
              avatar_data_url, relationship, vcard, etag
            ) values (
              ${input.orgId}, ${input.actorId}, ${addressBookId}, ${href}, ${parsed.uid},
              ${parsed.displayName ?? null}, ${parsed.email ?? null}, ${parsed.favorite},
              ${parsed.avatarDataUrl ?? null}, ${tx.json(parsed.relationship)},
              ${parsed.vcard}, ${contactEtag(parsed.vcard)}
            )
            returning id, 'personal'::text as kind, email,
              coalesce(nullif(display_name, ''), email, 'Unnamed contact') as display_name,
              favorite, avatar_data_url, relationship
          `
          : await tx<PeopleRow[]>`
            update carddav_contacts set uid = ${parsed.uid}, display_name = ${parsed.displayName ?? null},
              email = ${parsed.email ?? null}, favorite = ${parsed.favorite},
              avatar_data_url = ${parsed.avatarDataUrl ?? null}, relationship = ${tx.json(parsed.relationship)},
              vcard = ${parsed.vcard}, etag = ${contactEtag(parsed.vcard)},
              sync_version = nextval('carddav_contacts_sync_version_seq'), updated_at = statement_timestamp()
            where id = ${existing[0].id} and org_id = ${input.orgId}
            returning id, 'personal'::text as kind, email,
              coalesce(nullif(display_name, ''), email, 'Unnamed contact') as display_name,
              favorite, avatar_data_url, relationship
          `;
      if (rows[0] === undefined) throw new Error("Contact import did not return a row.");
      return mapPerson(rows[0]);
    });
  }

  async exportContact(orgId: string, actorId: string, id: string): Promise<string | null> {
    return this.withActor(orgId, actorId, async (tx) => {
      const rows = await tx<{ readonly vcard: string }[]>`
        select vcard from carddav_contacts
        where org_id = ${orgId} and owner_actor_id = ${actorId} and id = ${id}
          and deleted_at is null and merged_into_id is null
        limit 1
      `;
      return rows[0]?.vcard ?? null;
    });
  }

  async updateContact(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly id: string;
    readonly favorite?: boolean | undefined;
    readonly avatarDataUrl?: string | null | undefined;
    readonly relationship?: Readonly<Record<string, string>> | undefined;
  }): Promise<PeopleRecord | null> {
    return this.withActor(input.orgId, input.actorId, async (tx) => {
      const rows = await tx<{ readonly href: string; readonly vcard: string }[]>`
        select href, vcard from carddav_contacts
        where org_id = ${input.orgId} and owner_actor_id = ${input.actorId} and id = ${input.id}
          and deleted_at is null and merged_into_id is null
        limit 1 for update
      `;
      const row = rows[0];
      if (row === undefined) return null;
      const parsed = parseVcard(row.href, updateVcard(row.vcard, input));
      const updated = await tx<PeopleRow[]>`
        update carddav_contacts set display_name = ${parsed.displayName ?? null},
          email = ${parsed.email ?? null}, favorite = ${parsed.favorite},
          avatar_data_url = ${parsed.avatarDataUrl ?? null}, relationship = ${tx.json(parsed.relationship)},
          vcard = ${parsed.vcard}, etag = ${contactEtag(parsed.vcard)},
          sync_version = nextval('carddav_contacts_sync_version_seq'), updated_at = statement_timestamp()
        where id = ${input.id} and org_id = ${input.orgId}
        returning id, 'personal'::text as kind, email,
          coalesce(nullif(display_name, ''), email, 'Unnamed contact') as display_name,
          favorite, avatar_data_url, relationship
      `;
      return updated[0] === undefined ? null : mapPerson(updated[0]);
    });
  }

  async deleteContact(orgId: string, actorId: string, id: string): Promise<boolean> {
    return this.withActor(orgId, actorId, async (tx) => {
      const rows = await tx<{ readonly id: string }[]>`
        update carddav_contacts set deleted_at = statement_timestamp(),
          sync_version = nextval('carddav_contacts_sync_version_seq'), updated_at = statement_timestamp()
        where org_id = ${orgId} and owner_actor_id = ${actorId} and id = ${id}
          and deleted_at is null and merged_into_id is null
        returning id
      `;
      return rows[0] !== undefined;
    });
  }

  async mergeContacts(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly sourceId: string;
    readonly targetId: string;
  }): Promise<PeopleRecord | null> {
    return this.withActor(input.orgId, input.actorId, async (tx) => {
      const rows = await tx<MergeContactRow[]>`
        select id, href, vcard from carddav_contacts
        where org_id = ${input.orgId} and owner_actor_id = ${input.actorId}
          and id = any(${[input.sourceId, input.targetId]}::uuid[])
          and deleted_at is null and merged_into_id is null
        for update
      `;
      const source = rows.find((row) => row.id === input.sourceId);
      const target = rows.find((row) => row.id === input.targetId);
      if (source === undefined || target === undefined) return null;
      const sourceCard = parseVcard(source.href, source.vcard);
      const targetCard = parseVcard(target.href, target.vcard);
      const vcard = updateVcard(target.vcard, {
        favorite: sourceCard.favorite || targetCard.favorite,
        avatarDataUrl: targetCard.avatarDataUrl ?? sourceCard.avatarDataUrl ?? null,
        relationship: { ...sourceCard.relationship, ...targetCard.relationship },
        displayName: targetCard.displayName ?? sourceCard.displayName,
        email: targetCard.email ?? sourceCard.email,
      });
      const merged = parseVcard(target.href, vcard);
      const updated = await tx<PeopleRow[]>`
        update carddav_contacts set display_name = ${merged.displayName ?? null},
          email = ${merged.email ?? null}, favorite = ${merged.favorite},
          avatar_data_url = ${merged.avatarDataUrl ?? null},
          relationship = ${tx.json(merged.relationship)}, vcard = ${merged.vcard},
          etag = ${contactEtag(merged.vcard)}, sync_version = nextval('carddav_contacts_sync_version_seq'),
          updated_at = statement_timestamp()
        where id = ${target.id} and org_id = ${input.orgId}
        returning id, 'personal'::text as kind, email,
          coalesce(nullif(display_name, ''), email, 'Unnamed contact') as display_name,
          favorite, avatar_data_url, relationship
      `;
      await tx`
        update carddav_contacts set deleted_at = statement_timestamp(), merged_into_id = ${target.id},
          sync_version = nextval('carddav_contacts_sync_version_seq'), updated_at = statement_timestamp()
        where id = ${source.id} and org_id = ${input.orgId}
      `;
      return updated[0] === undefined ? null : mapPerson(updated[0]);
    });
  }

  private async withActor<T>(
    orgId: string,
    actorId: string,
    work: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> {
    const result = await this.sql.begin(async (tx) => {
      await tx`select set_config('helix.org_id', ${orgId}, true)`;
      await tx`select set_config('helix.actor_id', ${actorId}, true)`;
      return { value: await work(tx) };
    });
    return result.value;
  }
}

export async function registerPeopleRoutes(
  app: FastifyInstance,
  options: {
    readonly store: PeopleStore;
    readonly actorFromRequest: (request: FastifyRequest) => Actor | Promise<Actor>;
  },
): Promise<void> {
  app.get("/api/people", async (request, reply) => {
    const query = querySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_people_query" });
    const actor = await options.actorFromRequest(request);
    return {
      people: await options.store.list({ orgId: actor.orgId, actorId: actor.id, ...query.data }),
    };
  });
  app.get("/api/people/autocomplete", async (request, reply) => {
    const query = querySchema.safeParse(request.query);
    if (!query.success || query.data.query === undefined) {
      return reply.code(400).send({ error: "invalid_people_query" });
    }
    const actor = await options.actorFromRequest(request);
    const people = await options.store.list({
      orgId: actor.orgId,
      actorId: actor.id,
      query: query.data.query,
      limit: Math.min(query.data.limit, 20),
    });
    return { people: people.filter((person) => person.email !== null) };
  });
  app.post("/api/people/contacts/import", async (request, reply) => {
    const body = importSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_contact" });
    const actor = await options.actorFromRequest(request);
    try {
      return await reply.code(201).send({
        contact: await options.store.importContact({
          orgId: actor.orgId,
          actorId: actor.id,
          ...body.data,
        }),
      });
    } catch (error) {
      if (error instanceof InvalidVcardError)
        return reply.code(400).send({ error: "invalid_vcard" });
      throw error;
    }
  });
  app.get("/api/people/contacts/:id/export", async (request, reply) => {
    const params = z.object({ id: uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_contact" });
    const actor = await options.actorFromRequest(request);
    const vcard = await options.store.exportContact(actor.orgId, actor.id, params.data.id);
    return vcard === null
      ? reply.code(404).send({ error: "contact_not_found" })
      : reply.type("text/vcard; charset=utf-8").send(vcard);
  });
  app.patch("/api/people/contacts/:id", async (request, reply) => {
    const params = z.object({ id: uuid }).safeParse(request.params);
    const body = updateSchema.safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: "invalid_contact" });
    const actor = await options.actorFromRequest(request);
    const contact = await options.store.updateContact({
      orgId: actor.orgId,
      actorId: actor.id,
      id: params.data.id,
      ...body.data,
    });
    return contact === null ? reply.code(404).send({ error: "contact_not_found" }) : { contact };
  });
  app.delete("/api/people/contacts/:id", async (request, reply) => {
    const params = z.object({ id: uuid }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid_contact" });
    const actor = await options.actorFromRequest(request);
    return (await options.store.deleteContact(actor.orgId, actor.id, params.data.id))
      ? reply.code(204).send()
      : reply.code(404).send({ error: "contact_not_found" });
  });
  app.post("/api/people/contacts/merge", async (request, reply) => {
    const body = mergeSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_contact_merge" });
    const actor = await options.actorFromRequest(request);
    const contact = await options.store.mergeContacts({
      orgId: actor.orgId,
      actorId: actor.id,
      ...body.data,
    });
    return contact === null ? reply.code(404).send({ error: "contact_not_found" }) : { contact };
  });
}

interface PeopleRow {
  readonly id: string;
  readonly kind: PeopleRecord["kind"];
  readonly email: string | null;
  readonly display_name: string;
  readonly favorite: boolean;
  readonly avatar_data_url: string | null;
  readonly relationship: Record<string, string>;
}

interface MergeContactRow {
  readonly id: string;
  readonly href: string;
  readonly vcard: string;
}

function mapPerson(row: PeopleRow): PeopleRecord {
  return {
    id: row.id,
    kind: row.kind,
    email: row.email,
    displayName: row.display_name,
    favorite: row.favorite,
    avatarDataUrl: safeAvatar(row.avatar_data_url),
    relationship: row.relationship,
  };
}

function updateVcard(
  value: string,
  patch: {
    readonly favorite?: boolean | undefined;
    readonly avatarDataUrl?: string | null | undefined;
    readonly relationship?: Readonly<Record<string, string>> | undefined;
    readonly displayName?: string | undefined;
    readonly email?: string | undefined;
  },
): string {
  const card = parseVCard(value);
  if (patch.favorite !== undefined) {
    card.removeAllProperties("x-helix-favorite");
    if (patch.favorite) card.addPropertyWithValue("x-helix-favorite", "true");
  }
  if (patch.avatarDataUrl !== undefined) {
    card.removeAllProperties("photo");
    if (patch.avatarDataUrl !== null) card.addPropertyWithValue("photo", patch.avatarDataUrl);
  }
  if (patch.relationship !== undefined) {
    card.removeAllProperties("related");
    for (const [type, related] of Object.entries(patch.relationship)) {
      card.addPropertyWithValue("related", related).setParameter("type", type);
    }
  }
  if (patch.displayName !== undefined) card.updatePropertyWithValue("fn", patch.displayName);
  if (patch.email !== undefined) card.updatePropertyWithValue("email", patch.email);
  return `${card.toString().trimEnd()}\r\n`;
}

function safeAvatar(value: string | null): string | null {
  return value !== null &&
    value.length <= 350_000 &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u.test(value)
    ? value
    : null;
}

function safeHrefStem(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "-").slice(0, 180);
}

function contactEtag(vcard: string): string {
  return `"contact-${createHash("sha256").update(vcard).digest("hex")}"`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}
