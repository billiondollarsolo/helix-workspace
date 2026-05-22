import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import { grantObjectAccess } from "../permissions/grant-object-access.js";
import { parseSlideContent } from "./content.js";
import type {
  SlideContent,
  SlideDeckRecord,
  SlideDeckSummaryRecord,
  SlideLayout,
  SlideRecord,
} from "./types.js";

export interface CreateSlideDeckInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly title: string;
  readonly metadata?: JsonObject | undefined;
  readonly folderId?: string | null | undefined;
}

export interface UpdateSlideDeckInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly deckId: string;
  readonly title?: string | undefined;
  readonly metadata?: JsonObject | undefined;
}

export interface ListSlideDecksInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly query?: string | undefined;
  readonly limit: number;
  readonly offset: number;
}

export interface ListSlideDecksResult {
  readonly decks: readonly SlideDeckSummaryRecord[];
  readonly total: number;
}

export interface CreateSlideInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly deckId: string;
  readonly content: SlideContent;
  readonly speakerNotes?: string | undefined;
  /** Insert position; appended to the end of the deck when omitted. */
  readonly position?: number | undefined;
}

export interface UpdateSlideInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly slideId: string;
  readonly content?: SlideContent | undefined;
  readonly speakerNotes?: string | undefined;
}

export interface DeleteSlideInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly slideId: string;
}

export interface ReorderSlidesInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly deckId: string;
  /** The complete set of slide ids in the deck, in their new order. */
  readonly slideIds: readonly string[];
}

export interface SlidesStore {
  createDeck(input: CreateSlideDeckInput): Promise<SlideDeckSummaryRecord>;
  listDecksForActor(input: ListSlideDecksInput): Promise<ListSlideDecksResult>;
  getDeckForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly deckId: string;
  }): Promise<{ readonly deck: SlideDeckSummaryRecord; readonly slides: readonly SlideRecord[] } | null>;
  updateDeck(input: UpdateSlideDeckInput): Promise<SlideDeckSummaryRecord | null>;
  deleteDeck(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly deckId: string;
  }): Promise<boolean>;
  createSlide(input: CreateSlideInput): Promise<SlideRecord>;
  updateSlide(input: UpdateSlideInput): Promise<SlideRecord | null>;
  deleteSlide(input: DeleteSlideInput): Promise<boolean>;
  reorderSlides(input: ReorderSlidesInput): Promise<readonly SlideRecord[]>;
}

interface SlideDeckRow {
  readonly id: string;
  readonly org_id: string;
  readonly title: string;
  readonly owner_actor_id: string | null;
  readonly created_by_actor_id: string | null;
  readonly metadata: JsonObject;
  readonly deleted_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface SlideDeckSummaryRow extends SlideDeckRow {
  readonly slide_count: string | number;
}

interface SlideRow {
  readonly id: string;
  readonly org_id: string;
  readonly deck_id: string;
  readonly position: number;
  readonly layout: string;
  readonly content: JsonObject;
  readonly speaker_notes: string;
  readonly created_at: Date;
  readonly updated_at: Date;
}

type SqlLike = postgres.Sql | postgres.TransactionSql;

/**
 * Postgres-backed Slides store. All deck-scoped operations are authz-gated:
 * an actor may only read or mutate a deck they own (or created). Mutations are
 * appended to the org-wide hash-chained `activity` log and emitted on the
 * `outbox` so downstream consumers (search, webhooks) stay consistent.
 */
export class PostgresSlidesStore implements SlidesStore {
  constructor(private readonly sql: postgres.Sql) {}

  async createDeck(input: CreateSlideDeckInput): Promise<SlideDeckSummaryRecord> {
    return this.sql.begin(async (tx) => {
      const rows = (await tx`
        insert into slide_decks (org_id, title, owner_actor_id, created_by_actor_id, metadata)
        values (
          ${input.orgId},
          ${input.title},
          ${input.actorId},
          ${input.actorId},
          ${tx.json(toSqlJson(input.metadata ?? {}))}
        )
        returning *
      `) as unknown as readonly SlideDeckRow[];
      const deck = mapDeck(rows[0]);
      await tx`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
        values (
          ${deck.id}, ${input.orgId}, ${input.actorId}, 'file',
          ${`slides/${input.orgId}/${deck.id}`},
          'application/vnd.helix.presentation', 0, null,
          ${tx.json(toSqlJson({ ...(input.metadata ?? {}), app: "slides", deckId: deck.id, name: input.title.trim(), title: input.title.trim(), folderId: input.folderId ?? null }))}
        )
        on conflict (id) do update set metadata = excluded.metadata, updated_at = now()
      `;
      await grantObjectAccess(tx, {
        orgId: input.orgId,
        objectId: deck.id,
        actorId: input.actorId,
        role: "owner",
        grantedByActorId: input.actorId,
      });
      await appendSlidesActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "slides.deck.created",
        deckId: deck.id,
        payload: { title: input.title },
      });
      return { ...deck, slideCount: 0 };
    });
  }

  async listDecksForActor(input: ListSlideDecksInput): Promise<ListSlideDecksResult> {
    const query = input.query?.trim();
    const titleQuery = query === undefined || query.length === 0 ? null : `%${query}%`;
    const rows = (await this.sql`
      select
        d.*,
        count(s.id) filter (where s.id is not null) as slide_count,
        count(*) over () as total_count
      from slide_decks d
      left join slides s on s.deck_id = d.id
      where d.org_id = ${input.orgId}
        and d.deleted_at is null
        and (
          d.owner_actor_id = ${input.actorId}
          or d.created_by_actor_id = ${input.actorId}
        )
        and (${titleQuery}::text is null or d.title ilike ${titleQuery})
      group by d.id
      order by d.updated_at desc
      limit ${input.limit}
      offset ${input.offset}
    `) as unknown as readonly (SlideDeckSummaryRow & { readonly total_count: string | number })[];
    return {
      decks: rows.map(mapDeckSummary),
      total: rows[0] === undefined ? 0 : Number(rows[0].total_count),
    };
  }

  async getDeckForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly deckId: string;
  }): Promise<{ readonly deck: SlideDeckSummaryRecord; readonly slides: readonly SlideRecord[] } | null> {
    const deck = await selectDeckForActor(this.sql, input.orgId, input.actorId, input.deckId);
    if (deck === null) {
      return null;
    }
    const slideRows = (await this.sql`
      select *
      from slides
      where org_id = ${input.orgId}
        and deck_id = ${input.deckId}
      order by position asc
    `) as unknown as readonly SlideRow[];
    const mappedSlides = slideRows.map(mapSlide);
    return { deck: { ...deck, slideCount: mappedSlides.length }, slides: mappedSlides };
  }

  async updateDeck(input: UpdateSlideDeckInput): Promise<SlideDeckSummaryRecord | null> {
    return this.sql.begin(async (tx) => {
      const existing = await selectDeckForActor(tx, input.orgId, input.actorId, input.deckId);
      if (existing === null) {
        return null;
      }
      const nextTitle = input.title ?? existing.title;
      const nextMetadata = input.metadata ?? existing.metadata;
      const rows = (await tx`
        update slide_decks
        set
          title = ${nextTitle},
          metadata = ${tx.json(toSqlJson(nextMetadata))},
          updated_at = now()
        where id = ${input.deckId}
          and org_id = ${input.orgId}
          and deleted_at is null
        returning *
      `) as unknown as readonly SlideDeckRow[];
      if (rows[0] === undefined) {
        return null;
      }
      const deck = mapDeck(rows[0]);
      await appendSlidesActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "slides.deck.updated",
        deckId: deck.id,
        payload: { title: deck.title },
      });
      const countRows = (await tx`
        select count(*)::int as slide_count from slides where deck_id = ${input.deckId}
      `) as unknown as readonly { readonly slide_count: number }[];
      return { ...deck, slideCount: countRows[0]?.slide_count ?? 0 };
    });
  }

  async deleteDeck(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly deckId: string;
  }): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const existing = await selectDeckForActor(tx, input.orgId, input.actorId, input.deckId);
      if (existing === null) {
        return false;
      }
      const rows = (await tx`
        update slide_decks
        set deleted_at = now(), updated_at = now()
        where id = ${input.deckId}
          and org_id = ${input.orgId}
          and deleted_at is null
        returning id
      `) as unknown as readonly { readonly id: string }[];
      if (rows[0] === undefined) {
        return false;
      }
      await appendSlidesActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "slides.deck.deleted",
        deckId: input.deckId,
        payload: {},
      });
      return true;
    });
  }

  async createSlide(input: CreateSlideInput): Promise<SlideRecord> {
    return this.sql.begin(async (tx) => {
      await requireDeckAccess(tx, input.orgId, input.actorId, input.deckId);
      const countRows = (await tx`
        select count(*)::int as slide_count from slides where deck_id = ${input.deckId}
      `) as unknown as readonly { readonly slide_count: number }[];
      const slideCount = countRows[0]?.slide_count ?? 0;
      const targetPosition =
        input.position === undefined
          ? slideCount
          : Math.max(0, Math.min(input.position, slideCount));

      if (targetPosition < slideCount) {
        // Open a gap: shift trailing slides down by one. The unique
        // (deck_id, position) index requires a temporary negative offset so
        // the in-place renumber never collides mid-update.
        await tx`
          update slides
          set position = -1 - position, updated_at = now()
          where deck_id = ${input.deckId} and position >= ${targetPosition}
        `;
        await tx`
          update slides
          set position = (-1 - position) + 1, updated_at = now()
          where deck_id = ${input.deckId} and position < 0
        `;
      }

      const rows = (await tx`
        insert into slides (org_id, deck_id, position, layout, content, speaker_notes)
        values (
          ${input.orgId},
          ${input.deckId},
          ${targetPosition},
          ${input.content.layout},
          ${tx.json(toSqlJson(input.content))},
          ${input.speakerNotes ?? ""}
        )
        returning *
      `) as unknown as readonly SlideRow[];
      const slide = mapSlide(rows[0]);
      await touchDeck(tx, input.orgId, input.deckId);
      await appendSlidesActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "slides.slide.created",
        deckId: input.deckId,
        payload: { slideId: slide.id, layout: slide.layout, position: slide.position },
      });
      return slide;
    });
  }

  async updateSlide(input: UpdateSlideInput): Promise<SlideRecord | null> {
    return this.sql.begin(async (tx) => {
      const existing = await selectSlideForActor(tx, input.orgId, input.actorId, input.slideId);
      if (existing === null) {
        return null;
      }
      const nextContent = input.content ?? existing.content;
      const nextNotes = input.speakerNotes ?? existing.speakerNotes;
      const rows = (await tx`
        update slides
        set
          layout = ${nextContent.layout},
          content = ${tx.json(toSqlJson(nextContent))},
          speaker_notes = ${nextNotes},
          updated_at = now()
        where id = ${input.slideId}
          and org_id = ${input.orgId}
        returning *
      `) as unknown as readonly SlideRow[];
      if (rows[0] === undefined) {
        return null;
      }
      const slide = mapSlide(rows[0]);
      await touchDeck(tx, input.orgId, slide.deckId);
      await appendSlidesActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "slides.slide.updated",
        deckId: slide.deckId,
        payload: { slideId: slide.id, layout: slide.layout },
      });
      return slide;
    });
  }

  async deleteSlide(input: DeleteSlideInput): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const existing = await selectSlideForActor(tx, input.orgId, input.actorId, input.slideId);
      if (existing === null) {
        return false;
      }
      await tx`
        delete from slides where id = ${input.slideId} and org_id = ${input.orgId}
      `;
      // Close the position gap left by the removed slide.
      await tx`
        update slides
        set position = position - 1, updated_at = now()
        where deck_id = ${existing.deckId} and position > ${existing.position}
      `;
      await touchDeck(tx, input.orgId, existing.deckId);
      await appendSlidesActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "slides.slide.deleted",
        deckId: existing.deckId,
        payload: { slideId: input.slideId },
      });
      return true;
    });
  }

  async reorderSlides(input: ReorderSlidesInput): Promise<readonly SlideRecord[]> {
    return this.sql.begin(async (tx) => {
      await requireDeckAccess(tx, input.orgId, input.actorId, input.deckId);
      const currentRows = (await tx`
        select id from slides where deck_id = ${input.deckId} and org_id = ${input.orgId}
      `) as unknown as readonly { readonly id: string }[];
      const currentIds = new Set(currentRows.map((row) => row.id));
      const requested = new Set(input.slideIds);
      if (
        currentIds.size !== requested.size ||
        [...currentIds].some((id) => !requested.has(id))
      ) {
        throw new Error("Reorder must list every slide in the deck exactly once.");
      }

      // Two-phase renumber to avoid colliding with the unique
      // (deck_id, position) index while positions are in flux.
      await tx`
        update slides
        set position = -1 - position, updated_at = now()
        where deck_id = ${input.deckId} and org_id = ${input.orgId}
      `;
      for (const [index, slideId] of input.slideIds.entries()) {
        await tx`
          update slides
          set position = ${index}, updated_at = now()
          where id = ${slideId} and deck_id = ${input.deckId} and org_id = ${input.orgId}
        `;
      }
      await touchDeck(tx, input.orgId, input.deckId);
      await appendSlidesActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "slides.slide.reordered",
        deckId: input.deckId,
        payload: { order: [...input.slideIds] },
      });
      const rows = (await tx`
        select *
        from slides
        where deck_id = ${input.deckId} and org_id = ${input.orgId}
        order by position asc
      `) as unknown as readonly SlideRow[];
      return rows.map(mapSlide);
    });
  }
}

async function selectDeckForActor(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  deckId: string,
): Promise<SlideDeckRecord | null> {
  const rows = (await sql`
    select *
    from slide_decks
    where id = ${deckId}
      and org_id = ${orgId}
      and deleted_at is null
      and (owner_actor_id = ${actorId} or created_by_actor_id = ${actorId})
    limit 1
  `) as unknown as readonly SlideDeckRow[];
  return rows[0] === undefined ? null : mapDeck(rows[0]);
}

async function requireDeckAccess(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  deckId: string,
): Promise<void> {
  const deck = await selectDeckForActor(sql, orgId, actorId, deckId);
  if (deck === null) {
    throw new Error(`Unknown or inaccessible deck: ${deckId}`);
  }
}

async function selectSlideForActor(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  slideId: string,
): Promise<SlideRecord | null> {
  const rows = (await sql`
    select s.*
    from slides s
    join slide_decks d on d.id = s.deck_id
    where s.id = ${slideId}
      and s.org_id = ${orgId}
      and d.deleted_at is null
      and (d.owner_actor_id = ${actorId} or d.created_by_actor_id = ${actorId})
    limit 1
  `) as unknown as readonly SlideRow[];
  return rows[0] === undefined ? null : mapSlide(rows[0]);
}

async function touchDeck(sql: SqlLike, orgId: string, deckId: string): Promise<void> {
  await sql`
    update slide_decks set updated_at = now() where id = ${deckId} and org_id = ${orgId}
  `;
}

async function appendSlidesActivity(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly verb: string;
    readonly deckId: string;
    readonly payload: JsonObject;
  },
): Promise<void> {
  const previousRows = (await sql`
    select this_hash
    from activity
    where org_id = ${input.orgId}
    order by created_at desc
    limit 1
  `) as unknown as readonly { readonly this_hash: string }[];
  const prevHash = previousRows[0]?.this_hash ?? null;
  const thisHash = `${prevHash ?? "root"}:${input.verb}:${input.deckId}:${String(Date.now())}`;
  await sql`
    insert into activity (org_id, actor_id, verb, object_type, object_id, payload, prev_hash, this_hash)
    values (
      ${input.orgId},
      ${input.actorId},
      ${input.verb},
      'slide_deck',
      ${input.deckId},
      ${sql.json(toSqlJson(input.payload))},
      ${prevHash},
      ${thisHash}
    )
  `;
  await sql`
    insert into outbox (subject, payload)
    values (${`activity.${input.verb}`}, ${sql.json(
      toSqlJson({
        orgId: input.orgId,
        actorId: input.actorId,
        deckId: input.deckId,
        ...input.payload,
      }),
    )})
  `;
}

function mapDeck(row: SlideDeckRow | undefined): SlideDeckRecord {
  if (row === undefined) {
    throw new Error("Expected slide deck row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    title: row.title,
    ownerActorId: row.owner_actor_id,
    createdByActorId: row.created_by_actor_id,
    metadata: row.metadata,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDeckSummary(row: SlideDeckSummaryRow): SlideDeckSummaryRecord {
  return { ...mapDeck(row), slideCount: Number(row.slide_count) };
}

function mapSlide(row: SlideRow | undefined): SlideRecord {
  if (row === undefined) {
    throw new Error("Expected slide row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    deckId: row.deck_id,
    position: row.position,
    layout: normalizeLayout(row.layout),
    content: parseSlideContent(row.content),
    speakerNotes: row.speaker_notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeLayout(value: string): SlideLayout {
  switch (value) {
    case "title":
    case "agenda":
    case "stats":
    case "split":
    case "bullets":
    case "image":
      return value;
    default:
      throw new Error(`Unknown slide layout: ${value}`);
  }
}

function toSqlJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

/* -------------------------------------------------------------------------- */
/* In-memory store (tests / offline)                                          */
/* -------------------------------------------------------------------------- */

interface InMemoryDeck {
  deck: SlideDeckRecord;
}

/**
 * In-memory {@link SlidesStore} for unit tests and offline development. Mirrors
 * the Postgres store's authz and position-management semantics without a
 * database. Not concurrency-safe — intended for single-threaded test use.
 */
export class InMemorySlidesStore implements SlidesStore {
  private readonly decks = new Map<string, InMemoryDeck>();
  private readonly slides = new Map<string, SlideRecord>();

  async createDeck(input: CreateSlideDeckInput): Promise<SlideDeckSummaryRecord> {
    const now = new Date();
    const deck: SlideDeckRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      title: input.title,
      ownerActorId: input.actorId,
      createdByActorId: input.actorId,
      metadata: {
        ...(input.metadata ?? {}),
        app: "slides",
        folderId: input.folderId ?? null,
      },
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.decks.set(deck.id, { deck });
    return { ...deck, slideCount: 0 };
  }

  async listDecksForActor(input: ListSlideDecksInput): Promise<ListSlideDecksResult> {
    const query = input.query?.trim().toLowerCase();
    const all = [...this.decks.values()]
      .map((entry) => entry.deck)
      .filter(
        (deck) =>
          deck.orgId === input.orgId &&
          deck.deletedAt === null &&
          (deck.ownerActorId === input.actorId || deck.createdByActorId === input.actorId) &&
          (query === undefined ||
            query.length === 0 ||
            deck.title.toLowerCase().includes(query)),
      )
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
    const page = all.slice(input.offset, input.offset + input.limit);
    return {
      decks: page.map((deck) => ({ ...deck, slideCount: this.slidesOf(deck.id).length })),
      total: all.length,
    };
  }

  async getDeckForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly deckId: string;
  }): Promise<{ readonly deck: SlideDeckSummaryRecord; readonly slides: readonly SlideRecord[] } | null> {
    const deck = this.accessibleDeck(input.orgId, input.actorId, input.deckId);
    if (deck === null) {
      return null;
    }
    const slides = this.slidesOf(deck.id);
    return { deck: { ...deck, slideCount: slides.length }, slides };
  }

  async updateDeck(input: UpdateSlideDeckInput): Promise<SlideDeckSummaryRecord | null> {
    const deck = this.accessibleDeck(input.orgId, input.actorId, input.deckId);
    if (deck === null) {
      return null;
    }
    const updated: SlideDeckRecord = {
      ...deck,
      title: input.title ?? deck.title,
      metadata: input.metadata ?? deck.metadata,
      updatedAt: new Date(),
    };
    this.decks.set(updated.id, { deck: updated });
    return { ...updated, slideCount: this.slidesOf(updated.id).length };
  }

  async deleteDeck(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly deckId: string;
  }): Promise<boolean> {
    const deck = this.accessibleDeck(input.orgId, input.actorId, input.deckId);
    if (deck === null) {
      return false;
    }
    this.decks.set(deck.id, { deck: { ...deck, deletedAt: new Date(), updatedAt: new Date() } });
    return true;
  }

  async createSlide(input: CreateSlideInput): Promise<SlideRecord> {
    const deck = this.accessibleDeck(input.orgId, input.actorId, input.deckId);
    if (deck === null) {
      throw new Error(`Unknown or inaccessible deck: ${input.deckId}`);
    }
    const existing = this.slidesOf(input.deckId);
    const targetPosition =
      input.position === undefined
        ? existing.length
        : Math.max(0, Math.min(input.position, existing.length));
    for (const slide of existing) {
      if (slide.position >= targetPosition) {
        this.slides.set(slide.id, { ...slide, position: slide.position + 1 });
      }
    }
    const now = new Date();
    const slide: SlideRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      deckId: input.deckId,
      position: targetPosition,
      layout: input.content.layout,
      content: input.content,
      speakerNotes: input.speakerNotes ?? "",
      createdAt: now,
      updatedAt: now,
    };
    this.slides.set(slide.id, slide);
    this.touch(input.deckId);
    return slide;
  }

  async updateSlide(input: UpdateSlideInput): Promise<SlideRecord | null> {
    const slide = this.accessibleSlide(input.orgId, input.actorId, input.slideId);
    if (slide === null) {
      return null;
    }
    const nextContent = input.content ?? slide.content;
    const updated: SlideRecord = {
      ...slide,
      layout: nextContent.layout,
      content: nextContent,
      speakerNotes: input.speakerNotes ?? slide.speakerNotes,
      updatedAt: new Date(),
    };
    this.slides.set(updated.id, updated);
    this.touch(updated.deckId);
    return updated;
  }

  async deleteSlide(input: DeleteSlideInput): Promise<boolean> {
    const slide = this.accessibleSlide(input.orgId, input.actorId, input.slideId);
    if (slide === null) {
      return false;
    }
    this.slides.delete(slide.id);
    for (const other of this.slidesOf(slide.deckId)) {
      if (other.position > slide.position) {
        this.slides.set(other.id, { ...other, position: other.position - 1 });
      }
    }
    this.touch(slide.deckId);
    return true;
  }

  async reorderSlides(input: ReorderSlidesInput): Promise<readonly SlideRecord[]> {
    const deck = this.accessibleDeck(input.orgId, input.actorId, input.deckId);
    if (deck === null) {
      throw new Error(`Unknown or inaccessible deck: ${input.deckId}`);
    }
    const current = this.slidesOf(input.deckId);
    const currentIds = new Set(current.map((slide) => slide.id));
    const requested = new Set(input.slideIds);
    if (
      currentIds.size !== requested.size ||
      [...currentIds].some((id) => !requested.has(id))
    ) {
      throw new Error("Reorder must list every slide in the deck exactly once.");
    }
    for (const [index, slideId] of input.slideIds.entries()) {
      const slide = this.slides.get(slideId);
      if (slide !== undefined) {
        this.slides.set(slideId, { ...slide, position: index, updatedAt: new Date() });
      }
    }
    this.touch(input.deckId);
    return this.slidesOf(input.deckId);
  }

  private slidesOf(deckId: string): SlideRecord[] {
    return [...this.slides.values()]
      .filter((slide) => slide.deckId === deckId)
      .sort((left, right) => left.position - right.position);
  }

  private accessibleDeck(
    orgId: string,
    actorId: string,
    deckId: string,
  ): SlideDeckRecord | null {
    const entry = this.decks.get(deckId);
    if (entry === undefined) {
      return null;
    }
    const { deck } = entry;
    if (
      deck.orgId !== orgId ||
      deck.deletedAt !== null ||
      (deck.ownerActorId !== actorId && deck.createdByActorId !== actorId)
    ) {
      return null;
    }
    return deck;
  }

  private accessibleSlide(
    orgId: string,
    actorId: string,
    slideId: string,
  ): SlideRecord | null {
    const slide = this.slides.get(slideId);
    if (slide === undefined || slide.orgId !== orgId) {
      return null;
    }
    return this.accessibleDeck(orgId, actorId, slide.deckId) === null ? null : slide;
  }

  private touch(deckId: string): void {
    const entry = this.decks.get(deckId);
    if (entry !== undefined) {
      this.decks.set(deckId, { deck: { ...entry.deck, updatedAt: new Date() } });
    }
  }
}
