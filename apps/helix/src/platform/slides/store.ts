import { createHash, randomUUID } from "node:crypto";
import type postgres from "postgres";
import type { JsonObject } from "@helix/sdk-types";
import { grantObjectAccess } from "../permissions/grant-object-access.js";
import type { TenantStorageResolver } from "../storage/index.js";
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

export interface CopySlideDeckInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly deckId: string;
  readonly title?: string | undefined;
  readonly folderId?: string | null | undefined;
  readonly metadata?: JsonObject | undefined;
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

export interface SlideOperationLogRecord {
  readonly id: string;
  readonly orgId: string;
  readonly deckId: string;
  readonly actorId: string | null;
  readonly operationId: string;
  readonly revision: number;
  readonly baseRevision: number;
  readonly operation: JsonObject;
  readonly createdAt: Date;
}

export interface SlideDeckVersionRecord {
  readonly id: string;
  readonly orgId: string;
  readonly deckId: string;
  readonly versionNumber: number;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly byteSize: number;
  readonly sha256: string;
  readonly metadata: JsonObject;
  readonly createdByActorId: string | null;
  readonly createdAt: Date;
}

export interface ListSlideDeckVersionsInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly deckId: string;
  readonly limit: number;
}

export interface RestoreSlideDeckVersionInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly deckId: string;
  readonly versionId: string;
}

export interface AppendSlideOperationInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly deckId: string;
  readonly operationId: string;
  readonly baseRevision: number;
  readonly operation: JsonObject;
}

export type SlideSyncOperation =
  | {
      readonly kind: "update-deck";
      readonly title?: string | undefined;
      readonly metadata?: JsonObject | undefined;
    }
  | {
      readonly kind: "create-slide";
      readonly content: SlideContent;
      readonly speakerNotes?: string | undefined;
      readonly position?: number | undefined;
    }
  | {
      readonly kind: "update-slide";
      readonly slideId: string;
      readonly content?: SlideContent | undefined;
      readonly speakerNotes?: string | undefined;
      /**
       * Optional per-slide CAS token. When provided, the server rejects the
       * operation with `slide-conflict` if the slide's current revision is
       * higher (i.e. another writer mutated the slide first). Older clients
       * that omit this field still succeed but will silently last-write-win;
       * the frontend ships it on every edit.
       */
      readonly expectedRevision?: number | undefined;
    }
  | {
      readonly kind: "delete-slide";
      readonly slideId: string;
      /** See `update-slide.expectedRevision`. */
      readonly expectedRevision?: number | undefined;
    }
  | {
      readonly kind: "reorder-slides";
      readonly slideIds: readonly string[];
    };

export interface ApplySlideOperationInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly deckId: string;
  readonly operationId: string;
  readonly baseRevision: number;
  readonly operation: SlideSyncOperation;
}

export type ApplySlideOperationResult =
  | {
      readonly status: "applied";
      readonly operationId: string;
      readonly revision: number;
      readonly operation: SlideSyncOperation;
      readonly snapshot: {
        readonly deck: SlideDeckSummaryRecord;
        readonly slides: readonly SlideRecord[];
      };
    }
  | {
      readonly status: "duplicate";
      readonly operationId: string;
      readonly revision: number;
    }
  | {
      readonly status: "ahead";
      readonly operationId: string;
      readonly revision: number;
    }
  | {
      readonly status: "slide-conflict";
      readonly operationId: string;
      readonly revision: number;
      readonly slideId: string;
      readonly currentSlideRevision: number;
      readonly snapshot: {
        readonly deck: SlideDeckSummaryRecord;
        readonly slides: readonly SlideRecord[];
      };
    };

export interface SlidesStore {
  createDeck(input: CreateSlideDeckInput): Promise<SlideDeckSummaryRecord>;
  copyDeck(input: CopySlideDeckInput): Promise<{
    readonly deck: SlideDeckSummaryRecord;
    readonly slides: readonly SlideRecord[];
  } | null>;
  listDecksForActor(input: ListSlideDecksInput): Promise<ListSlideDecksResult>;
  getDeckForActor(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly deckId: string;
  }): Promise<{
    readonly deck: SlideDeckSummaryRecord;
    readonly slides: readonly SlideRecord[];
  } | null>;
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
  listOperations(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly deckId: string;
    readonly afterRevision?: number | undefined;
  }): Promise<readonly SlideOperationLogRecord[]>;
  appendOperation(input: AppendSlideOperationInput): Promise<SlideOperationLogRecord>;
  applyOperation(input: ApplySlideOperationInput): Promise<ApplySlideOperationResult>;
  listVersions(input: ListSlideDeckVersionsInput): Promise<readonly SlideDeckVersionRecord[]>;
  restoreVersion(input: RestoreSlideDeckVersionInput): Promise<{
    readonly deck: SlideDeckSummaryRecord;
    readonly slides: readonly SlideRecord[];
  } | null>;
}

interface SlideDeckVersionRow {
  readonly id: string;
  readonly org_id: string;
  readonly object_id: string;
  readonly version_number: number;
  readonly storage_key: string;
  readonly mime_type: string;
  readonly byte_size: number;
  readonly sha256: string;
  readonly metadata: JsonObject;
  readonly created_by_actor_id: string | null;
  readonly created_at: Date;
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
  readonly revision: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface SlideOperationLogRow {
  readonly id: string;
  readonly org_id: string;
  readonly deck_id: string;
  readonly actor_id: string | null;
  readonly operation_id: string;
  readonly revision: number;
  readonly base_revision: number;
  readonly operation: JsonObject;
  readonly created_at: Date;
}

type SqlLike = postgres.Sql | postgres.TransactionSql;

/**
 * Postgres-backed Slides store. All deck-scoped operations are authz-gated:
 * an actor may only read or mutate a deck they own (or created). Mutations are
 * appended to the org-wide hash-chained `activity` log and emitted on the
 * `outbox` so downstream consumers (search, webhooks) stay consistent.
 */
export class PostgresSlidesStore implements SlidesStore {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly options: { readonly storageResolver?: TenantStorageResolver | undefined } = {},
  ) {}

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
      const storageKey = `slides/${input.orgId}/${deck.id}`;
      const storedSnapshot = await writeSlideDeckStorageSnapshot({
        resolver: this.options.storageResolver,
        orgId: input.orgId,
        key: storageKey,
        deck,
      });
      const versionSnapshot = await writeSlideDeckStorageSnapshot({
        resolver: this.options.storageResolver,
        orgId: input.orgId,
        key: slideDeckSnapshotVersionStorageKey(input.orgId, deck.id, 1),
        deck,
      });
      await tx`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
        values (
          ${deck.id}, ${input.orgId}, ${input.actorId}, 'file',
          ${storageKey},
          'application/vnd.helix.presentation', ${storedSnapshot.byteSize}, ${storedSnapshot.sha256},
          ${tx.json(
            toSqlJson({
              ...(input.metadata ?? {}),
              app: "slides",
              deckId: deck.id,
              name: input.title.trim(),
              title: input.title.trim(),
              folderId: input.folderId ?? null,
              preview: nativeSlidesPreviewMetadata(deck, []),
            }),
          )}
        )
        on conflict (id) do update set
          byte_size = excluded.byte_size,
          sha256 = excluded.sha256,
          metadata = excluded.metadata,
          updated_at = now()
      `;
      await insertSlideDeckSnapshotVersion(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        deckId: deck.id,
        versionNumber: 1,
        storageKey: slideDeckSnapshotVersionStorageKey(input.orgId, deck.id, 1),
        byteSize: versionSnapshot.byteSize,
        sha256: versionSnapshot.sha256,
        metadata: { app: "slides", title: deck.title, slideCount: 0 },
      });
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

  async copyDeck(input: CopySlideDeckInput): Promise<{
    readonly deck: SlideDeckSummaryRecord;
    readonly slides: readonly SlideRecord[];
  } | null> {
    return this.sql.begin(async (tx) => {
      const source = await selectDeckForActor(tx, input.orgId, input.actorId, input.deckId);
      if (source === null) {
        return null;
      }
      const sourceSlides = await selectSlidesForDeck(tx, input.orgId, input.deckId);
      const sourceObjectRows = (await tx`
        select metadata
        from objects
        where id = ${input.deckId}
          and org_id = ${input.orgId}
          and metadata->>'app' = 'slides'
        limit 1
      `) as unknown as readonly { readonly metadata: JsonObject }[];
      const sourceFolderId = jsonStringOrNull(sourceObjectRows[0]?.metadata.folderId);
      const folderId = input.folderId === undefined ? sourceFolderId : input.folderId;
      const title = input.title?.trim() || `${source.title} (Copy)`;
      const metadata = {
        ...source.metadata,
        createdFrom: "slides.deck.copy",
        copiedFromDeckId: source.id,
        ...(input.metadata ?? {}),
      };
      const rows = (await tx`
        insert into slide_decks (org_id, title, owner_actor_id, created_by_actor_id, metadata)
        values (
          ${input.orgId},
          ${title},
          ${input.actorId},
          ${input.actorId},
          ${tx.json(toSqlJson(metadata))}
        )
        returning *
      `) as unknown as readonly SlideDeckRow[];
      const deck = mapDeck(rows[0]);
      const slides: SlideRecord[] = [];
      const now = new Date();
      for (const slide of sourceSlides) {
        const slideRows = (await tx`
          insert into slides (
            org_id, deck_id, position, layout, content, speaker_notes, revision, created_at, updated_at
          )
          values (
            ${input.orgId},
            ${deck.id},
            ${slide.position},
            ${slide.layout},
            ${tx.json(toSqlJson(slide.content))},
            ${slide.speakerNotes},
            1,
            ${now},
            ${now}
          )
          returning *
        `) as unknown as readonly SlideRow[];
        slides.push(mapSlide(slideRows[0]));
      }
      const storageKey = `slides/${input.orgId}/${deck.id}`;
      const storedSnapshot = await writeSlideDeckStorageSnapshot({
        resolver: this.options.storageResolver,
        orgId: input.orgId,
        key: storageKey,
        deck,
        slides,
      });
      const versionSnapshot = await writeSlideDeckStorageSnapshot({
        resolver: this.options.storageResolver,
        orgId: input.orgId,
        key: slideDeckSnapshotVersionStorageKey(input.orgId, deck.id, 1),
        deck,
        slides,
      });
      await tx`
        insert into objects (id, org_id, owner_actor_id, kind, storage_key, mime_type, byte_size, sha256, metadata)
        values (
          ${deck.id}, ${input.orgId}, ${input.actorId}, 'file',
          ${storageKey},
          'application/vnd.helix.presentation', ${storedSnapshot.byteSize}, ${storedSnapshot.sha256},
          ${tx.json(
            toSqlJson({
              ...metadata,
              app: "slides",
              deckId: deck.id,
              name: title,
              title,
              folderId: folderId ?? null,
              preview: nativeSlidesPreviewMetadata(deck, slides),
            }),
          )}
        )
        on conflict (id) do update set
          byte_size = excluded.byte_size,
          sha256 = excluded.sha256,
          metadata = excluded.metadata,
          updated_at = now()
      `;
      await insertSlideDeckSnapshotVersion(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        deckId: deck.id,
        versionNumber: 1,
        storageKey: slideDeckSnapshotVersionStorageKey(input.orgId, deck.id, 1),
        byteSize: versionSnapshot.byteSize,
        sha256: versionSnapshot.sha256,
        metadata: {
          app: "slides",
          title,
          slideCount: slides.length,
          copiedFromDeckId: source.id,
        },
      });
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
        verb: "slides.deck.copied",
        deckId: deck.id,
        payload: { title, copiedFromDeckId: source.id, slideCount: slides.length },
      });
      return { deck: { ...deck, slideCount: slides.length }, slides };
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
  }): Promise<{
    readonly deck: SlideDeckSummaryRecord;
    readonly slides: readonly SlideRecord[];
  } | null> {
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
      await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, input.deckId);
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
      await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, input.deckId);
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
          revision = revision + 1,
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
      await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, slide.deckId);
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
      await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, existing.deckId);
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
      if (currentIds.size !== requested.size || [...currentIds].some((id) => !requested.has(id))) {
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
      await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, input.deckId);
      const rows = (await tx`
        select *
        from slides
        where deck_id = ${input.deckId} and org_id = ${input.orgId}
        order by position asc
      `) as unknown as readonly SlideRow[];
      return rows.map(mapSlide);
    });
  }

  async listOperations(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly deckId: string;
    readonly afterRevision?: number | undefined;
  }): Promise<readonly SlideOperationLogRecord[]> {
    const deck = await selectDeckForActor(this.sql, input.orgId, input.actorId, input.deckId);
    if (deck === null) {
      return [];
    }
    const rows = (await this.sql`
      select *
      from slides_op_log
      where org_id = ${input.orgId}
        and deck_id = ${input.deckId}
        and revision > ${input.afterRevision ?? 0}
      order by revision asc
    `) as unknown as readonly SlideOperationLogRow[];
    return rows.map(mapSlideOperationLog);
  }

  async appendOperation(input: AppendSlideOperationInput): Promise<SlideOperationLogRecord> {
    return this.sql.begin(async (tx) => {
      await requireDeckAccess(tx, input.orgId, input.actorId, input.deckId);
      const existingRows = (await tx`
        select *
        from slides_op_log
        where org_id = ${input.orgId}
          and deck_id = ${input.deckId}
          and operation_id = ${input.operationId}
        limit 1
      `) as unknown as readonly SlideOperationLogRow[];
      if (existingRows[0] !== undefined) {
        return mapSlideOperationLog(existingRows[0]);
      }
      const rows = (await tx`
        insert into slides_op_log (
          org_id, deck_id, actor_id, operation_id, revision, base_revision, operation
        )
        values (
          ${input.orgId},
          ${input.deckId},
          ${input.actorId},
          ${input.operationId},
          (
            select coalesce(max(revision) + 1, 1)::int
            from slides_op_log
            where org_id = ${input.orgId} and deck_id = ${input.deckId}
          ),
          ${input.baseRevision},
          ${tx.json(toSqlJson(input.operation))}
        )
        returning *
      `) as unknown as readonly SlideOperationLogRow[];
      return mapSlideOperationLog(rows[0]);
    });
  }

  async applyOperation(input: ApplySlideOperationInput): Promise<ApplySlideOperationResult> {
    return this.sql.begin(async (tx) => {
      await requireDeckAccessForUpdate(tx, input.orgId, input.actorId, input.deckId);
      const existingRows = (await tx`
        select *
        from slides_op_log
        where org_id = ${input.orgId}
          and deck_id = ${input.deckId}
          and operation_id = ${input.operationId}
        limit 1
      `) as unknown as readonly SlideOperationLogRow[];
      if (existingRows[0] !== undefined) {
        return {
          status: "duplicate",
          operationId: input.operationId,
          revision: existingRows[0].revision,
        };
      }
      const latestRows = (await tx`
        select coalesce(max(revision), 0)::int as revision
        from slides_op_log
        where org_id = ${input.orgId} and deck_id = ${input.deckId}
      `) as unknown as readonly { readonly revision: number }[];
      const latestRevision = latestRows[0]?.revision ?? 0;
      if (input.baseRevision > latestRevision) {
        return { status: "ahead", operationId: input.operationId, revision: latestRevision };
      }

      // Per-slide CAS for shape-grained ops. The deck-level baseRevision is
      // too coarse: two clients editing different shapes on the same slide
      // can both pass the same `baseRevision` and the second write silently
      // overwrites the first. The slide's own `revision` is bumped on every
      // write, so a stale `expectedRevision` here means another writer beat
      // us. Reject and let the client re-fetch + retry on the fresh snapshot.
      if (
        (input.operation.kind === "update-slide" || input.operation.kind === "delete-slide") &&
        input.operation.expectedRevision !== undefined
      ) {
        const slideRows = (await tx`
          select revision
          from slides
          where id = ${input.operation.slideId}
            and org_id = ${input.orgId}
          limit 1
        `) as unknown as readonly { readonly revision: number }[];
        const currentSlideRevision = slideRows[0]?.revision ?? 0;
        if (currentSlideRevision !== input.operation.expectedRevision) {
          const deck = await selectDeckForActor(tx, input.orgId, input.actorId, input.deckId);
          if (deck === null) {
            throw new Error(`Unknown or inaccessible presentation: ${input.deckId}`);
          }
          const slides = await selectSlidesForDeck(tx, input.orgId, input.deckId);
          return {
            status: "slide-conflict",
            operationId: input.operationId,
            revision: latestRevision,
            slideId: input.operation.slideId,
            currentSlideRevision,
            snapshot: { deck: { ...deck, slideCount: slides.length }, slides },
          };
        }
      }

      await this.#applySyncOperation(tx, input);
      const deck = await selectDeckForActor(tx, input.orgId, input.actorId, input.deckId);
      if (deck === null) {
        throw new Error(`Unknown or inaccessible presentation: ${input.deckId}`);
      }
      const slides = await selectSlidesForDeck(tx, input.orgId, input.deckId);
      const revision = latestRevision + 1;
      await tx`
        insert into slides_op_log (
          org_id, deck_id, actor_id, operation_id, revision, base_revision, operation
        )
        values (
          ${input.orgId},
          ${input.deckId},
          ${input.actorId},
          ${input.operationId},
          ${revision},
          ${input.baseRevision},
          ${tx.json(toSqlJson(input.operation))}
        )
      `;
      return {
        status: "applied",
        operationId: input.operationId,
        revision,
        operation: input.operation,
        snapshot: { deck: { ...deck, slideCount: slides.length }, slides },
      };
    });
  }

  async listVersions(
    input: ListSlideDeckVersionsInput,
  ): Promise<readonly SlideDeckVersionRecord[]> {
    const deck = await selectDeckForActor(this.sql, input.orgId, input.actorId, input.deckId);
    if (deck === null) {
      return [];
    }
    const rows = (await this.sql`
      select *
      from drive_versions
      where org_id = ${input.orgId}
        and object_id = ${input.deckId}
        and mime_type = 'application/vnd.helix.presentation+json'
      order by version_number desc
      limit ${input.limit}
    `) as unknown as readonly SlideDeckVersionRow[];
    return rows.map(mapSlideDeckVersion);
  }

  async restoreVersion(input: RestoreSlideDeckVersionInput): Promise<{
    readonly deck: SlideDeckSummaryRecord;
    readonly slides: readonly SlideRecord[];
  } | null> {
    return this.sql.begin(async (tx) => {
      await requireDeckAccessForUpdate(tx, input.orgId, input.actorId, input.deckId);
      const versionRows = (await tx`
        select *
        from drive_versions
        where id = ${input.versionId}
          and org_id = ${input.orgId}
          and object_id = ${input.deckId}
          and mime_type = 'application/vnd.helix.presentation+json'
        limit 1
      `) as unknown as readonly SlideDeckVersionRow[];
      if (versionRows[0] === undefined) {
        return null;
      }
      const version = mapSlideDeckVersion(versionRows[0]);
      const snapshot = await readSlideDeckSnapshotVersion(this.options.storageResolver, {
        orgId: input.orgId,
        storageKey: version.storageKey,
        deckId: input.deckId,
      });
      const now = new Date();
      await tx`
        update slide_decks
        set title = ${snapshot.deck.title},
            metadata = ${tx.json(toSqlJson(snapshot.deck.metadata))},
            updated_at = ${now}
        where id = ${input.deckId}
          and org_id = ${input.orgId}
      `;
      await tx`
        delete from slides
        where org_id = ${input.orgId}
          and deck_id = ${input.deckId}
      `;
      for (const slide of snapshot.slides) {
        await tx`
          insert into slides (
            id, org_id, deck_id, position, layout, content, speaker_notes, revision, created_at, updated_at
          )
          values (
            ${slide.id},
            ${input.orgId},
            ${input.deckId},
            ${slide.position},
            ${slide.layout},
            ${tx.json(toSqlJson(slide.content))},
            ${slide.speakerNotes},
            1,
            ${now},
            ${now}
          )
        `;
      }
      await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, input.deckId);
      await appendSlidesActivity(tx, {
        orgId: input.orgId,
        actorId: input.actorId,
        verb: "slides.version.restored",
        deckId: input.deckId,
        payload: {
          restoredVersionId: version.id,
          restoredVersionNumber: version.versionNumber,
        },
      });
      const deck = await selectDeckForActor(tx, input.orgId, input.actorId, input.deckId);
      if (deck === null) {
        return null;
      }
      const slides = await selectSlidesForDeck(tx, input.orgId, input.deckId);
      return { deck: { ...deck, slideCount: slides.length }, slides };
    });
  }

  async #applySyncOperation(
    tx: postgres.TransactionSql,
    input: ApplySlideOperationInput,
  ): Promise<void> {
    switch (input.operation.kind) {
      case "update-deck": {
        const existing = await selectDeckForActor(tx, input.orgId, input.actorId, input.deckId);
        if (existing === null) {
          throw new Error(`Unknown or inaccessible presentation: ${input.deckId}`);
        }
        const nextTitle = input.operation.title ?? existing.title;
        const nextMetadata = input.operation.metadata ?? existing.metadata;
        await tx`
          update slide_decks
          set
            title = ${nextTitle},
            metadata = ${tx.json(toSqlJson(nextMetadata))},
            updated_at = now()
          where id = ${input.deckId}
            and org_id = ${input.orgId}
            and deleted_at is null
        `;
        await appendSlidesActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "slides.deck.updated",
          deckId: input.deckId,
          payload: { title: nextTitle },
        });
        await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, input.deckId);
        return;
      }
      case "create-slide": {
        const countRows = (await tx`
          select count(*)::int as slide_count from slides where deck_id = ${input.deckId}
        `) as unknown as readonly { readonly slide_count: number }[];
        const slideCount = countRows[0]?.slide_count ?? 0;
        const targetPosition =
          input.operation.position === undefined
            ? slideCount
            : Math.max(0, Math.min(input.operation.position, slideCount));
        if (targetPosition < slideCount) {
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
            ${input.operation.content.layout},
            ${tx.json(toSqlJson(input.operation.content))},
            ${input.operation.speakerNotes ?? ""}
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
        await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, input.deckId);
        return;
      }
      case "update-slide": {
        const existing = await selectSlideForActor(
          tx,
          input.orgId,
          input.actorId,
          input.operation.slideId,
        );
        if (existing === null || existing.deckId !== input.deckId) {
          throw new Error(`Unknown or inaccessible slide: ${input.operation.slideId}`);
        }
        const nextContent = input.operation.content ?? existing.content;
        const nextNotes = input.operation.speakerNotes ?? existing.speakerNotes;
        await tx`
          update slides
          set
            layout = ${nextContent.layout},
            content = ${tx.json(toSqlJson(nextContent))},
            speaker_notes = ${nextNotes},
            revision = revision + 1,
            updated_at = now()
          where id = ${input.operation.slideId}
            and org_id = ${input.orgId}
        `;
        await touchDeck(tx, input.orgId, input.deckId);
        await appendSlidesActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "slides.slide.updated",
          deckId: input.deckId,
          payload: { slideId: input.operation.slideId, layout: nextContent.layout },
        });
        await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, input.deckId);
        return;
      }
      case "delete-slide": {
        const existing = await selectSlideForActor(
          tx,
          input.orgId,
          input.actorId,
          input.operation.slideId,
        );
        if (existing === null || existing.deckId !== input.deckId) {
          throw new Error(`Unknown or inaccessible slide: ${input.operation.slideId}`);
        }
        await tx`delete from slides where id = ${input.operation.slideId} and org_id = ${input.orgId}`;
        await tx`
          update slides
          set position = position - 1, updated_at = now()
          where deck_id = ${input.deckId} and position > ${existing.position}
        `;
        await touchDeck(tx, input.orgId, input.deckId);
        await appendSlidesActivity(tx, {
          orgId: input.orgId,
          actorId: input.actorId,
          verb: "slides.slide.deleted",
          deckId: input.deckId,
          payload: { slideId: input.operation.slideId },
        });
        await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, input.deckId);
        return;
      }
      case "reorder-slides": {
        const currentRows = (await tx`
          select id from slides where deck_id = ${input.deckId} and org_id = ${input.orgId}
        `) as unknown as readonly { readonly id: string }[];
        const currentIds = new Set(currentRows.map((row) => row.id));
        const requested = new Set(input.operation.slideIds);
        if (
          currentIds.size !== requested.size ||
          [...currentIds].some((id) => !requested.has(id))
        ) {
          throw new Error("Reorder must list every slide in the deck exactly once.");
        }
        await tx`
          update slides
          set position = -1 - position, updated_at = now()
          where deck_id = ${input.deckId} and org_id = ${input.orgId}
        `;
        for (const [index, slideId] of input.operation.slideIds.entries()) {
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
          payload: { order: [...input.operation.slideIds] },
        });
        await this.#refreshStorageSnapshot(tx, input.orgId, input.actorId, input.deckId);
        return;
      }
    }
  }

  async #refreshStorageSnapshot(
    sql: SqlLike,
    orgId: string,
    actorId: string,
    deckId: string,
  ): Promise<void> {
    if (this.options.storageResolver === undefined) {
      return;
    }
    const deck = await selectDeckById(sql, orgId, deckId);
    if (deck === null) {
      return;
    }
    const slides = await selectSlidesForDeck(sql, orgId, deckId);
    const storageKey = `slides/${orgId}/${deckId}`;
    const versionNumber = await nextDriveVersionNumber(sql, deckId);
    const versionStorageKey = slideDeckSnapshotVersionStorageKey(orgId, deckId, versionNumber);
    const storedSnapshot = await writeSlideDeckStorageSnapshot({
      resolver: this.options.storageResolver,
      orgId,
      key: storageKey,
      deck,
      slides,
    });
    const versionSnapshot = await writeSlideDeckStorageSnapshot({
      resolver: this.options.storageResolver,
      orgId,
      key: versionStorageKey,
      deck,
      slides,
    });
    await insertSlideDeckSnapshotVersion(sql, {
      orgId,
      actorId,
      deckId,
      versionNumber,
      storageKey: versionStorageKey,
      byteSize: versionSnapshot.byteSize,
      sha256: versionSnapshot.sha256,
      metadata: { app: "slides", title: deck.title, slideCount: slides.length },
    });
    await sql`
      update objects
      set byte_size = ${storedSnapshot.byteSize},
          sha256 = ${storedSnapshot.sha256},
          metadata = objects.metadata || ${sql.json(
            toSqlJson({
              app: "slides",
              deckId,
              name: deck.title,
              title: deck.title,
              preview: nativeSlidesPreviewMetadata(deck, slides),
            }),
          )},
          updated_at = now()
      where id = ${deckId} and org_id = ${orgId}
    `;
  }
}

async function nextDriveVersionNumber(sql: SqlLike, objectId: string): Promise<number> {
  const rows = (await sql`
    select coalesce(max(version_number) + 1, 1)::int as version_number
    from drive_versions
    where object_id = ${objectId}
  `) as unknown as readonly { readonly version_number: number }[];
  return rows[0]?.version_number ?? 1;
}

async function insertSlideDeckSnapshotVersion(
  sql: SqlLike,
  input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly deckId: string;
    readonly versionNumber: number;
    readonly storageKey: string;
    readonly byteSize: number;
    readonly sha256: string | null;
    readonly metadata: JsonObject;
  },
): Promise<void> {
  if (input.sha256 === null) {
    return;
  }
  await sql`
    insert into drive_versions (
      org_id, object_id, version_number, storage_key, mime_type, byte_size, sha256, metadata, created_by_actor_id
    )
    values (
      ${input.orgId},
      ${input.deckId},
      ${input.versionNumber},
      ${input.storageKey},
      'application/vnd.helix.presentation+json',
      ${input.byteSize},
      ${input.sha256},
      ${sql.json(toSqlJson(input.metadata))},
      ${input.actorId}
    )
  `;
}

function slideDeckSnapshotVersionStorageKey(
  orgId: string,
  deckId: string,
  versionNumber: number,
): string {
  return `slides/${orgId}/${deckId}/versions/${String(versionNumber)}`;
}

async function selectDeckById(
  sql: SqlLike,
  orgId: string,
  deckId: string,
): Promise<SlideDeckRecord | null> {
  const rows = (await sql`
    select *
    from slide_decks
    where id = ${deckId}
      and org_id = ${orgId}
      and deleted_at is null
    limit 1
  `) as unknown as readonly SlideDeckRow[];
  return rows[0] === undefined ? null : mapDeck(rows[0]);
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

async function requireDeckAccessForUpdate(
  sql: SqlLike,
  orgId: string,
  actorId: string,
  deckId: string,
): Promise<void> {
  const rows = (await sql`
    select id
    from slide_decks
    where id = ${deckId}
      and org_id = ${orgId}
      and deleted_at is null
      and (
        owner_actor_id = ${actorId}
        or created_by_actor_id = ${actorId}
      )
    for update
  `) as unknown as readonly { readonly id: string }[];
  if (rows[0] === undefined) {
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

async function selectSlidesForDeck(
  sql: SqlLike,
  orgId: string,
  deckId: string,
): Promise<readonly SlideRecord[]> {
  const rows = (await sql`
    select *
    from slides
    where org_id = ${orgId}
      and deck_id = ${deckId}
    order by position asc
  `) as unknown as readonly SlideRow[];
  return rows.map(mapSlide);
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

async function writeSlideDeckStorageSnapshot(input: {
  readonly resolver?: TenantStorageResolver | undefined;
  readonly orgId: string;
  readonly key: string;
  readonly deck: SlideDeckRecord;
  readonly slides?: readonly SlideRecord[] | undefined;
}): Promise<{ readonly byteSize: number; readonly sha256: string | null }> {
  if (input.resolver === undefined) {
    return { byteSize: 0, sha256: null };
  }
  const body = encodeSnapshot({
    app: "slides",
    version: 1,
    deck: {
      id: input.deck.id,
      orgId: input.deck.orgId,
      title: input.deck.title,
      metadata: input.deck.metadata,
    },
    slides: (input.slides ?? []).map((slide) => ({
      id: slide.id,
      position: slide.position,
      layout: slide.layout,
      content: slide.content,
      speakerNotes: slide.speakerNotes,
    })),
  });
  const storage = await input.resolver({ orgId: input.orgId });
  if (storage === undefined) {
    throw new Error("Tenant storage resolver did not resolve storage for slide deck snapshot.");
  }
  await storage.client.put({
    key: input.key,
    body,
    contentType: "application/vnd.helix.presentation+json",
  });
  return { byteSize: body.byteLength, sha256: sha256Hex(body) };
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
    // Older deployments may not yet have run migration 0060; coerce undefined
    // to 1 so existing rows remain editable until the column lands.
    revision: typeof row.revision === "number" ? row.revision : 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSlideDeckVersion(row: SlideDeckVersionRow | undefined): SlideDeckVersionRecord {
  if (row === undefined) {
    throw new Error("Expected slide deck version row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    deckId: row.object_id,
    versionNumber: row.version_number,
    storageKey: row.storage_key,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    sha256: row.sha256,
    metadata: row.metadata,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at,
  };
}

function mapSlideOperationLog(row: SlideOperationLogRow | undefined): SlideOperationLogRecord {
  if (row === undefined) {
    throw new Error("Expected slide operation log row.");
  }
  return {
    id: row.id,
    orgId: row.org_id,
    deckId: row.deck_id,
    actorId: row.actor_id,
    operationId: row.operation_id,
    revision: row.revision,
    baseRevision: row.base_revision,
    operation: row.operation,
    createdAt: row.created_at,
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

function jsonStringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toJsonObject(value: unknown): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function encodeSnapshot(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

interface SlideDeckSnapshotV1 {
  readonly app: "slides";
  readonly version: 1;
  readonly deck: {
    readonly id: string;
    readonly title: string;
    readonly metadata: JsonObject;
  };
  readonly slides: readonly {
    readonly id: string;
    readonly position: number;
    readonly layout: SlideLayout;
    readonly content: SlideContent;
    readonly speakerNotes: string;
  }[];
}

async function readSlideDeckSnapshotVersion(
  resolver: TenantStorageResolver | undefined,
  input: { readonly orgId: string; readonly storageKey: string; readonly deckId: string },
): Promise<SlideDeckSnapshotV1> {
  const storage = await resolver?.({ orgId: input.orgId });
  if (storage === undefined) {
    throw new Error("Slide version restore requires readable tenant storage.");
  }
  const object = await storage.client.get(input.storageKey);
  if (object === null) {
    throw new Error(`Slide version snapshot not found: ${input.storageKey}`);
  }
  const snapshot = parseSlideDeckSnapshot(
    new TextDecoder().decode(await storageObjectBody(object.body)),
  );
  if (snapshot.deck.id !== input.deckId) {
    throw new Error("Slide version snapshot does not belong to the requested presentation.");
  }
  return snapshot;
}

function parseSlideDeckSnapshot(body: string): SlideDeckSnapshotV1 {
  const parsed: unknown = JSON.parse(body);
  if (!isRecord(parsed) || parsed["app"] !== "slides" || parsed["version"] !== 1) {
    throw new Error("Invalid slide deck version snapshot.");
  }
  const deck = parsed["deck"];
  const slides = parsed["slides"];
  if (!isRecord(deck) || !Array.isArray(slides)) {
    throw new Error("Invalid slide deck version snapshot.");
  }
  return {
    app: "slides",
    version: 1,
    deck: {
      id: readSnapshotString(deck["id"], "deck.id"),
      title: readSnapshotString(deck["title"], "deck.title"),
      metadata: readSnapshotObject(deck["metadata"]),
    },
    slides: slides.map(parseSnapshotSlide),
  };
}

function parseSnapshotSlide(value: unknown): SlideDeckSnapshotV1["slides"][number] {
  if (!isRecord(value)) {
    throw new Error("Invalid slide in version snapshot.");
  }
  const content = parseSlideContent(readSnapshotObject(value["content"]));
  return {
    id: readSnapshotString(value["id"], "slide.id"),
    position: readSnapshotInteger(value["position"], "slide.position"),
    layout: content.layout,
    content,
    speakerNotes: readSnapshotString(value["speakerNotes"], "slide.speakerNotes"),
  };
}

function readSnapshotString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid slide version snapshot field: ${field}.`);
  }
  return value;
}

function readSnapshotInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Invalid slide version snapshot field: ${field}.`);
  }
  return value as number;
}

function readSnapshotObject(value: unknown): JsonObject {
  return isRecord(value) ? (JSON.parse(JSON.stringify(value)) as JsonObject) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function storageObjectBody(
  body: Uint8Array | AsyncIterable<Uint8Array>,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) {
    return body;
  }
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  for await (const chunk of body) {
    chunks.push(chunk);
    byteLength += chunk.byteLength;
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function nativeSlidesPreviewMetadata(
  deck: SlideDeckRecord,
  slides: readonly SlideRecord[],
): JsonObject {
  return {
    kind: "text",
    status: "available",
    mimeType: "application/vnd.helix.presentation",
    text: nativeSlidesPreviewText(deck, slides),
  };
}

function nativeSlidesPreviewText(deck: SlideDeckRecord, slides: readonly SlideRecord[]): string {
  const firstSlide = [...slides].sort((left, right) => left.position - right.position)[0];
  if (firstSlide === undefined) {
    return deck.title;
  }
  return previewLines([deck.title, ...slideContentPreviewLines(firstSlide.content)])
    .join("\n")
    .slice(0, 2000);
}

function slideContentPreviewLines(content: SlideContent): readonly string[] {
  switch (content.layout) {
    case "title":
      return [
        content.title,
        content.eyebrow ?? "",
        content.subtitle ?? "",
        ...shapePreviewLines(content),
      ];
    case "agenda":
    case "bullets":
      return [content.title, ...content.items, ...shapePreviewLines(content)];
    case "stats":
      return [
        content.title,
        content.subtitle ?? "",
        ...content.stats.flatMap((stat) => [stat.value, stat.label, stat.note]),
        ...shapePreviewLines(content),
      ];
    case "split":
      return [
        content.title,
        content.left,
        ...(typeof content.rightContent === "string"
          ? [content.rightContent]
          : content.rightContent),
        content.quoteWho ?? "",
        ...shapePreviewLines(content),
      ];
    case "image":
      return [content.title, content.note, ...shapePreviewLines(content)];
  }
}

function shapePreviewLines(content: SlideContent): readonly string[] {
  return (
    content.shapes
      ?.flatMap((shape) => [shape.text ?? "", shape.imageAlt ?? "", shape.mediaTitle ?? ""])
      .filter((line) => line.trim().length > 0) ?? []
  );
}

function previewLines(lines: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const normalized = line.replace(/\s+/gu, " ").trim();
    if (normalized.length === 0 || seen.has(normalized.toLowerCase())) {
      continue;
    }
    seen.add(normalized.toLowerCase());
    out.push(normalized);
    if (out.length >= 12) {
      break;
    }
  }
  return out;
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
  private readonly operationLog = new Map<string, SlideOperationLogRecord[]>();

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

  async copyDeck(input: CopySlideDeckInput): Promise<{
    readonly deck: SlideDeckSummaryRecord;
    readonly slides: readonly SlideRecord[];
  } | null> {
    const source = this.accessibleDeck(input.orgId, input.actorId, input.deckId);
    if (source === null) {
      return null;
    }
    const now = new Date();
    const deck: SlideDeckRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      title: input.title?.trim() || `${source.title} (Copy)`,
      ownerActorId: input.actorId,
      createdByActorId: input.actorId,
      metadata: {
        ...source.metadata,
        createdFrom: "slides.deck.copy",
        copiedFromDeckId: source.id,
        ...(input.metadata ?? {}),
        app: "slides",
        folderId: input.folderId ?? jsonStringOrNull(source.metadata.folderId),
      },
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.decks.set(deck.id, { deck });
    const copiedSlides = this.slidesOf(source.id).map((slide) => {
      const copied: SlideRecord = {
        ...slide,
        id: randomUUID(),
        deckId: deck.id,
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      this.slides.set(copied.id, copied);
      return copied;
    });
    return { deck: { ...deck, slideCount: copiedSlides.length }, slides: copiedSlides };
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
          (query === undefined || query.length === 0 || deck.title.toLowerCase().includes(query)),
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
  }): Promise<{
    readonly deck: SlideDeckSummaryRecord;
    readonly slides: readonly SlideRecord[];
  } | null> {
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
      revision: 1,
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
      revision: slide.revision + 1,
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
    if (currentIds.size !== requested.size || [...currentIds].some((id) => !requested.has(id))) {
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

  async listOperations(input: {
    readonly orgId: string;
    readonly actorId: string;
    readonly deckId: string;
    readonly afterRevision?: number | undefined;
  }): Promise<readonly SlideOperationLogRecord[]> {
    const deck = this.accessibleDeck(input.orgId, input.actorId, input.deckId);
    if (deck === null) {
      return [];
    }
    return (this.operationLog.get(input.deckId) ?? []).filter(
      (operation) => operation.revision > (input.afterRevision ?? 0),
    );
  }

  async appendOperation(input: AppendSlideOperationInput): Promise<SlideOperationLogRecord> {
    const deck = this.accessibleDeck(input.orgId, input.actorId, input.deckId);
    if (deck === null) {
      throw new Error(`Unknown or inaccessible deck: ${input.deckId}`);
    }
    const existing = (this.operationLog.get(input.deckId) ?? []).find(
      (operation) => operation.operationId === input.operationId,
    );
    if (existing !== undefined) {
      return existing;
    }
    const operations = this.operationLog.get(input.deckId) ?? [];
    const record: SlideOperationLogRecord = {
      id: randomUUID(),
      orgId: input.orgId,
      deckId: input.deckId,
      actorId: input.actorId,
      operationId: input.operationId,
      revision: operations.length + 1,
      baseRevision: input.baseRevision,
      operation: input.operation,
      createdAt: new Date(),
    };
    this.operationLog.set(input.deckId, [...operations, record]);
    return record;
  }

  async applyOperation(input: ApplySlideOperationInput): Promise<ApplySlideOperationResult> {
    const deck = this.accessibleDeck(input.orgId, input.actorId, input.deckId);
    if (deck === null) {
      throw new Error(`Unknown or inaccessible deck: ${input.deckId}`);
    }
    const operations = this.operationLog.get(input.deckId) ?? [];
    const existing = operations.find((operation) => operation.operationId === input.operationId);
    if (existing !== undefined) {
      return { status: "duplicate", operationId: input.operationId, revision: existing.revision };
    }
    const latestRevision = operations.at(-1)?.revision ?? 0;
    if (input.baseRevision > latestRevision) {
      return { status: "ahead", operationId: input.operationId, revision: latestRevision };
    }
    if (
      (input.operation.kind === "update-slide" || input.operation.kind === "delete-slide") &&
      input.operation.expectedRevision !== undefined
    ) {
      const slide = this.slides.get(input.operation.slideId);
      const currentSlideRevision = slide?.revision ?? 0;
      if (currentSlideRevision !== input.operation.expectedRevision) {
        const snapshot = await this.getDeckForActor({
          orgId: input.orgId,
          actorId: input.actorId,
          deckId: input.deckId,
        });
        if (snapshot === null) {
          throw new Error(`Unknown or inaccessible presentation: ${input.deckId}`);
        }
        return {
          status: "slide-conflict",
          operationId: input.operationId,
          revision: latestRevision,
          slideId: input.operation.slideId,
          currentSlideRevision,
          snapshot,
        };
      }
    }
    await this.applySyncOperation(input);
    const record = await this.appendOperation({
      orgId: input.orgId,
      actorId: input.actorId,
      deckId: input.deckId,
      operationId: input.operationId,
      baseRevision: input.baseRevision,
      operation: toJsonObject(input.operation),
    });
    const snapshot = await this.getDeckForActor({
      orgId: input.orgId,
      actorId: input.actorId,
      deckId: input.deckId,
    });
    if (snapshot === null) {
      throw new Error(`Unknown or inaccessible presentation: ${input.deckId}`);
    }
    return {
      status: "applied",
      operationId: input.operationId,
      revision: record.revision,
      operation: input.operation,
      snapshot,
    };
  }

  async listVersions(
    _input: ListSlideDeckVersionsInput,
  ): Promise<readonly SlideDeckVersionRecord[]> {
    return [];
  }

  async restoreVersion(_input: RestoreSlideDeckVersionInput): Promise<{
    readonly deck: SlideDeckSummaryRecord;
    readonly slides: readonly SlideRecord[];
  } | null> {
    return null;
  }

  private async applySyncOperation(input: ApplySlideOperationInput): Promise<void> {
    switch (input.operation.kind) {
      case "update-deck": {
        const deck = await this.updateDeck({
          orgId: input.orgId,
          actorId: input.actorId,
          deckId: input.deckId,
          ...(input.operation.title === undefined ? {} : { title: input.operation.title }),
          ...(input.operation.metadata === undefined ? {} : { metadata: input.operation.metadata }),
        });
        if (deck === null) {
          throw new Error(`Unknown or inaccessible presentation: ${input.deckId}`);
        }
        return;
      }
      case "create-slide":
        await this.createSlide({
          orgId: input.orgId,
          actorId: input.actorId,
          deckId: input.deckId,
          content: input.operation.content,
          ...(input.operation.speakerNotes === undefined
            ? {}
            : { speakerNotes: input.operation.speakerNotes }),
          ...(input.operation.position === undefined ? {} : { position: input.operation.position }),
        });
        return;
      case "update-slide": {
        const slide = this.accessibleSlide(input.orgId, input.actorId, input.operation.slideId);
        if (slide === null || slide.deckId !== input.deckId) {
          throw new Error(`Unknown or inaccessible slide: ${input.operation.slideId}`);
        }
        const updated = await this.updateSlide({
          orgId: input.orgId,
          actorId: input.actorId,
          slideId: input.operation.slideId,
          ...(input.operation.content === undefined ? {} : { content: input.operation.content }),
          ...(input.operation.speakerNotes === undefined
            ? {}
            : { speakerNotes: input.operation.speakerNotes }),
        });
        if (updated === null) {
          throw new Error(`Unknown or inaccessible slide: ${input.operation.slideId}`);
        }
        return;
      }
      case "delete-slide": {
        const slide = this.accessibleSlide(input.orgId, input.actorId, input.operation.slideId);
        if (slide === null || slide.deckId !== input.deckId) {
          throw new Error(`Unknown or inaccessible slide: ${input.operation.slideId}`);
        }
        const deleted = await this.deleteSlide({
          orgId: input.orgId,
          actorId: input.actorId,
          slideId: input.operation.slideId,
        });
        if (!deleted) {
          throw new Error(`Unknown or inaccessible slide: ${input.operation.slideId}`);
        }
        return;
      }
      case "reorder-slides":
        await this.reorderSlides({
          orgId: input.orgId,
          actorId: input.actorId,
          deckId: input.deckId,
          slideIds: input.operation.slideIds,
        });
        return;
    }
  }

  private slidesOf(deckId: string): SlideRecord[] {
    return [...this.slides.values()]
      .filter((slide) => slide.deckId === deckId)
      .sort((left, right) => left.position - right.position);
  }

  private accessibleDeck(orgId: string, actorId: string, deckId: string): SlideDeckRecord | null {
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

  private accessibleSlide(orgId: string, actorId: string, slideId: string): SlideRecord | null {
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
