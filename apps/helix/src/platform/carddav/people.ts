import type { Actor } from "@helix/sdk-types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { z } from "zod";

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

export interface PeopleRecord {
  readonly id: string;
  readonly kind: "personal" | "directory" | "group";
  readonly email: string | null;
  readonly displayName: string;
  /** The org member this entry resolves to; personal contacts inherit it by email. */
  readonly actorId: string | null;
  readonly title: string | null;
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
    const prefix = query === null ? null : `${escapeLike(query)}%`;
    return this.withActor(input.orgId, input.actorId, async (tx) => {
      const rows = await tx<PeopleRow[]>`
      with candidates as (
        select contact.id, 'personal'::text as kind, contact.email,
          coalesce(nullif(contact.display_name, ''), contact.email, 'Unnamed contact') as display_name,
          null::uuid as actor_id, null::text as title,
          contact.favorite, contact.avatar_data_url,
          contact.relationship, 0 as source_rank
        from carddav_contacts contact
        where contact.org_id = ${input.orgId} and contact.owner_actor_id = ${input.actorId}
          and contact.deleted_at is null and contact.merged_into_id is null
        union all
        select actor.id, 'directory', actor.email,
          coalesce(nullif(actor.display_name, ''), actor.email, 'Unnamed person'), actor.id,
          nullif(btrim(actor.metadata->'profile'->>'jobTitle'), ''), false,
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
        select group_record.id, 'group', group_record.email, group_record.name, null, null,
          false, null,
          jsonb_build_object('groupKind', group_record.kind, 'description', group_record.description), 2
        from admin_groups group_record where group_record.org_id = ${input.orgId}
      ), ranked as (
        select candidates.*, row_number() over identity as duplicate_rank,
          max(actor_id::text) over identity as resolved_actor_id,
          max(title) over identity as resolved_title
        from candidates
        where (${query}::text is null
          or lower(display_name) like ${pattern}::text escape '\\'
          or lower(coalesce(email, '')) like ${pattern}::text escape '\\')
          and (${input.favorites ?? false}::boolean = false or favorite)
        window identity as (
          partition by coalesce(lower(email), kind || ':' || id::text)
          order by source_rank, favorite desc, id
          rows between unbounded preceding and unbounded following
        )
      )
      select id, kind, email, display_name, resolved_actor_id as actor_id,
        resolved_title as title, favorite, avatar_data_url, relationship
      from ranked where duplicate_rank = 1
      order by favorite desc,
        (${prefix}::text is not null and (lower(display_name) like ${prefix}::text escape '\\'
          or lower(coalesce(email, '')) like ${prefix}::text escape '\\')) desc,
        lower(display_name), id
      limit ${input.limit}
    `;
      return rows.map(mapPerson);
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
}

interface PeopleRow {
  readonly id: string;
  readonly kind: PeopleRecord["kind"];
  readonly email: string | null;
  readonly display_name: string;
  readonly actor_id?: string | null;
  readonly title?: string | null;
  readonly favorite: boolean;
  readonly avatar_data_url: string | null;
  readonly relationship: Record<string, string>;
}

function mapPerson(row: PeopleRow): PeopleRecord {
  return {
    id: row.id,
    kind: row.kind,
    email: row.email,
    displayName: row.display_name,
    actorId: row.actor_id ?? null,
    title: row.title ?? null,
    favorite: row.favorite,
    avatarDataUrl: safeAvatar(row.avatar_data_url),
    relationship: row.relationship,
  };
}

function safeAvatar(value: string | null): string | null {
  return value !== null &&
    value.length <= 350_000 &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u.test(value)
    ? value
    : null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/gu, (character) => `\\${character}`);
}
