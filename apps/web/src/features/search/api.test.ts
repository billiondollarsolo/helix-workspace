import { describe, expect, it, vi } from "vitest";
import { searchGlobal } from "./api";

describe("global search api", () => {
  it("calls the search.query tool with normalized input", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          hits: [
            {
              id: "mail:thread-1",
              type: "mail",
              title: "Launch plan",
              body: "Planning notes",
              url: "/mail?thread=thread-1",
              updatedAt: "2026-05-20T12:00:00.000Z",
            },
          ],
          query: "launch",
          estimatedTotalHits: 1,
        }),
      ),
    );

    await expect(
      searchGlobal({ query: " launch ", types: ["mail", "drive"], limit: 8 }, fetchImpl),
    ).resolves.toEqual({
      hits: [
        {
          id: "mail:thread-1",
          type: "mail",
          title: "Launch plan",
          body: "Planning notes",
          url: "/mail?thread=thread-1",
          updatedAt: "2026-05-20T12:00:00.000Z",
        },
      ],
      query: "launch",
      estimatedTotalHits: 1,
    });

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/search.query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "launch",
        types: ["mail", "drive"],
        limit: 8,
        offset: 0,
      }),
    });
  });

  it("discards retired editor results returned by an old search index", async () => {
    const file = { id: "drive:file-1", type: "drive", url: "/drive/file-1" };
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          hits: [
            file,
            ...["docs", "sheets", "slides"].map((type) => ({
              id: `${type}:old-1`,
              type,
              url: `/${type}/old-1`,
            })),
          ],
          query: "launch",
        }),
      ),
    );

    await expect(searchGlobal({ query: "launch" }, fetchImpl)).resolves.toEqual({
      hits: [file],
      query: "launch",
    });
  });

  it("does not call the backend for blank queries", async () => {
    const fetchImpl = vi.fn();

    await expect(searchGlobal({ query: "   " }, fetchImpl)).resolves.toEqual({
      hits: [],
      query: "",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces backend errors", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ error: "missing search scope" }, { status: 403 })),
    );

    await expect(searchGlobal({ query: "launch" }, fetchImpl)).rejects.toThrow(
      "missing search scope",
    );
  });
});
