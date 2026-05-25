import { describe, expect, it, vi } from "vitest";
import {
  answerDocsQuestion,
  clearDocsAskHistory,
  createDocsComment,
  createDocsDocument,
  createDocsSuggestion,
  createDocsSyncClient,
  deleteDocsComment,
  exportDocsDocument,
  generateDocsSuggestionDraft,
  getDocsDocument,
  getNativeDocumentSession,
  importDocxDocument,
  listDocsComments,
  listDocsAskHistory,
  listDocsDocuments,
  listDocsSuggestions,
  listDocsVersions,
  migrateDocsDocumentToNative,
  previewDocsVersion,
  renameDocsVersion,
  reopenDocsComment,
  resolveDocsComment,
  resolveDocsSuggestion,
  resolveDocsSuggestions,
  updateDocsComment,
  restoreDocsVersion,
  updateDocsLayout,
} from "./api";

const docId = "33333333-3333-4333-8333-333333333333";

describe("docs API", () => {
  it("creates Docs documents through the docs.create tool", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: docId,
          title: "Backend doc",
          threadId: "44444444-4444-4444-8444-444444444444",
          ownerActorId: "11111111-1111-4111-8111-111111111111",
          createdByActorId: "11111111-1111-4111-8111-111111111111",
          ydocState: btoa("# Backend doc\n"),
          ydocStateVector: null,
          updateSeq: 0,
          metadata: {},
          deletedAt: null,
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: "2026-05-20T12:00:00.000Z",
        }),
      ),
    );

    await expect(
      createDocsDocument({ title: "Backend doc", initialMarkdown: "# Backend doc\n" }, fetchImpl),
    ).resolves.toMatchObject({ id: docId, title: "Backend doc" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Backend doc",
        initialMarkdown: "# Backend doc\n",
        folderId: null,
        metadata: {},
      }),
    });
  });

  it("serializes folderId when creating Docs documents", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: docId,
          title: "Folder doc",
          threadId: "44444444-4444-4444-8444-444444444444",
          ownerActorId: "11111111-1111-4111-8111-111111111111",
          createdByActorId: "11111111-1111-4111-8111-111111111111",
          ydocState: btoa("# Folder doc\n"),
          ydocStateVector: null,
          updateSeq: 0,
          metadata: {},
          deletedAt: null,
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: "2026-05-20T12:00:00.000Z",
        }),
      ),
    );

    await createDocsDocument(
      {
        title: "Folder doc",
        initialMarkdown: "# Folder doc\n",
        folderId: "44444444-4444-4444-8444-444444444444",
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Folder doc",
        initialMarkdown: "# Folder doc\n",
        folderId: "44444444-4444-4444-8444-444444444444",
        metadata: {},
      }),
    });
  });

  it("serializes explicit native editor options when creating Docs documents", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: docId,
          title: "Native doc",
          threadId: "44444444-4444-4444-8444-444444444444",
          ownerActorId: "11111111-1111-4111-8111-111111111111",
          createdByActorId: "11111111-1111-4111-8111-111111111111",
          ydocState: btoa("native-state"),
          ydocStateVector: btoa("native-vector"),
          updateSeq: 0,
          editorEngine: "helix-native-document",
          formatVersion: 1,
          metadata: { createdFrom: "test" },
          deletedAt: null,
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: "2026-05-20T12:00:00.000Z",
        }),
      ),
    );

    await createDocsDocument(
      {
        title: "Native doc",
        initialMarkdown: "",
        editorEngine: "helix-native-document",
        formatVersion: 1,
        metadata: { createdFrom: "test" },
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Native doc",
        initialMarkdown: "",
        editorEngine: "helix-native-document",
        formatVersion: 1,
        folderId: null,
        metadata: { createdFrom: "test" },
      }),
    });
  });

  it("imports DOCX documents through docs.import-docx", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: docId,
          title: "Imported plan",
          threadId: "44444444-4444-4444-8444-444444444444",
          ownerActorId: "11111111-1111-4111-8111-111111111111",
          createdByActorId: "11111111-1111-4111-8111-111111111111",
          ydocState: btoa("native-state"),
          ydocStateVector: btoa("native-vector"),
          updateSeq: 0,
          editorEngine: "helix-native-document",
          formatVersion: 1,
          metadata: { importedFrom: "docx" },
          deletedAt: null,
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: "2026-05-20T12:00:00.000Z",
        }),
      ),
    );

    await expect(
      importDocxDocument(
        {
          filename: "Imported plan.docx",
          contentBase64: btoa("docx bytes"),
          metadata: { source: "test" },
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({
      id: docId,
      title: "Imported plan",
      editorEngine: "helix-native-document",
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.import-docx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "Imported plan.docx",
        contentBase64: btoa("docx bytes"),
        folderId: null,
        metadata: { source: "test" },
      }),
    });
  });

  it("lists readable Docs documents through docs.list", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          documents: [
            {
              id: docId,
              title: "Backend doc",
              threadId: "44444444-4444-4444-8444-444444444444",
              ownerActorId: "11111111-1111-4111-8111-111111111111",
              createdByActorId: "11111111-1111-4111-8111-111111111111",
              ydocState: btoa("# Backend doc\n"),
              ydocStateVector: null,
              updateSeq: 0,
              metadata: {},
              deletedAt: null,
              createdAt: "2026-05-20T12:00:00.000Z",
              updatedAt: "2026-05-20T12:00:00.000Z",
            },
          ],
        }),
      ),
    );

    await expect(listDocsDocuments({ query: "backend", limit: 10 }, fetchImpl)).resolves.toEqual([
      expect.objectContaining({ id: docId, title: "Backend doc" }),
    ]);
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "backend", limit: 10 }),
    });
  });

  it("hydrates selected document content through docs.export", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          docId,
          format: "markdown",
          filename: "backend-doc.markdown",
          mimeType: "text/markdown; charset=utf-8",
          byteSize: 32,
          contentBase64: btoa("# Backend doc\n\nLive content\n"),
          text: "# Backend doc\n\nLive content\n",
          metadata: {},
        }),
      ),
    );

    await expect(exportDocsDocument({ docId }, fetchImpl)).resolves.toMatchObject({
      docId,
      text: "# Backend doc\n\nLive content\n",
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId, format: "markdown", includeComments: false }),
    });
  });

  it("migrates legacy Docs documents through docs.migrate-native", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: docId,
          title: "Migrated doc",
          threadId: null,
          ownerActorId: "11111111-1111-4111-8111-111111111111",
          createdByActorId: "11111111-1111-4111-8111-111111111111",
          ydocState: btoa("native-state"),
          ydocStateVector: btoa("native-vector"),
          updateSeq: 2,
          editorEngine: "helix-native-document",
          formatVersion: 1,
          metadata: { migratedFromEditorEngine: "legacy-yjs" },
          deletedAt: null,
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: "2026-05-20T12:05:00.000Z",
        }),
      ),
    );

    await expect(migrateDocsDocumentToNative({ docId }, fetchImpl)).resolves.toMatchObject({
      id: docId,
      editorEngine: "helix-native-document",
      formatVersion: 1,
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.migrate-native", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId }),
    });
  });

  it("serializes comment-inclusive Docs export options", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          docId,
          format: "markdown",
          filename: "backend-doc.markdown",
          mimeType: "text/markdown; charset=utf-8",
          byteSize: 32,
          contentBase64: btoa("# Backend doc\n\nLive content\n"),
          text: "# Backend doc\n\nLive content\n",
          metadata: {},
        }),
      ),
    );

    await exportDocsDocument(
      {
        docId,
        format: "markdown",
        includeComments: true,
        filename: "review-copy.markdown",
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docId,
        format: "markdown",
        includeComments: true,
        filename: "review-copy.markdown",
      }),
    });
  });

  it("serializes EPUB Docs export options", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          docId,
          format: "epub",
          filename: "backend-doc.epub",
          mimeType: "application/epub+zip",
          byteSize: 32,
          contentBase64: btoa("epub bytes"),
          metadata: {},
        }),
      ),
    );

    await expect(
      exportDocsDocument({ docId, format: "epub", includeComments: true }, fetchImpl),
    ).resolves.toMatchObject({
      format: "epub",
      filename: "backend-doc.epub",
      mimeType: "application/epub+zip",
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId, format: "epub", includeComments: true }),
    });
  });

  it("gets readable Docs documents through docs.get", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: docId,
          title: "Backend doc",
          threadId: "44444444-4444-4444-8444-444444444444",
          ownerActorId: "11111111-1111-4111-8111-111111111111",
          createdByActorId: "11111111-1111-4111-8111-111111111111",
          ydocState: btoa("# Backend doc\n"),
          ydocStateVector: null,
          updateSeq: 0,
          metadata: {},
          deletedAt: null,
          createdAt: "2026-05-20T12:00:00.000Z",
          updatedAt: "2026-05-20T12:00:00.000Z",
        }),
      ),
    );

    await expect(getDocsDocument({ docId }, fetchImpl)).resolves.toMatchObject({
      id: docId,
      title: "Backend doc",
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.get", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId }),
    });
  });

  it("loads native document sessions through the editors core-app API", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          editor: "document",
          engine: "helix-native-document",
          formatVersion: 1,
          resource: {
            orgId: "org-1",
            resourceId: docId,
            kind: "document",
          },
          document: {
            id: docId,
            orgId: "org-1",
            title: "Native doc",
            editorEngine: "helix-native-document",
            formatVersion: 1,
            updateSeq: 2,
            stateBase64: null,
            stateVectorBase64: null,
            layoutSettings: {
              layoutMode: "pageless",
              columnCount: 2,
              sections: [
                {
                  id: "default",
                  title: "Document",
                  layoutMode: "pageless",
                  columnCount: 2,
                  pageSize: "a4",
                  orientation: "landscape",
                },
              ],
            },
            updatedAt: "2026-05-23T12:00:00.000Z",
          },
          shellRoute: "/docs/:id",
          apiRoute: "/api/editors/documents/:documentId",
          sync: {
            protocol: "yjs",
            route: "/sync/docs/:docId",
            url: `/sync/docs/${docId}?protocol=yjs`,
            awareness: true,
          },
        }),
      ),
    );

    await expect(getNativeDocumentSession({ documentId: docId }, fetchImpl)).resolves.toMatchObject(
      {
        document: {
          id: docId,
          title: "Native doc",
          layoutSettings: {
            layoutMode: "pageless",
            columnCount: 2,
            sections: [
              {
                id: "default",
                pageSize: "a4",
                orientation: "landscape",
              },
            ],
          },
        },
        sync: { url: `/sync/docs/${docId}?protocol=yjs` },
      },
    );
    expect(fetchImpl).toHaveBeenCalledWith(`/api/editors/documents/${docId}`, {
      method: "GET",
      headers: { "content-type": "application/json" },
    });
  });

  it("surfaces native document session API errors", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ error: "document not found" }, { status: 404 })),
    );

    await expect(getNativeDocumentSession({ documentId: docId }, fetchImpl)).rejects.toThrow(
      "document not found",
    );
  });

  it("updates native document layout through the docs.update-layout tool", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: docId,
          title: "Native doc",
          metadata: {
            nativeDocumentLayout: {
              layoutMode: "pageless",
              columnCount: 2,
              sections: [
                {
                  id: "default",
                  title: "Document",
                  layoutMode: "pageless",
                  columnCount: 2,
                  pageSize: "a4",
                  orientation: "landscape",
                },
              ],
            },
          },
          updatedAt: "2026-05-23T12:05:00.000Z",
        }),
      ),
    );

    await expect(
      updateDocsLayout(
        {
          docId,
          layoutSettings: {
            layoutMode: "pageless",
            columnCount: 2,
            sections: [
              {
                id: "default",
                title: "Document",
                layoutMode: "pageless",
                columnCount: 2,
                pageSize: "a4",
                orientation: "landscape",
              },
            ],
          },
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({
      metadata: {
        nativeDocumentLayout: {
          layoutMode: "pageless",
          columnCount: 2,
          sections: [
            {
              id: "default",
              title: "Document",
              layoutMode: "pageless",
              columnCount: 2,
              pageSize: "a4",
              orientation: "landscape",
            },
          ],
        },
      },
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.update-layout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docId,
        layoutSettings: {
          layoutMode: "pageless",
          columnCount: 2,
          sections: [
            {
              id: "default",
              title: "Document",
              layoutMode: "pageless",
              columnCount: 2,
              pageSize: "a4",
              orientation: "landscape",
            },
          ],
        },
      }),
    });
  });

  it("creates Docs comments with structured anchors", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: "55555555-5555-4555-8555-555555555555",
          documentId: docId,
          actorId: "11111111-1111-4111-8111-111111111111",
          anchor: { label: "Open risks" },
          body: "Needs owner",
          status: "open",
          metadata: {},
          resolvedAt: null,
          createdAt: "2026-05-20T12:05:00.000Z",
          updatedAt: null,
        }),
      ),
    );

    await createDocsComment(
      {
        docId,
        parentCommentId: "44444444-4444-4444-8444-444444444444",
        body: "Needs owner",
        anchor: { label: "Open risks" },
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.comment.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docId,
        parentCommentId: "44444444-4444-4444-8444-444444444444",
        body: "Needs owner",
        anchor: { label: "Open risks" },
        metadata: {},
      }),
    });
  });

  it("lists Docs comments through docs.comment.list", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          comments: [
            {
              id: "55555555-5555-4555-8555-555555555555",
              documentId: docId,
              actorId: "11111111-1111-4111-8111-111111111111",
              author: { id: "11111111-1111-4111-8111-111111111111", displayName: "Ada" },
              anchor: { kind: "document" },
              body: "Needs owner",
              status: "open",
              metadata: { source: "test" },
              resolvedAt: null,
              createdAt: "2026-05-20T12:05:00.000Z",
              updatedAt: "2026-05-20T12:05:00.000Z",
            },
          ],
        }),
      ),
    );

    await expect(listDocsComments({ docId }, fetchImpl)).resolves.toMatchObject([
      {
        id: "55555555-5555-4555-8555-555555555555",
        body: "Needs owner",
        author: { displayName: "Ada" },
        status: "open",
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.comment.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId, status: "open" }),
    });
  });

  it("lists resolved and all Docs comments with the expected status payload", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ comments: [] })));

    await listDocsComments({ docId, status: "resolved" }, fetchImpl);
    await listDocsComments({ docId, status: "all" }, fetchImpl);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/docs.comment.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId, status: "resolved" }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/docs.comment.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId, status: "all" }),
    });
  });

  it("resolves Docs comments through docs.comment.resolve", async () => {
    const commentId = "55555555-5555-4555-8555-555555555555";
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: commentId,
          documentId: docId,
          actorId: "11111111-1111-4111-8111-111111111111",
          anchor: { kind: "document" },
          body: "Needs owner",
          status: "resolved",
          metadata: {},
          resolvedAt: "2026-05-20T12:06:00.000Z",
          createdAt: "2026-05-20T12:05:00.000Z",
          updatedAt: "2026-05-20T12:06:00.000Z",
        }),
      ),
    );

    await expect(resolveDocsComment({ commentId }, fetchImpl)).resolves.toMatchObject({
      id: commentId,
      status: "resolved",
      resolvedAt: "2026-05-20T12:06:00.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.comment.resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commentId }),
    });
  });

  it("updates, deletes, and reopens Docs comments through lifecycle tools", async () => {
    const commentId = "55555555-5555-4555-8555-555555555555";
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        typeof init?.body === "string" ? (JSON.parse(init.body) as { readonly body?: string }) : {};
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const isReopen = url.endsWith("reopen");
      return Promise.resolve(
        Response.json({
          id: commentId,
          documentId: docId,
          actorId: "11111111-1111-4111-8111-111111111111",
          anchor: { kind: "document" },
          body: body.body ?? "Needs owner",
          status: isReopen ? "open" : "resolved",
          metadata: {},
          resolvedAt: isReopen ? null : "2026-05-20T12:06:00.000Z",
          createdAt: "2026-05-20T12:05:00.000Z",
          updatedAt: "2026-05-20T12:06:00.000Z",
        }),
      );
    });

    await expect(
      updateDocsComment({ commentId, body: "Updated note" }, fetchImpl),
    ).resolves.toMatchObject({ id: commentId, body: "Updated note" });
    await expect(deleteDocsComment({ commentId }, fetchImpl)).resolves.toMatchObject({
      id: commentId,
    });
    await expect(reopenDocsComment({ commentId }, fetchImpl)).resolves.toMatchObject({
      id: commentId,
      status: "open",
      resolvedAt: null,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/docs.comment.update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commentId, body: "Updated note" }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/docs.comment.delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commentId }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "/api/tools/docs.comment.reopen", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commentId }),
    });
  });

  it("creates Docs suggestions as tracked changes through docs.suggestion.create", async () => {
    const suggestionId = "77777777-7777-4777-8777-777777777777";
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: suggestionId,
          documentId: docId,
          actorId: "11111111-1111-4111-8111-111111111111",
          anchor: { label: "Open risks" },
          beforeText: "teh plan",
          afterText: "the plan",
          reason: "typo",
          status: "pending",
          metadata: {},
          resolvedByActorId: null,
          resolvedAt: null,
          createdAt: "2026-05-21T12:00:00.000Z",
          updatedAt: null,
        }),
      ),
    );

    await expect(
      createDocsSuggestion(
        {
          docId,
          beforeText: "teh plan",
          afterText: "the plan",
          reason: "typo",
          anchor: { label: "Open risks" },
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ id: suggestionId, status: "pending", beforeText: "teh plan" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.suggestion.create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docId,
        beforeText: "teh plan",
        afterText: "the plan",
        reason: "typo",
        anchor: { label: "Open risks" },
        metadata: {},
      }),
    });
  });

  it("lists pending Docs suggestions through docs.suggestion.list", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ suggestions: [] })));

    await expect(listDocsSuggestions({ docId, status: "pending" }, fetchImpl)).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.suggestion.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId, status: "pending" }),
    });
  });

  it("generates Docs suggestion drafts through docs.suggestion.generate", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          slotId: "docs.smart-write",
          text: "the plan",
          metadata: { providerId: "test-ai", model: "test-model" },
        }),
      ),
    );

    await expect(
      generateDocsSuggestionDraft(
        {
          docId,
          slotId: "docs.smart-write",
          selection: "teh plan",
          body: "# Plan\n\nteh plan",
          prompt: "Fix typo",
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({ slotId: "docs.smart-write", text: "the plan" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.suggestion.generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docId,
        slotId: "docs.smart-write",
        selection: "teh plan",
        body: "# Plan\n\nteh plan",
        prompt: "Fix typo",
      }),
    });
  });

  it("answers Docs questions through docs.ask.answer", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: "99999999-9999-4999-8999-999999999999",
          documentId: docId,
          actorId: "11111111-1111-4111-8111-111111111111",
          question: "What is the main risk?",
          answer: "Ownership is unresolved.",
          sourceScope: "document",
          sourceExcerpt: "Risks: ownership remains open.",
          metadata: {
            providerId: "test-ai",
            citations: [
              {
                label: "Risks",
                excerpt: "Risks: ownership remains open.",
                sourceScope: "document",
              },
            ],
          },
          createdAt: "2026-05-25T12:00:00.000Z",
          updatedAt: "2026-05-25T12:00:00.000Z",
        }),
      ),
    );

    await expect(
      answerDocsQuestion(
        {
          docId,
          question: "What is the main risk?",
          selection: "Risks: ownership remains open.",
          body: "# Plan\n\nRisks: ownership remains open.",
          sourceScope: "document",
          citations: [
            {
              label: "Risks",
              excerpt: "Risks: ownership remains open.",
              sourceScope: "document",
            },
          ],
        },
        fetchImpl,
      ),
    ).resolves.toMatchObject({
      answer: "Ownership is unresolved.",
      citations: [
        {
          label: "Risks",
          excerpt: "Risks: ownership remains open.",
          sourceScope: "document",
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.ask.answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        docId,
        question: "What is the main risk?",
        selection: "Risks: ownership remains open.",
        body: "# Plan\n\nRisks: ownership remains open.",
        sourceScope: "document",
        citations: [
          {
            label: "Risks",
            excerpt: "Risks: ownership remains open.",
            sourceScope: "document",
          },
        ],
      }),
    });
  });

  it("lists and clears Docs ask history", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          history: [
            {
              id: "99999999-9999-4999-8999-999999999999",
              documentId: docId,
              actorId: "11111111-1111-4111-8111-111111111111",
              question: "What changed?",
              answer: "The launch moved.",
              sourceScope: "selection",
              sourceExcerpt: "Launch date moved.",
              metadata: {},
              createdAt: "2026-05-25T12:00:00.000Z",
              updatedAt: "2026-05-25T12:00:00.000Z",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ deleted: 1 }));

    await expect(listDocsAskHistory({ docId, limit: 5 }, fetchImpl)).resolves.toHaveLength(1);
    await expect(clearDocsAskHistory({ docId }, fetchImpl)).resolves.toBe(1);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/docs.ask.history.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId, limit: 5 }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/docs.ask.history.clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId }),
    });
  });

  it("lists accepted/rejected/all Docs suggestions with the expected status payload", async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(Response.json({ suggestions: [] })));

    await listDocsSuggestions({ docId, status: "accepted" }, fetchImpl);
    await listDocsSuggestions({ docId, status: "rejected" }, fetchImpl);
    await listDocsSuggestions({ docId }, fetchImpl);

    expect(fetchImpl).toHaveBeenNthCalledWith(1, "/api/tools/docs.suggestion.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId, status: "accepted" }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "/api/tools/docs.suggestion.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId, status: "rejected" }),
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(3, "/api/tools/docs.suggestion.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId }),
    });
  });

  it("lists Docs versions through docs.version.list", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          versions: [
            {
              id: "88888888-8888-4888-8888-888888888888",
              documentId: docId,
              actorId: "11111111-1111-4111-8111-111111111111",
              seq: 4,
              byteSize: 128,
              metadata: { source: "web.docs-shell" },
              createdAt: "2026-05-21T12:10:00.000Z",
            },
          ],
        }),
      ),
    );

    await expect(listDocsVersions({ docId, limit: 5 }, fetchImpl)).resolves.toMatchObject([
      {
        seq: 4,
        byteSize: 128,
        metadata: { source: "web.docs-shell" },
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.version.list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId, limit: 5 }),
    });
  });

  it("renames Docs versions through docs.version.rename", async () => {
    const versionId = "88888888-8888-4888-8888-888888888888";
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: versionId,
          documentId: docId,
          actorId: "11111111-1111-4111-8111-111111111111",
          seq: 4,
          byteSize: 128,
          metadata: { source: "web.docs-shell", name: "Milestone review" },
          createdAt: "2026-05-21T12:10:00.000Z",
        }),
      ),
    );

    await expect(
      renameDocsVersion({ versionId, name: "Milestone review" }, fetchImpl),
    ).resolves.toMatchObject({
      id: versionId,
      metadata: { name: "Milestone review" },
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.version.rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId, name: "Milestone review" }),
    });
  });

  it("previews Docs versions through docs.version.preview", async () => {
    const versionId = "88888888-8888-4888-8888-888888888888";
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          version: {
            id: versionId,
            documentId: docId,
            actorId: "11111111-1111-4111-8111-111111111111",
            seq: 4,
            byteSize: 128,
            metadata: { source: "web.docs-shell", name: "Milestone review" },
            createdAt: "2026-05-21T12:10:00.000Z",
          },
          documentId: docId,
          currentText: "Current line",
          versionText: "Previous line",
          completeness: "reconstructed",
          complete: false,
          appliedCount: 1,
          skippedCount: 0,
          diff: [
            { kind: "removed", text: "Previous line" },
            { kind: "added", text: "Current line" },
          ],
          warnings: ["This preview has no baseline update and may omit earlier content."],
        }),
      ),
    );

    await expect(previewDocsVersion({ versionId }, fetchImpl)).resolves.toMatchObject({
      version: { id: versionId },
      currentText: "Current line",
      versionText: "Previous line",
      complete: false,
      warnings: ["This preview has no baseline update and may omit earlier content."],
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.version.preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId }),
    });
  });

  it("restores Docs versions through docs.version.restore", async () => {
    const versionId = "88888888-8888-4888-8888-888888888888";
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          document: {
            id: docId,
            title: "Restored doc",
            threadId: "44444444-4444-4444-8444-444444444444",
            ownerActorId: "11111111-1111-4111-8111-111111111111",
            createdByActorId: "11111111-1111-4111-8111-111111111111",
            ydocState: btoa("restored-state"),
            ydocStateVector: btoa("restored-vector"),
            updateSeq: 5,
            editorEngine: "helix-native-document",
            formatVersion: 1,
            metadata: {},
            deletedAt: null,
            createdAt: "2026-05-20T12:00:00.000Z",
            updatedAt: "2026-05-21T12:20:00.000Z",
          },
          restoredVersion: {
            id: versionId,
            documentId: docId,
            actorId: "11111111-1111-4111-8111-111111111111",
            seq: 4,
            byteSize: 128,
            metadata: { source: "web.docs-shell", name: "Milestone review" },
            createdAt: "2026-05-21T12:10:00.000Z",
          },
          restoreVersion: {
            id: "99999999-9999-4999-8999-999999999999",
            documentId: docId,
            actorId: "11111111-1111-4111-8111-111111111111",
            seq: 5,
            byteSize: 256,
            metadata: { source: "docs.version.restore", restoredVersionId: versionId },
            createdAt: "2026-05-21T12:20:00.000Z",
          },
        }),
      ),
    );

    await expect(restoreDocsVersion({ versionId }, fetchImpl)).resolves.toMatchObject({
      document: { id: docId, updateSeq: 5 },
      restoredVersion: { id: versionId },
      restoreVersion: { seq: 5 },
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.version.restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId }),
    });
  });

  it("resolves Docs suggestions through docs.suggestion.resolve", async () => {
    const suggestionId = "77777777-7777-4777-8777-777777777777";
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          id: suggestionId,
          documentId: docId,
          actorId: null,
          anchor: {},
          beforeText: "teh plan",
          afterText: "the plan",
          reason: "typo",
          status: "accepted",
          metadata: {},
          resolvedByActorId: "11111111-1111-4111-8111-111111111111",
          resolvedAt: "2026-05-21T12:05:00.000Z",
          createdAt: "2026-05-21T12:00:00.000Z",
          updatedAt: "2026-05-21T12:05:00.000Z",
        }),
      ),
    );

    await expect(
      resolveDocsSuggestion({ suggestionId, status: "accepted" }, fetchImpl),
    ).resolves.toMatchObject({ status: "accepted" });
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.suggestion.resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ suggestionId, status: "accepted" }),
    });
  });

  it("resolves Docs suggestions through docs.suggestion.resolve-batch", async () => {
    const suggestionIds = [
      "77777777-7777-4777-8777-777777777777",
      "88888888-8888-4888-8888-888888888888",
    ];
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        Response.json({
          suggestions: suggestionIds.map((id) => ({
            id,
            documentId: docId,
            actorId: null,
            anchor: {},
            beforeText: "teh plan",
            afterText: "the plan",
            reason: "typo",
            status: "accepted",
            metadata: {},
            resolvedByActorId: "11111111-1111-4111-8111-111111111111",
            resolvedAt: "2026-05-21T12:05:00.000Z",
            createdAt: "2026-05-21T12:00:00.000Z",
            updatedAt: "2026-05-21T12:05:00.000Z",
          })),
          count: 2,
        }),
      ),
    );

    const resolved = await resolveDocsSuggestions(
      { docId, suggestionIds, status: "accepted" },
      fetchImpl,
    );

    expect(resolved.count).toBe(2);
    expect(resolved.suggestions).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "accepted" })]),
    );
    expect(fetchImpl).toHaveBeenCalledWith("/api/tools/docs.suggestion.resolve-batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docId, suggestionIds, status: "accepted" }),
    });
  });

  it("surfaces backend tool errors", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ error: "missing docs scope" }, { status: 403 })),
    );

    await expect(createDocsDocument({ title: "Backend doc" }, fetchImpl)).rejects.toThrow(
      "missing docs scope",
    );
  });

  it("serializes Docs sync websocket updates and parses events", () => {
    const events: unknown[] = [];
    const client = createDocsSyncClient({
      docId,
      url: `ws://localhost/sync/docs/${docId}`,
      WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
      onEvent: (event) => events.push(event),
    });
    const socket = FakeWebSocket.instances[0];
    if (socket === undefined) {
      throw new Error("Expected websocket instance.");
    }

    client.sendUpdate({
      updateBase64: btoa("# Backend doc\n\nEdited body\n"),
      stateBase64: btoa("# Backend doc\n\nEdited body\n"),
      metadata: { source: "web.docs-shell" },
    });
    expect(socket.sent.map((payload) => JSON.parse(payload) as unknown)).toEqual([
      {
        type: "update",
        updateBase64: btoa("# Backend doc\n\nEdited body\n"),
        stateBase64: btoa("# Backend doc\n\nEdited body\n"),
        metadata: { source: "web.docs-shell" },
      },
    ]);

    socket.receive({
      type: "ready",
      documentId: docId,
      updateSeq: 2,
      stateBase64: btoa("# Synced doc\n"),
    });
    expect(events).toEqual([
      { type: "ready", documentId: docId, updateSeq: 2, stateBase64: btoa("# Synced doc\n") },
    ]);
  });
});

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static readonly instances: FakeWebSocket[] = [];

  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<(event: { readonly data?: string }) => void>>();
  readyState = FakeWebSocket.OPEN;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: { readonly data?: string }) => void): void {
    const listeners =
      this.#listeners.get(type) ?? new Set<(event: { readonly data?: string }) => void>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", {});
  }

  receive(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  private emit(type: string, event: { readonly data?: string }): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
