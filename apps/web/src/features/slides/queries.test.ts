import { afterEach, describe, expect, it, vi } from "vitest";
import {
  slidesCommentsQueryOptions,
  slidesListFromDriveQueryOptions,
  slidesMentionPeopleQueryOptions,
} from "./queries";
import type { SlideDeck } from "./seed";
import { filterDecksByFolder } from "./slides-list";

describe("slidesListFromDriveQueryOptions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks native Helix decks as native and raw presentation uploads as office opens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json({
            entries: [
              driveEntry({
                id: "11111111-1111-4111-8111-111111111111",
                app: "slides",
                name: "Native deck.slide",
              }),
              driveEntry({
                id: "22222222-2222-4222-8222-222222222222",
                app: "slides",
                name: "Uploaded deck.pptx",
                mimeType:
                  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                metadata: { title: "Uploaded deck", starred: true, sharedCount: 5 },
                preview: {
                  kind: "pdf",
                  status: "available",
                  mimeType: "application/pdf",
                  url: "https://cdn.example/uploaded-deck.pdf",
                },
              }),
              driveEntry({
                id: "33333333-3333-4333-8333-333333333333",
                app: null,
                name: "Macro deck.pptm",
                mimeType: "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
              }),
              driveEntry({
                id: "44444444-4444-4444-8444-444444444444",
                app: null,
                name: "Template.potx",
                mimeType: "application/vnd.openxmlformats-officedocument.presentationml.template",
              }),
              driveEntry({
                id: "55555555-5555-4555-8555-555555555555",
                app: null,
                name: "Imported deck.odp",
                mimeType: "application/vnd.oasis.opendocument.presentation",
              }),
              driveEntry({
                id: "66666666-6666-4666-8666-666666666666",
                app: null,
                name: "Legacy deck.ppt",
                mimeType: "application/vnd.ms-powerpoint",
                metadata: {
                  preview: {
                    kind: "office",
                    status: "unsupported",
                    mimeType: "application/vnd.ms-powerpoint",
                    blocker: "Office preview conversion requires the LibreOffice preview service.",
                  },
                },
              }),
              driveEntry({
                id: "77777777-7777-4777-8777-777777777777",
                app: null,
                name: "Legacy show.pps",
                mimeType: "application/vnd.ms-powerpoint",
              }),
              driveEntry({
                id: "88888888-8888-4888-8888-888888888888",
                app: null,
                name: "Slideshow.ppsx",
                mimeType: "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
              }),
              driveEntry({
                id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                app: null,
                name: "Deleted deck.pptx",
                mimeType:
                  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
                deletedAt: "2026-05-22T12:00:00.000Z",
              }),
              driveEntry({
                id: "99999999-9999-4999-8999-999999999999",
                app: null,
                name: "Budget.xlsx",
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              }),
            ],
          }),
        ),
      ),
    );

    const options = slidesListFromDriveQueryOptions({ limit: 10 });
    const decks = await (options.queryFn as () => Promise<readonly SlideDeck[]>)();

    expect(decks.map((deck) => [deck.title, deck.openMode])).toEqual([
      ["Native deck", "native"],
      ["Uploaded deck.pptx", "office"],
      ["Macro deck.pptm", "office"],
      ["Template.potx", "office"],
      ["Imported deck.odp", "office"],
      ["Legacy deck.ppt", "office"],
      ["Legacy show.pps", "office"],
      ["Slideshow.ppsx", "office"],
      ["Deleted deck.pptx", "office"],
    ]);
    expect(decks.map((deck) => deck.formatLabel)).toEqual([
      "SLIDES",
      "PPTX",
      "PPTM",
      "POTX",
      "ODP",
      "PPT",
      "PPS",
      "PPSX",
      "PPTX",
    ]);
    expect(decks[1]?.mimeType).toBe(
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    );
    expect(decks[1]?.preview?.url).toBe("https://cdn.example/uploaded-deck.pdf");
    expect(decks[1]?.starred).toBe(true);
    expect(decks[1]?.shared).toBe(5);
    expect(decks.at(-1)?.deletedAt).toBe("2026-05-22T12:00:00.000Z");
    expect(decks[5]?.preview).toMatchObject({
      kind: "office",
      status: "unsupported",
      mimeType: "application/vnd.ms-powerpoint",
    });
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/tools/drive.list", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        folderId: null,
        includeTrashed: true,
        limit: 10,
        app: "slides",
        acrossFolders: true,
      }),
    });
  });

  it("filters live, shared, starred, and trashed presentations from Drive metadata", () => {
    const decks: readonly SlideDeck[] = [
      deckRow({ id: "mine", title: "Mine", mine: true }),
      deckRow({ id: "shared", title: "Shared", mine: false, owner: "Maya Chen" }),
      deckRow({ id: "starred", title: "Starred", starred: true }),
      deckRow({ id: "trash", title: "Trashed", deletedAt: "2026-05-22T12:00:00.000Z" }),
    ];

    expect(filterDecksByFolder(decks, "all").map((deck) => deck.id)).toEqual([
      "mine",
      "shared",
      "starred",
    ]);
    expect(filterDecksByFolder(decks, "shared").map((deck) => deck.id)).toEqual(["shared"]);
    expect(filterDecksByFolder(decks, "starred").map((deck) => deck.id)).toEqual(["starred"]);
    expect(filterDecksByFolder(decks, "trash").map((deck) => deck.id)).toEqual(["trash"]);
  });

  it("uses Drive search for app search so matches outside the first page are visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json({
            hits: [
              searchHit({
                objectId: "11111111-1111-4111-8111-111111111111",
                name: "Hidden launch.pptx",
                mimeType:
                  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              }),
              searchHit({
                objectId: "22222222-2222-4222-8222-222222222222",
                name: "Hidden forecast.xlsx",
                mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              }),
            ],
          }),
        ),
      ),
    );

    const options = slidesListFromDriveQueryOptions({ limit: 51, query: "hidden" });
    const rows = await (options.queryFn as () => Promise<readonly SlideDeck[]>)();

    expect(rows.map((row) => row.title)).toEqual(["Hidden launch.pptx"]);
    expect(rows[0]?.openMode).toBe("office");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/tools/drive.search", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "hidden",
        folderId: null,
        limit: 51,
      }),
    });
  });

  it("loads Drive comments for a native deck with a status key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json({
            comments: [
              {
                id: "comment-1",
                objectId: "11111111-1111-4111-8111-111111111111",
                parentCommentId: null,
                actorId: "actor-1",
                anchor: { kind: "slides-slide", slideId: "slide-1" },
                body: "Tighten title",
                status: "open",
                metadata: {},
                resolvedAt: null,
                createdAt: "2026-05-20T12:00:00.000Z",
                updatedAt: null,
              },
            ],
          }),
        ),
      ),
    );

    const options = slidesCommentsQueryOptions("11111111-1111-4111-8111-111111111111", "open");
    const comments = await (options.queryFn as () => Promise<readonly unknown[]>)();

    expect(options.queryKey).toEqual([
      "slides",
      "deck",
      "11111111-1111-4111-8111-111111111111",
      "comments",
      "open",
    ]);
    expect(comments).toHaveLength(1);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/tools/drive.comment.list", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objectId: "11111111-1111-4111-8111-111111111111",
        status: "open",
      }),
    });
  });

  it("loads the people directory for Slides mention pickers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json({
            people: [
              {
                id: "actor-maya",
                email: "maya@example.com",
                displayName: "Maya Chen",
              },
            ],
          }),
        ),
      ),
    );

    const options = slidesMentionPeopleQueryOptions({ limit: 10 });
    const people = await (options.queryFn as () => Promise<readonly unknown[]>)();

    expect(options.queryKey).toEqual(["slides", "mention-people", 10]);
    expect(people).toEqual([
      {
        id: "actor-maya",
        email: "maya@example.com",
        displayName: "Maya Chen",
      },
    ]);
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/api/people?limit=10", {
      credentials: "include",
    });
  });
});

function deckRow(
  overrides: Partial<SlideDeck> & { readonly id: string; readonly title: string },
): SlideDeck {
  return {
    id: overrides.id,
    title: overrides.title,
    owner: overrides.owner ?? "You",
    modified: overrides.modified ?? "May 20",
    slides: overrides.slides ?? 0,
    shared: overrides.shared ?? 0,
    ...(overrides.mine === undefined ? {} : { mine: overrides.mine }),
    ...(overrides.starred === undefined ? {} : { starred: overrides.starred }),
    ...(overrides.deletedAt === undefined ? {} : { deletedAt: overrides.deletedAt }),
    ...(overrides.mimeType === undefined ? {} : { mimeType: overrides.mimeType }),
    ...(overrides.formatLabel === undefined ? {} : { formatLabel: overrides.formatLabel }),
    ...(overrides.preview === undefined ? {} : { preview: overrides.preview }),
    ...(overrides.openMode === undefined ? {} : { openMode: overrides.openMode }),
    ...(overrides.source === undefined ? {} : { source: overrides.source }),
  };
}

function driveEntry(overrides: {
  readonly id: string;
  readonly app: string | null;
  readonly name: string;
  readonly mimeType?: string;
  readonly metadata?: Record<string, unknown>;
  readonly preview?: unknown;
  readonly deletedAt?: string | null;
}) {
  return {
    id: overrides.id,
    type: "file",
    name: overrides.name,
    folderId: null,
    ownerActorId: null,
    app: overrides.app,
    mimeType: overrides.mimeType ?? "application/vnd.helix.slides",
    metadata: overrides.metadata ?? {},
    ...(overrides.preview === undefined ? {} : { preview: overrides.preview }),
    deletedAt: overrides.deletedAt ?? null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
}

function searchHit(overrides: {
  readonly objectId: string;
  readonly name: string;
  readonly mimeType: string;
}) {
  return {
    objectId: overrides.objectId,
    name: overrides.name,
    mimeType: overrides.mimeType,
    byteSize: 1024,
    sha256: null,
    folderId: null,
    preview: "",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
}
