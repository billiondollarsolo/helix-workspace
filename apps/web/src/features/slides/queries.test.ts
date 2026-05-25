import { afterEach, describe, expect, it, vi } from "vitest";
import {
  slidesCommentsQueryOptions,
  slidesListFromDriveQueryOptions,
  slidesMentionPeopleQueryOptions,
} from "./queries";
import type { SlideDeck } from "./seed";

describe("slidesListFromDriveQueryOptions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks native slide decks for the native editor and uploaded presentations for Office", async () => {
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
                app: null,
                name: "Uploaded deck.pptx",
                mimeType:
                  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
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
      ["Uploaded deck", "office"],
    ]);
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

function driveEntry(overrides: {
  readonly id: string;
  readonly app: string | null;
  readonly name: string;
  readonly mimeType?: string;
}) {
  return {
    id: overrides.id,
    type: "file",
    name: overrides.name,
    folderId: null,
    ownerActorId: null,
    app: overrides.app,
    mimeType: overrides.mimeType ?? "application/vnd.helix.slides",
    metadata: {},
    deletedAt: null,
    createdAt: "2026-05-20T12:00:00.000Z",
    updatedAt: "2026-05-20T12:00:00.000Z",
  };
}
