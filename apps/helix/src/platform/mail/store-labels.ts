import { MAIL_LABEL_COLORS, type MailLabelColorName, mailLabelColorName } from "@helix/contracts";
import type postgres from "postgres";
import { ConflictError, ForbiddenError, NotFoundError } from "../../api/api-error.js";
import type { MailLabelRecord } from "./types.js";

interface MailLabelRow {
  readonly id: string;
  readonly org_id: string;
  readonly owner_actor_id: string | null;
  readonly parent_id: string | null;
  readonly slug: string;
  readonly name: string;
  readonly color: string;
  readonly sort_order: number;
  readonly thread_count: number;
  readonly unread_count: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface Mailbox {
  readonly orgId: string;
  /** Mailbox owner: the actor, or the delegator a delegate acts for. */
  readonly actorId: string;
}

/** Nesting deeper than this is refused; labels render as an indented tree. */
const MAX_LABEL_DEPTH = 5;

function mapLabel(row: MailLabelRow): MailLabelRecord {
  return {
    id: row.id,
    orgId: row.org_id,
    ownerActorId: row.owner_actor_id,
    parentId: row.parent_id,
    slug: row.slug,
    name: row.name,
    color: row.color,
    sortOrder: row.sort_order,
    threadCount: row.thread_count,
    unreadCount: row.unread_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  return slug.length > 0 ? slug : "label";
}

/** Personal label management plus the org-and-personal label listing. */
export class MailLabelStore {
  constructor(private readonly sql: postgres.Sql) {}

  listLabels(input: Mailbox): Promise<readonly MailLabelRecord[]> {
    return selectLabels(this.sql, input);
  }

  async createLabel(
    input: Mailbox & {
      readonly name: string;
      readonly color: MailLabelColorName;
      readonly parentId: string | null;
    },
  ): Promise<MailLabelRecord> {
    return this.sql.begin(async (tx) => {
      await lockMailbox(tx, input);
      if (input.parentId !== null) await requireParent(tx, input, input.parentId, null);
      await requireUniqueName(tx, input, input.name, input.parentId, null);
      const slug = await availableSlug(tx, input, slugify(input.name));
      const rows = await tx<{ readonly id: string }[]>`
        insert into mail_labels (org_id, owner_actor_id, parent_id, slug, name, color)
        values (
          ${input.orgId}, ${input.actorId}, ${input.parentId}, ${slug}, ${input.name},
          ${MAIL_LABEL_COLORS[input.color]}
        )
        returning id
      `;
      return requireLabel(tx, input, rows[0]?.id ?? "");
    });
  }

  async updateLabel(
    input: Mailbox & {
      readonly id: string;
      readonly name?: string | undefined;
      readonly color?: MailLabelColorName | undefined;
      readonly parentId?: string | null | undefined;
    },
  ): Promise<MailLabelRecord> {
    return this.sql.begin(async (tx) => {
      await lockMailbox(tx, input);
      const current = await requirePersonalLabel(tx, input, input.id);
      const parentId = input.parentId === undefined ? current.parent_id : input.parentId;
      if (parentId !== null && parentId !== current.parent_id)
        await requireParent(tx, input, parentId, input.id);
      const name = input.name ?? current.name;
      await requireUniqueName(tx, input, name, parentId, input.id);
      await tx`
        update mail_labels
        set name = ${name},
          color = ${MAIL_LABEL_COLORS[input.color ?? mailLabelColorName(current.color)]},
          parent_id = ${parentId},
          updated_at = now()
        where org_id = ${input.orgId} and id = ${input.id}
      `;
      return requireLabel(tx, input, input.id);
    });
  }

  /** Soft-delete a personal label and its nested labels and unapply them from threads. */
  async deleteLabel(input: Mailbox & { readonly id: string }): Promise<readonly string[]> {
    return this.sql.begin(async (tx) => {
      await lockMailbox(tx, input);
      await requirePersonalLabel(tx, input, input.id);
      const removed = await tx<{ readonly id: string; readonly slug: string }[]>`
        with recursive tree as (
          select id from mail_labels
          where org_id = ${input.orgId} and id = ${input.id}
          union all
          select child.id from mail_labels child
          join tree on child.parent_id = tree.id
          where child.org_id = ${input.orgId} and child.deleted_at is null
        )
        update mail_labels
        set deleted_at = now(), updated_at = now()
        where org_id = ${input.orgId} and id in (select id from tree)
        returning id, slug
      `;
      const slugs = removed.map((label) => label.slug.toLowerCase());
      await tx`
        update mail_thread_state
        set labels = array(
              select applied from unnest(labels) applied
              where lower(applied) <> all(${tx.array(slugs)}::text[])
            ),
          updated_at = now()
        where org_id = ${input.orgId}
          and actor_id = ${input.actorId}
          and exists (
            select 1 from unnest(labels) applied
            where lower(applied) = any(${tx.array(slugs)}::text[])
          )
      `;
      return removed.map((label) => label.id);
    });
  }
}

async function selectLabels(
  sql: postgres.Sql | postgres.TransactionSql,
  input: Mailbox,
): Promise<readonly MailLabelRecord[]> {
  const rows = await sql<MailLabelRow[]>`
      select
        l.id, l.org_id, l.owner_actor_id, l.parent_id, l.slug, l.name, l.color, l.sort_order,
        l.created_at, l.updated_at,
        coalesce((
          select count(*)::int
          from mail_thread_state mts
          where mts.actor_id = ${input.actorId}
            and mts.org_id = ${input.orgId}
            and mts.deleted_at is null
            and l.slug = any(mts.labels)
        ), 0) as thread_count,
        coalesce((
          select count(*)::int
          from mail_thread_state mts
          where mts.actor_id = ${input.actorId}
            and mts.org_id = ${input.orgId}
            and mts.deleted_at is null
            and mts.spam_at is null
            and l.slug = any(mts.labels)
            and (mts.read_at is null or mts.read_at < (
              select max(latest.sent_at) from messages latest
              where latest.thread_id = mts.thread_id and latest.org_id = mts.org_id
                and latest.kind = 'mail' and latest.deleted_at is null
            ))
        ), 0) as unread_count
      from mail_labels l
      where l.org_id = ${input.orgId}
        and l.deleted_at is null
        and (l.owner_actor_id is null or l.owner_actor_id = ${input.actorId})
      order by l.sort_order asc, lower(l.name) asc
    `;
  return rows.map(mapLabel);
}

async function requireLabel(
  tx: postgres.TransactionSql,
  mailbox: Mailbox,
  id: string,
): Promise<MailLabelRecord> {
  const label = (await selectLabels(tx, mailbox)).find((candidate) => candidate.id === id);
  if (label === undefined) throw new NotFoundError("Label not found.");
  return label;
}

/** Serialize label edits per mailbox so name, slug and tree checks hold. */
async function lockMailbox(tx: postgres.TransactionSql, mailbox: Mailbox): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`mail-labels:${mailbox.orgId}:${mailbox.actorId}`}, 0))`;
}

async function requirePersonalLabel(
  tx: postgres.TransactionSql,
  mailbox: Mailbox,
  id: string,
): Promise<{
  readonly name: string;
  readonly color: string;
  readonly parent_id: string | null;
}> {
  const rows = await tx<
    {
      readonly owner_actor_id: string | null;
      readonly name: string;
      readonly color: string;
      readonly parent_id: string | null;
    }[]
  >`
    select owner_actor_id, name, color, parent_id from mail_labels
    where org_id = ${mailbox.orgId} and id = ${id} and deleted_at is null
      and (owner_actor_id is null or owner_actor_id = ${mailbox.actorId})
  `;
  const label = rows[0];
  if (label === undefined) throw new NotFoundError("Label not found.");
  if (label.owner_actor_id === null)
    throw new ForbiddenError(
      "Organization labels are managed by administrators; create a personal label instead.",
    );
  return label;
}

async function requireParent(
  tx: postgres.TransactionSql,
  mailbox: Mailbox,
  parentId: string,
  labelId: string | null,
): Promise<void> {
  const ancestors = await tx<{ readonly id: string; readonly owner_actor_id: string | null }[]>`
    with recursive chain as (
      select id, parent_id, owner_actor_id, 1 as depth from mail_labels
      where org_id = ${mailbox.orgId} and id = ${parentId} and deleted_at is null
      union all
      select parent.id, parent.parent_id, parent.owner_actor_id, chain.depth + 1
      from mail_labels parent
      join chain on parent.id = chain.parent_id
      where parent.org_id = ${mailbox.orgId} and chain.depth < ${MAX_LABEL_DEPTH + 1}
    )
    select id, owner_actor_id from chain
  `;
  if (ancestors[0]?.owner_actor_id !== mailbox.actorId)
    throw new NotFoundError("Parent label not found; nest labels under one of your own labels.");
  if (labelId !== null && ancestors.some((ancestor) => ancestor.id === labelId))
    throw new ConflictError("A label cannot be nested under itself or one of its sublabels.");
  if (ancestors.length >= MAX_LABEL_DEPTH)
    throw new ConflictError(`Labels can be nested at most ${String(MAX_LABEL_DEPTH)} levels deep.`);
}

async function requireUniqueName(
  tx: postgres.TransactionSql,
  mailbox: Mailbox,
  name: string,
  parentId: string | null,
  labelId: string | null,
): Promise<void> {
  const rows = await tx`
    select 1 from mail_labels
    where org_id = ${mailbox.orgId} and deleted_at is null
      and (owner_actor_id is null or owner_actor_id = ${mailbox.actorId})
      and parent_id is not distinct from ${parentId}::uuid
      and lower(name) = lower(${name})
      and (${labelId}::uuid is null or id <> ${labelId}::uuid)
    limit 1
  `;
  if (rows.length > 0)
    throw new ConflictError(`A label named "${name}" already exists here; choose another name.`);
}

async function availableSlug(
  tx: postgres.TransactionSql,
  mailbox: Mailbox,
  base: string,
): Promise<string> {
  const taken = new Set(
    (
      await tx<{ readonly slug: string }[]>`
        select lower(slug) as slug from mail_labels
        where org_id = ${mailbox.orgId} and deleted_at is null
          and (owner_actor_id is null or owner_actor_id = ${mailbox.actorId})
          and lower(slug) like ${`${base.replaceAll(/[\\%_]/gu, (match) => `\\${match}`)}%`}
      `
    ).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`;
    if (!taken.has(candidate)) return candidate;
  }
}
