import { createHash } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemorySlidesStore, PostgresSlidesStore } from "./store.js";
import type { SlideContent } from "./types.js";
import type { TenantStorageClient, TenantStorageResolver } from "../storage/index.js";

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

const shapedBulletsContent: SlideContent = {
  layout: "bullets",
  title: "Layered",
  items: ["First"],
  transition: {
    type: "fade",
    durationMs: 360,
  },
  shapes: [
    {
      id: "shape-2",
      kind: "rectangle",
      x: 18,
      y: 22,
      width: 40,
      height: 22,
      text: "Backdrop",
      tone: "accent",
    },
    {
      id: "shape-1",
      kind: "text",
      x: 20,
      y: 24,
      width: 36,
      height: 16,
      text: "Q3 emphasis",
      tone: "dark",
      animation: {
        type: "fly",
        motionPath: "right",
        order: 2,
        durationMs: 950,
        easing: "easeOut",
      },
      exitAnimation: {
        type: "fade",
        order: 1,
        durationMs: 480,
        easing: "easeIn",
      },
    },
    {
      id: "shape-3",
      kind: "connector",
      x: 44,
      y: 30,
      width: 18,
      height: 28,
      tone: "light",
      connectorDirection: "down",
      connectorArrow: "none",
    },
    {
      id: "shape-4",
      kind: "image",
      x: 48,
      y: 14,
      width: 30,
      height: 26,
      text: "",
      tone: "accent",
      imageUrl: "https://example.test/product.png",
      imageAlt: "Product mockup",
      imageFit: "contain",
      imageMask: "circle",
    },
    {
      id: "shape-5",
      kind: "media",
      x: 12,
      y: 62,
      width: 42,
      height: 24,
      text: "",
      tone: "dark",
      mediaUrl: "https://example.test/product-demo.mp4",
      mediaType: "video",
      mediaTitle: "Product demo",
      mediaPosterUrl: "https://example.test/product-poster.png",
      mediaCaptionUrl: "https://example.test/product-captions.vtt",
      mediaCaptionLabel: "English captions",
      mediaStartSeconds: 4,
      mediaEndSeconds: 24,
      mediaAutoplay: true,
      mediaLoop: true,
      mediaMuted: true,
    },
  ],
};

describe("InMemorySlidesStore decks", () => {
  it("creates, lists, gets, updates, and soft-deletes a deck", async () => {
    const store = new InMemorySlidesStore();
    const created = await store.createDeck({
      orgId,
      actorId,
      title: "Q3 narrative",
      metadata: { audience: "board" },
    });
    expect(created.slideCount).toBe(0);
    expect(created.ownerActorId).toBe(actorId);
    expect(created.metadata).toMatchObject({ audience: "board" });

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
    expect(updated?.metadata).toMatchObject({ audience: "board" });

    const rethemed = await store.updateDeck({
      orgId,
      actorId,
      deckId: created.id,
      metadata: { audience: "board", theme: "meadow" },
    });
    expect(rethemed?.metadata).toEqual({ audience: "board", theme: "meadow" });

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

    const first = await store.createSlide({
      orgId,
      actorId,
      deckId: deck.id,
      content: titleContent,
    });
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

  it("round-trips freeform slide shapes in content order", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "Deck" });
    const slide = await store.createSlide({
      orgId,
      actorId,
      deckId: deck.id,
      content: shapedBulletsContent,
    });

    expect(slide.content).toEqual(shapedBulletsContent);

    const fetched = await store.getDeckForActor({ orgId, actorId, deckId: deck.id });
    expect(fetched?.slides[0]?.content).toEqual(shapedBulletsContent);

    const updated = await store.updateSlide({
      orgId,
      actorId,
      slideId: slide.id,
      content: {
        ...shapedBulletsContent,
        shapes: [...(shapedBulletsContent.shapes ?? [])].reverse(),
      },
    });

    expect(updated?.content).toEqual({
      ...shapedBulletsContent,
      shapes: [...(shapedBulletsContent.shapes ?? [])].reverse(),
    });
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

  it("applies sync operations with durable revisions and duplicate idempotency", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "Deck" });
    const slide = await store.createSlide({
      orgId,
      actorId,
      deckId: deck.id,
      content: titleContent,
    });

    const applied = await store.applyOperation({
      orgId,
      actorId,
      deckId: deck.id,
      operationId: "op-1",
      baseRevision: 0,
      operation: {
        kind: "update-slide",
        slideId: slide.id,
        content: { layout: "title", title: "Synced" },
      },
    });
    expect(applied).toMatchObject({
      status: "applied",
      operationId: "op-1",
      revision: 1,
      snapshot: {
        slides: [expect.objectContaining({ content: { layout: "title", title: "Synced" } })],
      },
    });

    const duplicate = await store.applyOperation({
      orgId,
      actorId,
      deckId: deck.id,
      operationId: "op-1",
      baseRevision: 0,
      operation: {
        kind: "update-slide",
        slideId: slide.id,
        content: { layout: "title", title: "Ignored duplicate" },
      },
    });
    expect(duplicate).toEqual({ status: "duplicate", operationId: "op-1", revision: 1 });
    await expect(store.getDeckForActor({ orgId, actorId, deckId: deck.id })).resolves.toMatchObject(
      {
        slides: [expect.objectContaining({ content: { layout: "title", title: "Synced" } })],
      },
    );
    const operations = await store.listOperations({
      orgId,
      actorId,
      deckId: deck.id,
      afterRevision: 0,
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      operationId: "op-1",
      revision: 1,
      baseRevision: 0,
    });
    expect(operations[0]?.operation.kind).toBe("update-slide");
  });

  it("does not apply sync operations with a future base revision", async () => {
    const store = new InMemorySlidesStore();
    const deck = await store.createDeck({ orgId, actorId, title: "Deck" });
    const slide = await store.createSlide({
      orgId,
      actorId,
      deckId: deck.id,
      content: titleContent,
    });

    await expect(
      store.applyOperation({
        orgId,
        actorId,
        deckId: deck.id,
        operationId: "op-future",
        baseRevision: 2,
        operation: {
          kind: "update-slide",
          slideId: slide.id,
          content: { layout: "title", title: "Too new" },
        },
      }),
    ).resolves.toEqual({ status: "ahead", operationId: "op-future", revision: 0 });
    await expect(store.listOperations({ orgId, actorId, deckId: deck.id })).resolves.toEqual([]);
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
    expect(await store.deleteSlide({ orgId, actorId: otherActorId, slideId: slide.id })).toBe(
      false,
    );
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

describe("PostgresSlidesStore tenant storage snapshots", () => {
  it("writes an initial presentation snapshot through tenant-resolved storage", async () => {
    const recording = createRecordingSlidesSql();
    const storage = new RecordingStorageClient();
    const store = new PostgresSlidesStore(recording.sql, {
      storageResolver: storageResolverFor(storage),
    });

    const deck = await store.createDeck({ orgId, actorId, title: "Storage Deck" });

    expect(deck.id).toBe("f3100000-0000-4000-8000-000000000001");
    expect(storage.puts).toHaveLength(2);
    const latestPut = storage.puts[0];
    const versionPut = storage.puts[1];
    expect(latestPut?.key).toBe(`slides/${orgId}/${deck.id}`);
    expect(versionPut?.key).toBe(`slides/${orgId}/${deck.id}/versions/1`);
    expect(latestPut?.contentType).toBe("application/vnd.helix.presentation+json");
    expect(versionPut?.contentType).toBe("application/vnd.helix.presentation+json");
    const snapshot = JSON.parse(new TextDecoder().decode(latestPut?.body)) as unknown;
    expect(snapshot).toMatchObject({
      app: "slides",
      version: 1,
      deck: { id: deck.id, orgId, title: "Storage Deck" },
      slides: [],
    });
    expect(new TextDecoder().decode(versionPut?.body)).toBe(
      new TextDecoder().decode(latestPut?.body),
    );
    const objectInsert = recording.calls.find((call) => call.text.includes("insert into objects"));
    expect(objectInsert?.values).toContain(latestPut?.body.byteLength);
    expect(objectInsert?.values).toContain(sha256Hex(latestPut?.body ?? new Uint8Array()));
    const versionInsert = recording.calls.find((call) =>
      call.text.includes("insert into drive_versions"),
    );
    expect(versionInsert?.values).toContain(1);
    expect(versionInsert?.values).toContain(versionPut?.key);
    expect(versionInsert?.values).toContain(sha256Hex(versionPut?.body ?? new Uint8Array()));
  });

  it("refreshes the presentation snapshot and object hash after slide mutations", async () => {
    const recording = createRecordingSlidesSql();
    const storage = new RecordingStorageClient();
    const store = new PostgresSlidesStore(recording.sql, {
      storageResolver: storageResolverFor(storage),
    });

    const deck = await store.createDeck({ orgId, actorId, title: "Storage Deck" });
    const slide = await store.createSlide({
      orgId,
      actorId,
      deckId: deck.id,
      content: shapedBulletsContent,
      speakerNotes: "Review metrics",
    });

    expect(storage.puts).toHaveLength(4);
    const put = storage.puts[2];
    const versionPut = storage.puts[3];
    expect(put?.key).toBe(`slides/${orgId}/${deck.id}`);
    expect(versionPut?.key).toBe(`slides/${orgId}/${deck.id}/versions/2`);
    const snapshot = JSON.parse(new TextDecoder().decode(put?.body)) as unknown;
    expect(snapshot).toMatchObject({
      app: "slides",
      version: 1,
      deck: { id: deck.id, orgId, title: "Storage Deck" },
      slides: [
        {
          id: slide.id,
          position: 0,
          layout: "bullets",
          content: shapedBulletsContent,
          speakerNotes: "Review metrics",
        },
      ],
    });
    const objectUpdate = recording.calls.find((call) => call.text.includes("update objects"));
    expect(objectUpdate?.values).toContain(put?.body.byteLength);
    expect(objectUpdate?.values).toContain(sha256Hex(put?.body ?? new Uint8Array()));
    const versionInserts = recording.calls.filter((call) =>
      call.text.includes("insert into drive_versions"),
    );
    expect(versionInserts[1]?.values).toContain(2);
    expect(versionInserts[1]?.values).toContain(versionPut?.key);
    expect(versionInserts[1]?.values).toContain(sha256Hex(versionPut?.body ?? new Uint8Array()));
  });

  it("does not insert object metadata when the snapshot write fails", async () => {
    const recording = createRecordingSlidesSql();
    const store = new PostgresSlidesStore(recording.sql, {
      storageResolver: storageResolverFor(new ThrowingStorageClient()),
    });

    await expect(store.createDeck({ orgId, actorId, title: "Broken" })).rejects.toThrow(
      "storage unavailable",
    );
    expect(recording.calls.some((call) => call.text.includes("insert into objects"))).toBe(false);
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

interface RecordedSqlCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

function createRecordingSlidesSql(): {
  readonly sql: postgres.Sql;
  readonly calls: readonly RecordedSqlCall[];
} {
  const calls: RecordedSqlCall[] = [];
  const now = new Date("2026-05-24T10:00:00.000Z");
  const deckRow = {
    id: "f3100000-0000-4000-8000-000000000001",
    org_id: orgId,
    title: "Storage Deck",
    owner_actor_id: actorId,
    created_by_actor_id: actorId,
    metadata: {},
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
  const slides: Array<{
    id: string;
    org_id: string;
    deck_id: string;
    position: number;
    layout: string;
    content: Record<string, unknown>;
    speaker_notes: string;
    created_at: Date;
    updated_at: Date;
  }> = [];
  let versionCount = 0;
  const tx = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      calls.push({ text, values });
      if (text.includes("insert into slide_decks")) {
        return Promise.resolve([{ ...deckRow, title: String(values[1]) }]);
      }
      if (text.includes("from slide_decks")) {
        return Promise.resolve([deckRow]);
      }
      if (text.includes("count(*)::int as slide_count")) {
        return Promise.resolve([{ slide_count: slides.length }]);
      }
      if (text.includes("insert into slides")) {
        const slide = {
          id: "f3100000-0000-4000-8000-000000000002",
          org_id: orgId,
          deck_id: String(values[1]),
          position: Number(values[2]),
          layout: String(values[3]),
          content: values[4] as Record<string, unknown>,
          speaker_notes: String(values[5]),
          created_at: now,
          updated_at: now,
        };
        slides.splice(0, slides.length, slide);
        return Promise.resolve([slide]);
      }
      if (text.includes("max(version_number)")) {
        return Promise.resolve([{ version_number: versionCount + 1 }]);
      }
      if (text.includes("insert into drive_versions")) {
        versionCount += 1;
        return Promise.resolve([]);
      }
      if (text.includes("from slides")) {
        return Promise.resolve(slides);
      }
      return Promise.resolve([]);
    },
    {
      begin: async <T>(callback: (tx: postgres.TransactionSql) => Promise<T>) =>
        callback(tx as unknown as postgres.TransactionSql),
      json: (value: unknown) => value,
    },
  );
  return { sql: tx as unknown as postgres.Sql, calls };
}

function storageResolverFor(storage: TenantStorageClient): TenantStorageResolver {
  return () => ({
    client: storage,
    managedBy: "helix-default",
    prefix: `tenants/${orgId}/`,
  });
}

class RecordingStorageClient implements TenantStorageClient {
  readonly puts: Array<{
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType?: string;
  }> = [];

  async put(object: {
    readonly key: string;
    readonly body: Uint8Array;
    readonly contentType?: string;
  }): Promise<void> {
    this.puts.push(object);
  }

  async get(): Promise<null> {
    return null;
  }

  async delete(): Promise<void> {}
}

class ThrowingStorageClient extends RecordingStorageClient {
  override async put(): Promise<void> {
    throw new Error("storage unavailable");
  }
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
