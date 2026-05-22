import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemorySlidesStore, PostgresSlidesStore } from "./store.js";
import type { SlideContent } from "./types.js";

const orgId = "22222222-2222-4222-8222-222222222222";
const actorId = "11111111-1111-4111-8111-111111111111";
const otherActorId = "99999999-9999-4999-8999-999999999999";

const titleContent: SlideContent = {
  layout: "title",
  title: "Welcome",
  eyebrow: "All-Hands",
  bg: "accent",
};

const bulletsContent: SlideContent = {
  layout: "bullets",
  title: "Priorities",
  items: ["Search", "AI panel"],
};

const statsContent: SlideContent = {
  layout: "stats",
  title: "Numbers",
  stats: [{ value: "+38%", label: "DAU", note: "QoQ" }],
};

describe("InMemorySlidesStore decks", () => {
  it("creates, lists, gets, updates, and soft-deletes a deck", async () => {
    const store = new InMemorySlidesStore();
    const created = await store.createDeck({ orgId, actorId, title: "Q3 narrative" });
    expect(created.slideCount).toBe(0);
    expect(created.ownerActorId).toBe(actorId);

    const listed = await store.listDecksForActor({ orgId, actorId, limit: 50, offset: 0 });
    expect(listed.total).toBe(1);
    expect(listed.decks[0]?.id).toBe(created.id);

    const fetched = await store.getDeckForActor({ orgId, actorId, deckId: created.id });
    expect(fetched?.deck.title).toBe("Q3 narrative");
    expect(fetched?.slides).toEqual([]);

    const updated = await store.updateDeck({
      orgId,
      actorId,
      deckId: created.id,
      title: "Q3 — final",
    });
    expect(updated?.title).toBe("Q3 — final");

    expect(await store.deleteDeck({ orgId, actorId, deckId: created.id })).toBe(true);
    expect(await store.getDeckForActor({ orgId, actorId, deckId: created.id })).toBeNull();
    const afterDelete = await store.listDecksForActor({ orgId, actorId, limit: 50, offset: 0 });
    expect(afterDelete.total).toBe(0);
  });

  it("does not expose decks owned by other actors", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "Private" });
    expect(
      await store.getDeckForActor({ orgId, actorId: otherActorId, deckId: deck.id }),
    ).toBeNull();
    const listed = await store.listDecksForActor({
      orgId,
      actorId: otherActorId,
      limit: 50,
      offset: 0,
    });
    expect(listed.total).toBe(0);
    expect(
      await store.updateDeck({ orgId, actorId: otherActorId, deckId: deck.id, title: "x" }),
    ).toBeNull();
  });

  it("paginates and filters the deck list", async () => {
    const store = new InMemorySlidesStore();
    await store.createDeck({ orgId, actorId, title: "Alpha deck" });
    await store.createDeck({ orgId, actorId, title: "Beta deck" });
    await store.createDeck({ orgId, actorId, title: "Gamma report" });

    const page = await store.listDecksForActor({ orgId, actorId, limit: 2, offset: 0 });
    expect(page.decks).toHaveLength(2);
    expect(page.total).toBe(3);

    const filtered = await store.listDecksForActor({
      orgId,
      actorId,
      query: "deck",
      limit: 50,
      offset: 0,
    });
    expect(filtered.total).toBe(2);
  });
});

describe("InMemorySlidesStore slides", () => {
  it("appends slides, keeps positions contiguous, and reports slide count", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "Deck" });

    const first = await store.createSlide({ orgId, actorId, deckId: deck.id, content: titleContent });
    const second = await store.createSlide({
      orgId,
      actorId,
      deckId: deck.id,
      content: bulletsContent,
      speakerNotes: "talk slowly",
    });
    expect(first.position).toBe(0);
    expect(second.position).toBe(1);
    expect(second.speakerNotes).toBe("talk slowly");

    const fetched = await store.getDeckForActor({ orgId, actorId, deckId: deck.id });
    expect(fetched?.deck.slideCount).toBe(2);
    expect(fetched?.slides.map((slide) => slide.id)).toEqual([first.id, second.id]);
  });

  it("inserts a slide at a position and shifts trailing slides", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "Deck" });
    const a = await store.createSlide({ orgId, actorId, deckId: deck.id, content: titleContent });
    const b = await store.createSlide({ orgId, actorId, deckId: deck.id, content: bulletsContent });
    const inserted = await store.createSlide({
      orgId,
      actorId,
      deckId: deck.id,
      content: statsContent,
      position: 1,
    });
    const fetched = await store.getDeckForActor({ orgId, actorId, deckId: deck.id });
    expect(fetched?.slides.map((slide) => slide.id)).toEqual([a.id, inserted.id, b.id]);
    expect(fetched?.slides.map((slide) => slide.position)).toEqual([0, 1, 2]);
  });

  it("updates a slide's content and changes its layout", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "Deck" });
    const slide = await store.createSlide({
      orgId,
      actorId,
      deckId: deck.id,
      content: titleContent,
    });
    const updated = await store.updateSlide({
      orgId,
      actorId,
      slideId: slide.id,
      content: bulletsContent,
    });
    expect(updated?.layout).toBe("bullets");
    expect(updated?.content).toEqual(bulletsContent);
  });

  it("deletes a slide and closes the position gap", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "Deck" });
    const a = await store.createSlide({ orgId, actorId, deckId: deck.id, content: titleContent });
    const b = await store.createSlide({ orgId, actorId, deckId: deck.id, content: bulletsContent });
    const c = await store.createSlide({ orgId, actorId, deckId: deck.id, content: statsContent });

    expect(await store.deleteSlide({ orgId, actorId, slideId: b.id })).toBe(true);
    const fetched = await store.getDeckForActor({ orgId, actorId, deckId: deck.id });
    expect(fetched?.slides.map((slide) => slide.id)).toEqual([a.id, c.id]);
    expect(fetched?.slides.map((slide) => slide.position)).toEqual([0, 1]);
  });

  it("reorders every slide and rejects an incomplete permutation", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "Deck" });
    const a = await store.createSlide({ orgId, actorId, deckId: deck.id, content: titleContent });
    const b = await store.createSlide({ orgId, actorId, deckId: deck.id, content: bulletsContent });
    const c = await store.createSlide({ orgId, actorId, deckId: deck.id, content: statsContent });

    const reordered = await store.reorderSlides({
      orgId,
      actorId,
      deckId: deck.id,
      slideIds: [c.id, a.id, b.id],
    });
    expect(reordered.map((slide) => slide.id)).toEqual([c.id, a.id, b.id]);
    expect(reordered.map((slide) => slide.position)).toEqual([0, 1, 2]);

    await expect(
      store.reorderSlides({ orgId, actorId, deckId: deck.id, slideIds: [a.id, b.id] }),
    ).rejects.toThrow(/every slide/);
  });

  it("denies slide mutations on decks the actor cannot access", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "Deck" });
    const slide = await store.createSlide({
      orgId,
      actorId,
      deckId: deck.id,
      content: titleContent,
    });
    await expect(
      store.createSlide({ orgId, actorId: otherActorId, deckId: deck.id, content: titleContent }),
    ).rejects.toThrow(/inaccessible/);
    expect(
      await store.updateSlide({
        orgId,
        actorId: otherActorId,
        slideId: slide.id,
        content: bulletsContent,
      }),
    ).toBeNull();
    expect(
      await store.deleteSlide({ orgId, actorId: otherActorId, slideId: slide.id }),
    ).toBe(false);
  });

  it("stores app=slides and folderId in metadata when folderId is provided", async () => {
    const store = new InMemorySlidesStore();
    const folderId = "44444444-4444-4444-8444-444444444444";
    const deck = await store.createDeck({
      orgId,
      actorId,
      title: "Folder Deck",
      folderId,
    });

    expect((deck.metadata as Record<string, unknown>)["app"]).toBe("slides");
    expect((deck.metadata as Record<string, unknown>)["folderId"]).toBe(folderId);
  });

  it("stores app=slides in metadata when folderId is omitted", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "No Folder" });

    expect((deck.metadata as Record<string, unknown>)["app"]).toBe("slides");
    expect((deck.metadata as Record<string, unknown>)["folderId"]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PostgresSlidesStore — shared-PK objects row integration tests
// ---------------------------------------------------------------------------

function createSql(): postgres.Sql {
  const url =
    process.env.DATABASE_URL ?? "postgres://helix:helix_dev_password@localhost:28432/helix";
  return postgres(url, { max: 2, prepare: false });
}

// Deterministic UUIDs in the f300… range to avoid collision with other tests.
const PG_ORG_ID = "f3000000-0000-4000-8000-000000000001";
const PG_ACTOR_ID = "f3000000-0000-4000-8000-000000000002";
const PG_FOLDER_ID = "f3000000-0000-4000-8000-000000000003";

describe(
  "PostgresSlidesStore — createDeck creates shared-PK objects row",
  {
    skip: !process.env.DATABASE_URL,
  },
  () => {
    let sql: postgres.Sql;
    let store: PostgresSlidesStore;
    const createdDeckIds: string[] = [];

    beforeAll(async () => {
      sql = createSql();
      store = new PostgresSlidesStore(sql);

      // Seed a test actor so FK constraints are satisfied.
      await sql`
        insert into actors (id, org_id, type, display_name, scopes)
        values (${PG_ACTOR_ID}, ${PG_ORG_ID}, 'user', 'Slides Store Test Actor', '{}')
        on conflict (id) do nothing
      `;
    });

    afterAll(async () => {
      // Clean up created decks and their objects rows.
      if (createdDeckIds.length > 0) {
        await sql`delete from permissions where resource_id = any(${createdDeckIds}::uuid[])`;
        await sql`delete from objects where id = any(${createdDeckIds}::uuid[])`;
        await sql`delete from slides where deck_id = any(${createdDeckIds}::uuid[])`;
        await sql`delete from slide_decks where id = any(${createdDeckIds}::uuid[])`;
      }
      await sql.end();
    });

    it("inserts an objects row with kind=file, app=slides, name, deckId on create", async () => {
      const deck = await store.createDeck({
        orgId: PG_ORG_ID,
        actorId: PG_ACTOR_ID,
        title: "Q3 Keynote",
      });
      createdDeckIds.push(deck.id);

      const rows = (await sql`
        select id, org_id, owner_actor_id, kind, storage_key, mime_type, metadata
        from objects
        where id = ${deck.id}
      `) as unknown as ReadonlyArray<{
        id: string;
        org_id: string;
        owner_actor_id: string;
        kind: string;
        storage_key: string;
        mime_type: string;
        metadata: Record<string, unknown>;
      }>;

      expect(rows).toHaveLength(1);
      const obj = rows[0];
      expect(obj?.id).toBe(deck.id);
      expect(obj?.kind).toBe("file");
      expect(obj?.storage_key).toBe(`slides/${PG_ORG_ID}/${deck.id}`);
      expect(obj?.mime_type).toBe("application/vnd.helix.presentation");
      expect(obj?.metadata["app"]).toBe("slides");
      expect(obj?.metadata["name"]).toBe("Q3 Keynote");
      expect(obj?.metadata["deckId"]).toBe(deck.id);
      expect(obj?.metadata["folderId"]).toBeNull();
    });

    it("stores folderId in objects metadata when provided", async () => {
      const deck = await store.createDeck({
        orgId: PG_ORG_ID,
        actorId: PG_ACTOR_ID,
        title: "Investor Deck 2025",
        folderId: PG_FOLDER_ID,
      });
      createdDeckIds.push(deck.id);

      const rows = (await sql`
        select metadata from objects where id = ${deck.id}
      `) as unknown as ReadonlyArray<{ metadata: Record<string, unknown> }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.metadata["folderId"]).toBe(PG_FOLDER_ID);
      expect(rows[0]?.metadata["app"]).toBe("slides");
      expect(rows[0]?.metadata["name"]).toBe("Investor Deck 2025");
    });

    it("grants owner permission on the objects row", async () => {
      const deck = await store.createDeck({
        orgId: PG_ORG_ID,
        actorId: PG_ACTOR_ID,
        title: "Permissions Test Deck",
      });
      createdDeckIds.push(deck.id);

      const rows = (await sql`
        select role from permissions
        where resource_type = 'object'
          and resource_id = ${deck.id}
          and actor_id = ${PG_ACTOR_ID}
      `) as unknown as ReadonlyArray<{ role: string }>;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.role).toBe("owner");
    });
  },
);
