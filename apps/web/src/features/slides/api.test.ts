import { describe, expect, it, vi } from "vitest";
import {
  createSlidesComment,
  deleteSlidesComment,
  exportSlidesDeck,
  importPptxDeck,
  listSlidesComments,
  reopenSlidesComment,
  resolveSlidesComment,
  updateSlidesComment,
} from "./api";

describe("Slides API", () => {
  it("exports a native deck through slides.export", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      expect(input).toBe("/api/tools/slides.export");
      expect(init).toEqual({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deckId: "11111111-1111-4111-8111-111111111111",
          format: "pptx",
        }),
      });
      return Promise.resolve(
        Response.json({
          deckId: "11111111-1111-4111-8111-111111111111",
          format: "pptx",
          filename: "board-narrative.pptx",
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          byteSize: 12,
          contentBase64: "UEsDBA==",
          metadata: { generatedBy: "helix.slides.export.pptx" },
        }),
      );
    });

    await expect(
      exportSlidesDeck({ deckId: "11111111-1111-4111-8111-111111111111" }, fetchImpl),
    ).resolves.toMatchObject({
      deckId: "11111111-1111-4111-8111-111111111111",
      format: "pptx",
      filename: "board-narrative.pptx",
      contentBase64: "UEsDBA==",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("passes requested PDF and image-series formats to slides.export", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const body = parseRequestBody(init);
      return Promise.resolve(
        Response.json({
          deckId: "11111111-1111-4111-8111-111111111111",
          format: body.format,
          filename:
            body.format === "pdf" ? "board-narrative.pdf" : "board-narrative-svg-series.zip",
          mimeType: body.format === "pdf" ? "application/pdf" : "application/zip",
          byteSize: 12,
          contentBase64: body.format === "pdf" ? "JVBERg==" : "UEsDBA==",
          metadata: {},
        }),
      );
    });

    await expect(
      exportSlidesDeck(
        { deckId: "11111111-1111-4111-8111-111111111111", format: "pdf" },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ format: "pdf", filename: "board-narrative.pdf" });
    await expect(
      exportSlidesDeck(
        { deckId: "11111111-1111-4111-8111-111111111111", format: "svg-series" },
        fetchImpl,
      ),
    ).resolves.toMatchObject({
      format: "svg-series",
      filename: "board-narrative-svg-series.zip",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map((call) => parseRequestBody(call[1]))).toEqual([
      { deckId: "11111111-1111-4111-8111-111111111111", format: "pdf" },
      { deckId: "11111111-1111-4111-8111-111111111111", format: "svg-series" },
    ]);
  });

  it("imports a PPTX file through slides.import-pptx", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      expect(input).toBe("/api/tools/slides.import-pptx");
      expect(init).toEqual({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          filename: "Board narrative.pptx",
          title: "Board narrative",
          folderId: null,
          contentBase64: "UEsDBA==",
          metadata: { source: "test" },
        }),
      });
      return Promise.resolve(
        Response.json({
          id: "11111111-1111-4111-8111-111111111111",
          title: "Board narrative",
          slides: [],
          import: { sourceFormat: "pptx", slideCount: 2, fidelity: "first-pass-text" },
        }),
      );
    });

    await expect(
      importPptxDeck(
        {
          filename: "Board narrative.pptx",
          title: "Board narrative",
          contentBase64: "UEsDBA==",
          metadata: { source: "test" },
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      import: { sourceFormat: "pptx", slideCount: 2 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses the Drive comment lifecycle for native deck review comments", async () => {
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      const body = parseRequestBody(init);
      if (input === "/api/tools/drive.comment.list") {
        return Promise.resolve(Response.json({ comments: [{ id: "comment-1", ...body }] }));
      }
      return Promise.resolve(
        Response.json({
          id: body.commentId ?? "comment-2",
          objectId: body.objectId ?? "11111111-1111-4111-8111-111111111111",
          parentCommentId: body.parentCommentId ?? null,
          actorId: "actor-1",
          anchor: body.anchor ?? {},
          body: body.body ?? "Resolved",
          status: input === "/api/tools/drive.comment.resolve" ? "resolved" : "open",
          metadata: body.metadata ?? {},
          resolvedAt: null,
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: null,
        }),
      );
    });

    await expect(
      listSlidesComments(
        { deckId: "11111111-1111-4111-8111-111111111111", status: "open" },
        fetchImpl,
      ),
    ).resolves.toHaveLength(1);
    await createSlidesComment(
      {
        deckId: "11111111-1111-4111-8111-111111111111",
        body: "Tighten this title",
        anchor: { kind: "slides-slide", slideId: "slide-1" },
        metadata: { source: "test" },
      },
      fetchImpl,
    );
    await resolveSlidesComment({ commentId: "comment-2" }, fetchImpl);
    await reopenSlidesComment({ commentId: "comment-2" }, fetchImpl);
    await updateSlidesComment({ commentId: "comment-2", body: "Updated" }, fetchImpl);
    await deleteSlidesComment({ commentId: "comment-2" }, fetchImpl);

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "/api/tools/drive.comment.list",
      "/api/tools/drive.comment.create",
      "/api/tools/drive.comment.resolve",
      "/api/tools/drive.comment.reopen",
      "/api/tools/drive.comment.update",
      "/api/tools/drive.comment.delete",
    ]);
    expect(fetchImpl.mock.calls.map((call) => parseRequestBody(call[1]))).toEqual([
      { objectId: "11111111-1111-4111-8111-111111111111", status: "open" },
      {
        objectId: "11111111-1111-4111-8111-111111111111",
        body: "Tighten this title",
        anchor: { kind: "slides-slide", slideId: "slide-1" },
        metadata: { source: "test" },
      },
      { commentId: "comment-2" },
      { commentId: "comment-2" },
      { commentId: "comment-2", body: "Updated" },
      { commentId: "comment-2" },
    ]);
  });
});

function parseRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new TypeError("Expected JSON request body.");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}
