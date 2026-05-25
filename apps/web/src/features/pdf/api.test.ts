import { describe, expect, it, vi } from "vitest";
import {
  clearPdfFormState,
  deletePdfComment,
  getPdfFormState,
  reopenPdfComment,
  savePdfFormState,
  updatePdfComment,
} from "./api";

const objectId = "33333333-3333-4333-8333-333333333333";

describe("pdf API", () => {
  it("updates, deletes, and reopens PDF comments through Drive tools", async () => {
    const commentId = "77777777-7777-4777-8777-777777777777";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          id: commentId,
          objectId,
          actorId: "22222222-2222-4222-8222-222222222222",
          parentCommentId: null,
          anchor: { kind: "pdf-page", page: 1 },
          body: "Updated totals",
          status: "open",
          metadata: {},
          resolvedAt: null,
          createdAt: "2026-05-24T14:00:00.000Z",
          updatedAt: "2026-05-24T14:10:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: commentId,
          objectId,
          actorId: "22222222-2222-4222-8222-222222222222",
          parentCommentId: null,
          anchor: { kind: "pdf-page", page: 1 },
          body: "Updated totals",
          status: "resolved",
          metadata: {},
          resolvedAt: "2026-05-24T14:15:00.000Z",
          createdAt: "2026-05-24T14:00:00.000Z",
          updatedAt: "2026-05-24T14:15:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          id: commentId,
          objectId,
          actorId: "22222222-2222-4222-8222-222222222222",
          parentCommentId: null,
          anchor: { kind: "pdf-page", page: 1 },
          body: "Updated totals",
          status: "open",
          metadata: {},
          resolvedAt: null,
          createdAt: "2026-05-24T14:00:00.000Z",
          updatedAt: "2026-05-24T14:20:00.000Z",
        }),
      );

    await expect(
      updatePdfComment({ commentId, body: "Updated totals" }, fetchImpl),
    ).resolves.toMatchObject({
      id: commentId,
      body: "Updated totals",
      status: "open",
    });
    await expect(deletePdfComment({ commentId }, fetchImpl)).resolves.toMatchObject({
      id: commentId,
      status: "resolved",
    });
    await expect(reopenPdfComment({ commentId }, fetchImpl)).resolves.toMatchObject({
      id: commentId,
      status: "open",
      resolvedAt: null,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/drive.comment.update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commentId, body: "Updated totals" }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/drive.comment.delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commentId }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "/api/tools/drive.comment.reopen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commentId }),
    });
  });

  it("gets, saves, and clears PDF form state through Drive tools", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          state: {
            objectId,
            actorId: "22222222-2222-4222-8222-222222222222",
            fieldValues: [{ name: "Customer name", type: "text", value: "Northwind" }],
            sourceVersionNumber: 1,
            sourceSha256: "0".repeat(64),
            sourceByteSize: 128,
            sourceChanged: false,
            createdAt: "2026-05-24T15:10:00.000Z",
            updatedAt: "2026-05-24T15:10:00.000Z",
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          objectId,
          actorId: "22222222-2222-4222-8222-222222222222",
          fieldValues: [{ name: "Approved", type: "checkbox", value: true }],
          sourceVersionNumber: 1,
          sourceSha256: "0".repeat(64),
          sourceByteSize: 128,
          sourceChanged: false,
          createdAt: "2026-05-24T15:10:00.000Z",
          updatedAt: "2026-05-24T15:12:00.000Z",
        }),
      )
      .mockResolvedValueOnce(Response.json({ objectId, cleared: true }));

    await expect(getPdfFormState({ objectId }, fetchImpl)).resolves.toMatchObject({
      fieldValues: [{ name: "Customer name", value: "Northwind" }],
      sourceChanged: false,
    });
    await expect(
      savePdfFormState(
        {
          objectId,
          fields: [
            { name: "Approved", type: "checkbox", value: true },
            { name: "Signer", type: "signature", value: "Ada Lovelace" },
          ],
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({
      fieldValues: [{ name: "Approved", value: true }],
      updatedAt: "2026-05-24T15:12:00.000Z",
    });
    await expect(clearPdfFormState({ objectId }, fetchImpl)).resolves.toEqual({
      objectId,
      cleared: true,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/drive.pdfFormState.get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectId }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/drive.pdfFormState.save", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        objectId,
        fields: [
          { name: "Approved", type: "checkbox", value: true },
          { name: "Signer", type: "signature", value: "Ada Lovelace" },
        ],
      }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "/api/tools/drive.pdfFormState.clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ objectId }),
    });
  });

  it("normalizes missing PDF form state to null", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({})));

    await expect(getPdfFormState({ objectId }, fetchImpl)).resolves.toBeNull();
  });
});
