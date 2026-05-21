import {
  BadgeCheck,
  Bold,
  Check,
  CheckCircle2,
  Clock,
  FileText,
  Filter,
  Highlighter,
  History,
  Italic,
  ListChecks,
  LoaderCircle,
  MessageSquarePlus,
  MoreHorizontal,
  PenLine,
  Plus,
  Search,
  Share2,
  Sparkles,
  Strikethrough,
  Users,
  Wifi,
  WifiOff,
  X,
  type LucideIcon,
} from "lucide-react";
import { SuggestionSlot } from "@helix/sdk-web";
import { useForm } from "@tanstack/react-form";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { z } from "zod";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  createDocsComment,
  createDocsDocument,
  createDocsSuggestion,
  createDocsSyncClient,
  exportDocsDocument,
  resolveDocsSuggestion,
  type DocsApiDocument,
  type DocsSuggestion as DocsApiSuggestion,
  type DocsSyncClient,
  type DocsSyncEvent,
} from "./api";
import {
  docsDocumentExportQueryOptions,
  docsDocumentsQueryOptions,
  docsQueryKeys,
  docsSuggestionsQueryOptions,
  isBackendDocsDocumentId,
} from "./queries";

type DocsView = "recent" | "owned" | "shared" | "starred";
type DocStatus = "connected" | "saving" | "offline";
type CommentStatus = "open" | "resolved";
type SuggestionStatus = "pending" | "accepted" | "rejected";

interface DocsCollaborator {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly presence: "editing" | "viewing" | "away";
}

interface DocsDocument {
  readonly id: string;
  readonly title: string;
  readonly owner: string;
  readonly updatedAt: string;
  readonly folder: string;
  readonly shared: boolean;
  readonly starred: boolean;
  readonly collaborators: readonly string[];
  readonly wordCount: number;
  readonly body: readonly string[];
  readonly outline: readonly string[];
  readonly source: "backend" | "local";
  readonly sessionOnly?: boolean;
}

interface DocsComment {
  readonly id: string;
  readonly documentId: string;
  readonly authorId: string;
  readonly anchor: string;
  readonly body: string;
  readonly createdAt: string;
  readonly status: CommentStatus;
  readonly replies: readonly DocsCommentReply[];
}

interface DocsCommentReply {
  readonly id: string;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: string;
}

interface DocsSuggestion {
  readonly id: string;
  readonly documentId: string;
  readonly authorId: string;
  readonly anchor: string;
  readonly before: string;
  readonly after: string;
  readonly reason: string;
  readonly status: SuggestionStatus;
  /** Present when the suggestion is persisted by the Docs backend. */
  readonly backendId?: string;
}

interface DocsCommentFormValues {
  readonly body: string;
}

interface DocsCollaborationDoc {
  readonly doc: Y.Doc;
  readonly markdown: Y.Text;
}

const docsCommentBodySchema = z.string().trim().min(1, "Comment is required.");

const meId = "maya";

const collaborators: readonly DocsCollaborator[] = [
  { id: "maya", name: "Maya Chen", color: "#0f766e", presence: "editing" },
  { id: "sam", name: "Sam Patel", color: "#4f46e5", presence: "editing" },
  { id: "jordan", name: "Jordan Lee", color: "#854d0e", presence: "viewing" },
  { id: "riley", name: "Riley Brooks", color: "#be123c", presence: "away" },
  { id: "ari", name: "Ari Morgan", color: "#0e7490", presence: "editing" },
];

const viewItems: ReadonlyArray<{
  readonly id: DocsView;
  readonly label: string;
  readonly icon: LucideIcon;
}> = [
  { id: "recent", label: "Recent", icon: Clock },
  { id: "owned", label: "Owned by me", icon: FileText },
  { id: "shared", label: "Shared", icon: Users },
  { id: "starred", label: "Starred", icon: BadgeCheck },
];

const sampleDocsDocuments: readonly DocsDocument[] = [
  localDocument({
    id: "doc-sample-ai-services",
    title: "AI Services and Keys",
    folder: "My Drive",
    updatedAt: "6:06 AM",
    body: [
      "AI Services and Keys",
      "Model providers",
      "Keep provider API keys in the platform vault and rotate shared service credentials every quarter.",
      "Local testing",
      "Use Ollama for offline smoke tests when provider credentials are unavailable.",
    ],
  }),
  localDocument({
    id: "doc-sample-training",
    title: "Training Course Links",
    folder: "IT Career",
    updatedAt: "May 6",
    body: [
      "Training Course Links",
      "Current courses",
      "Track certificates, renewal dates, and internal onboarding resources in one shared document.",
      "Next actions",
      "Confirm access for Riley and collect updated links before Friday.",
    ],
  }),
  localDocument({
    id: "doc-sample-memorial",
    title: "Memorial Speech",
    folder: "Shared with me",
    updatedAt: "May 6",
    body: [
      "Memorial Speech",
      "Opening",
      "Thank everyone for coming and keep the tone warm, specific, and concise.",
      "Stories to include",
      "The garden, the lake trip, and the Sunday calls.",
    ],
  }),
];

const sampleDocsComments: readonly DocsComment[] = [
  {
    id: "comment-sample-1",
    documentId: "doc-sample-ai-services",
    authorId: "sam",
    anchor: "Model providers",
    body: "Can we add owner names for each provider before sharing this?",
    createdAt: "10 min ago",
    status: "open",
    replies: [],
  },
];

const sampleDocsSuggestions: readonly DocsSuggestion[] = [
  {
    id: "suggestion-sample-1",
    documentId: "doc-sample-training",
    authorId: "ari",
    anchor: "Next actions",
    before: "Confirm access for Riley and collect updated links before Friday.",
    after: "Confirm Riley's access and collect updated links before Friday.",
    reason: "Tighten wording for the action item.",
    status: "pending",
  },
];

export function DocsShell({
  initialDocumentId,
  variant = "standalone",
}: {
  readonly initialDocumentId?: string;
  readonly variant?: "standalone" | "drive-embedded";
} = {}) {
  const embeddedInDrive = variant === "drive-embedded";
  const queryClient = useQueryClient();
  const [view, setView] = useState<DocsView>("recent");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<DocStatus>("connected");
  const [selectedDocumentId, setSelectedDocumentId] = useState(() => initialDocumentId ?? "");
  const [docsDocuments, setDocsDocuments] = useState<readonly DocsDocument[]>(sampleDocsDocuments);
  const [documentBodies, setDocumentBodies] = useState<Readonly<Record<string, readonly string[]>>>(
    () => Object.fromEntries(sampleDocsDocuments.map((document) => [document.id, document.body])),
  );
  const [comments, setComments] = useState<readonly DocsComment[]>(sampleDocsComments);
  const [suggestions, setSuggestions] = useState<readonly DocsSuggestion[]>(sampleDocsSuggestions);
  const [activeAnchor, setActiveAnchor] = useState("");
  const [suggestionMode, setSuggestionMode] = useState(false);
  const [hasUnsavedCommentDraft, setHasUnsavedCommentDraft] = useState(false);
  const syncClientRef = useRef<DocsSyncClient | null>(null);
  const collaborationDocsRef = useRef(new Map<string, DocsCollaborationDoc>());
  const documentBodiesRef = useRef<Readonly<Record<string, readonly string[]>>>(documentBodies);
  const docsDocumentsRef = useRef<readonly DocsDocument[]>(docsDocuments);
  const docsDocumentsQuery = useQuery(docsDocumentsQueryOptions({ limit: 100 }));
  const selectedDocumentExportQuery = useQuery({
    ...docsDocumentExportQueryOptions({ docId: selectedDocumentId, includeComments: true }),
    enabled: isBackendDocsDocumentId(selectedDocumentId),
  });
  const docsSuggestionsQuery = useQuery({
    ...docsSuggestionsQueryOptions(selectedDocumentId),
    enabled: isBackendDocsDocumentId(selectedDocumentId),
  });
  useEffect(() => {
    docsDocumentsRef.current = docsDocuments;
  }, [docsDocuments]);

  useEffect(() => {
    documentBodiesRef.current = documentBodies;
  }, [documentBodies]);

  useEffect(() => {
    if (
      !embeddedInDrive ||
      !initialDocumentId ||
      docsDocuments.some((document) => document.id === initialDocumentId)
    ) {
      return;
    }
    const placeholderDocument = localDocument({
      id: initialDocumentId,
      title: "Untitled document",
      folder: "Drive",
      body: ["Untitled document", ""],
    });
    setDocsDocuments((current) => [placeholderDocument, ...current]);
    setDocumentBodies((current) => ({
      ...current,
      [placeholderDocument.id]: placeholderDocument.body,
    }));
  }, [docsDocuments, embeddedInDrive, initialDocumentId]);

  useEffect(() => {
    const result = docsDocumentsQuery.data;
    if (result === undefined) {
      return;
    }

    const backendDocuments = result.map((document) => documentFromApi(document));
    setDocsDocuments((current) => mergeBackendDocuments(current, backendDocuments));
    setStatus((current) => (current === "offline" ? "connected" : current));
    setSelectedDocumentId((current) => {
      if (current.length > 0 && !current.startsWith("doc-sample-")) {
        return current;
      }
      return backendDocuments[0]?.id ?? "";
    });
  }, [docsDocumentsQuery.data]);

  useEffect(() => {
    if (!docsDocumentsQuery.isError) {
      return;
    }

    setStatus("offline");
    const localDocuments = docsDocumentsRef.current.filter(
      (document) => document.source === "local",
    );
    setDocsDocuments(localDocuments);
    setSelectedDocumentId((selectedId) => {
      if (selectedId.length > 0 && localDocuments.some((document) => document.id === selectedId)) {
        return selectedId;
      }
      return localDocuments[0]?.id ?? "";
    });
  }, [docsDocumentsQuery.isError]);

  useEffect(() => {
    if (!initialDocumentId || initialDocumentId === selectedDocumentId) {
      return;
    }

    setSelectedDocumentId(initialDocumentId);
    setActiveAnchor("");
  }, [initialDocumentId, selectedDocumentId]);

  useEffect(() => {
    if (selectedDocumentId.length === 0) {
      const firstDocument = docsDocuments[0];
      if (firstDocument !== undefined) {
        setSelectedDocumentId(firstDocument.id);
        setActiveAnchor(firstDocument.outline[0] ?? firstDocument.title);
      }
      return;
    }

    if (activeAnchor.length > 0) {
      return;
    }

    const selectedDocument = docsDocuments.find((document) => document.id === selectedDocumentId);
    if (selectedDocument !== undefined) {
      setActiveAnchor(selectedDocument.outline[0] ?? selectedDocument.title);
    }
  }, [activeAnchor.length, docsDocuments, selectedDocumentId]);

  useEffect(() => {
    if (!isBackendDocsDocumentId(selectedDocumentId)) {
      return;
    }

    if (selectedDocumentExportQuery.isFetching) {
      setStatus("saving");
    }
  }, [selectedDocumentExportQuery.isFetching, selectedDocumentId]);

  useEffect(() => {
    if (!isBackendDocsDocumentId(selectedDocumentId) || !selectedDocumentExportQuery.isError) {
      return;
    }

    setStatus("offline");
  }, [selectedDocumentExportQuery.isError, selectedDocumentId]);

  useEffect(() => {
    const result = selectedDocumentExportQuery.data;
    if (result === undefined) {
      return;
    }

    setStatus("saving");
    const body = bodyFromMarkdown(result.text ?? decodeBase64(result.contentBase64));
    if (body.length > 0) {
      setDocumentBodies((current) => ({ ...current, [result.docId]: body }));
      setDocsDocuments((current) => upsertExportedDocument(current, result.docId, body));
    }
    setStatus("connected");
  }, [selectedDocumentExportQuery.data]);

  useEffect(() => {
    const backendSuggestions = docsSuggestionsQuery.data;
    if (backendSuggestions === undefined || !isBackendDocsDocumentId(selectedDocumentId)) {
      return;
    }

    const merged = backendSuggestions.map((suggestion) =>
      suggestionFromApi(suggestion, selectedDocumentId),
    );
    const backendIds = new Set(merged.map((suggestion) => suggestion.backendId));
    setSuggestions((current) => [
      ...current.filter(
        (suggestion) =>
          suggestion.documentId !== selectedDocumentId ||
          (suggestion.backendId === undefined && !backendIds.has(suggestion.id)),
      ),
      ...merged,
    ]);
  }, [docsSuggestionsQuery.data, selectedDocumentId]);

  useEffect(() => {
    if (!isBackendDocsDocumentId(selectedDocumentId) || typeof WebSocket === "undefined") {
      syncClientRef.current?.close();
      syncClientRef.current = null;
      return;
    }

    const applySyncedPayload = (markdownBase64: string | null) => {
      if (markdownBase64 === null) {
        return;
      }
      const body = bodyFromMarkdown(
        markdownFromSyncPayload({
          body: documentBodiesRef.current[selectedDocumentId],
          collaborationDocs: collaborationDocsRef.current,
          documentId: selectedDocumentId,
          payloadBase64: markdownBase64,
        }),
      );
      setDocumentBodies((current) => ({ ...current, [selectedDocumentId]: body }));
      setDocsDocuments((current) => upsertExportedDocument(current, selectedDocumentId, body));
    };

    const handleSyncEvent = (event: DocsSyncEvent) => {
      if ("documentId" in event && event.documentId !== selectedDocumentId) {
        return;
      }

      if (event.type === "ready") {
        applySyncedPayload(event.stateBase64);
        setStatus("connected");
        return;
      }

      if (event.type === "update") {
        applySyncedPayload(event.updateBase64);
        setStatus("connected");
        return;
      }

      if (event.type === "error") {
        setStatus("offline");
      }
    };

    const client = createDocsSyncClient({
      docId: selectedDocumentId,
      onOpen: () => setStatus("connected"),
      onClose: () => {
        if (syncClientRef.current === client) {
          syncClientRef.current = null;
        }
      },
      onError: () => setStatus("offline"),
      onEvent: handleSyncEvent,
    });
    syncClientRef.current = client;

    return () => {
      client.close();
      if (syncClientRef.current === client) {
        syncClientRef.current = null;
      }
    };
  }, [selectedDocumentId]);

  const visibleDocuments = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return docsDocuments.filter((document) => {
      const matchesView =
        view === "recent"
          ? true
          : view === "owned"
            ? document.owner === "Maya Chen"
            : view === "shared"
              ? document.shared
              : document.starred;
      const matchesQuery =
        !normalizedQuery ||
        `${document.title} ${document.folder} ${document.owner}`
          .toLowerCase()
          .includes(normalizedQuery);
      return matchesView && matchesQuery;
    });
  }, [docsDocuments, query, view]);

  const selectedDocument =
    visibleDocuments.find((document) => document.id === selectedDocumentId) ?? visibleDocuments[0];
  const selectedBody = selectedDocument
    ? (documentBodies[selectedDocument.id] ?? selectedDocument.body)
    : [];
  const activeCollaborators = selectedDocument
    ? selectedDocument.collaborators.map(collaboratorById).filter(isCollaborator)
    : [];
  const documentComments = selectedDocument
    ? comments.filter((comment) => comment.documentId === selectedDocument.id)
    : [];
  const documentSuggestions = selectedDocument
    ? suggestions.filter((suggestion) => suggestion.documentId === selectedDocument.id)
    : [];
  const pendingSuggestionCount = documentSuggestions.filter(
    (suggestion) => suggestion.status === "pending",
  ).length;
  const openCommentCount = documentComments.filter((comment) => comment.status === "open").length;
  const editorContext = selectedDocument
    ? {
        resource: {
          id: selectedDocument.id,
          type: "docs.document",
          label: selectedDocument.title,
        },
        metadata: {
          status,
          openCommentCount,
          pendingSuggestionCount,
          collaborators: selectedDocument.collaborators,
        },
      }
    : undefined;

  const selectDocument = (documentId: string) => {
    setSelectedDocumentId(documentId);
    const document = docsDocuments.find((item) => item.id === documentId);
    setActiveAnchor(document?.outline[0] ?? "");
  };

  const createDocument = () => {
    const title = "Untitled document";
    const fallbackDocument = localDocument({
      id: `doc-local-${Date.now()}`,
      title,
      body: ["Untitled document", ""],
    });
    setStatus("saving");
    createDocsDocument({
      title,
      initialMarkdown: "# Untitled document\n",
      metadata: { source: "web.docs-shell" },
    })
      .then((document) => {
        const nextDocument = documentFromApi(document, { sessionOnly: true });
        setDocsDocuments((current) => [nextDocument, ...current]);
        setDocumentBodies((current) => ({
          ...current,
          [nextDocument.id]: bodyFromApiDocument(document),
        }));
        setSelectedDocumentId(nextDocument.id);
        setActiveAnchor(nextDocument.outline[0] ?? nextDocument.title);
        setStatus("connected");
      })
      .catch(() => {
        setDocsDocuments((current) => [fallbackDocument, ...current]);
        setDocumentBodies((current) => ({
          ...current,
          [fallbackDocument.id]: fallbackDocument.body,
        }));
        setSelectedDocumentId(fallbackDocument.id);
        setActiveAnchor(fallbackDocument.outline[0] ?? fallbackDocument.title);
        setStatus("offline");
      });
  };

  const exportSelectedDocument = () => {
    if (!selectedDocument) {
      return;
    }

    setStatus("saving");
    const localExport = () => {
      downloadMarkdownExport({
        filename: `${slugForFilename(selectedDocument.title)}.markdown`,
        text: markdownFromBody(selectedBody),
      });
      setStatus("connected");
    };

    if (!isBackendDocsDocumentId(selectedDocument.id)) {
      localExport();
      return;
    }

    void exportDocsDocument({
      docId: selectedDocument.id,
      format: "markdown",
      includeComments: true,
    })
      .then((result) => {
        downloadMarkdownExport({
          filename: result.filename,
          text: result.text ?? decodeBase64(result.contentBase64),
        });
        setStatus("connected");
      })
      .catch(() => {
        setStatus("offline");
      });
  };

  const updateDocumentBody = (nextBody: readonly string[]) => {
    if (!selectedDocument) {
      return;
    }

    const resolvedBody = nextBody.length > 0 ? nextBody : selectedBody;
    if (suggestionMode) {
      const change = firstBlockDiff(selectedBody, resolvedBody);
      if (change !== null) {
        proposeSuggestion(change);
      }
      return;
    }

    persistDocumentBody(selectedDocument, resolvedBody);
  };

  const persistDocumentBody = (document: DocsDocument, nextBody: readonly string[]) => {
    setStatus("saving");
    setDocumentBodies((current) => ({ ...current, [document.id]: nextBody }));
    if (isBackendDocsDocumentId(document.id) && syncClientRef.current?.isOpen()) {
      const markdown = markdownFromBody(nextBody);
      const encoded =
        yjsUpdateFromMarkdown({
          collaborationDocs: collaborationDocsRef.current,
          documentId: document.id,
          markdown,
        }) ?? encodeBase64(markdown);
      syncClientRef.current.sendUpdate({
        updateBase64: encoded,
        stateBase64: encoded,
        metadata: { source: "web.docs-shell" },
      });
    }
  };

  const finishSave = () => {
    if (status === "saving") {
      setStatus("connected");
    }
  };

  const submitComment = (values: DocsCommentFormValues) => {
    const body = values.body.trim();
    if (!selectedDocument || body.length === 0) {
      return false;
    }

    const anchor = activeAnchor || selectedDocument.outline[0] || selectedDocument.title;
    setComments((current) => [
      {
        id: `comment-local-${Date.now()}`,
        documentId: selectedDocument.id,
        authorId: meId,
        anchor,
        body,
        createdAt: "Now",
        status: "open",
        replies: [],
      },
      ...current,
    ]);
    if (isBackendDocsDocumentId(selectedDocument.id)) {
      void createDocsComment({
        docId: selectedDocument.id,
        body,
        anchor: { label: anchor },
        metadata: { source: "web.docs-shell" },
      }).catch(() => undefined);
    }
    return true;
  };

  const resolveComment = (commentId: string) => {
    setComments((current) =>
      current.map((comment) =>
        comment.id === commentId ? { ...comment, status: "resolved" } : comment,
      ),
    );
  };

  const updateSuggestionStatus = (suggestionId: string, nextStatus: SuggestionStatus) => {
    const suggestion = suggestions.find((item) => item.id === suggestionId);
    if (
      nextStatus === "accepted" &&
      suggestion?.status === "pending" &&
      selectedDocument?.id === suggestion.documentId &&
      // Backend-accepted suggestions are applied server-side; only locally-tracked
      // suggestions need the body rewritten here.
      suggestion.backendId === undefined
    ) {
      const currentBody = documentBodies[selectedDocument.id] ?? selectedDocument.body;
      const nextBody = applySuggestionToBody(currentBody, suggestion);
      if (nextBody !== currentBody) {
        persistDocumentBody(selectedDocument, nextBody);
        setStatus("connected");
      }
    }
    setSuggestions((current) =>
      current.map((item) =>
        item.id === suggestionId ? { ...item, status: nextStatus } : item,
      ),
    );

    if (suggestion?.backendId !== undefined && nextStatus !== "pending") {
      setStatus("saving");
      void resolveDocsSuggestion({
        suggestionId: suggestion.backendId,
        status: nextStatus,
      })
        .then(() => {
          void queryClient.invalidateQueries({
            queryKey: docsQueryKeys.suggestions(suggestion.documentId),
          });
          if (selectedDocument !== undefined && nextStatus === "accepted") {
            void queryClient.invalidateQueries({
              queryKey: docsQueryKeys.documentExport({
                docId: selectedDocument.id,
                includeComments: true,
              }),
            });
          }
          setStatus("connected");
        })
        .catch(() => setStatus("offline"));
    }
  };

  const proposeSuggestion = (input: { readonly before: string; readonly after: string }) => {
    if (!selectedDocument) {
      return;
    }

    const anchor = activeAnchor || selectedDocument.outline[0] || selectedDocument.title;
    const localSuggestion: DocsSuggestion = {
      id: `suggestion-local-${Date.now()}`,
      documentId: selectedDocument.id,
      authorId: meId,
      anchor,
      before: input.before,
      after: input.after,
      reason: "Proposed edit",
      status: "pending",
    };

    // The editor fires both a DOM `input` event and a Tiptap `onUpdate` for a single
    // change; collapse identical proposals so suggestion mode records one tracked change.
    let isDuplicate = false;
    setSuggestions((current) => {
      isDuplicate = current.some(
        (suggestion) =>
          suggestion.documentId === selectedDocument.id &&
          suggestion.status === "pending" &&
          suggestion.before === input.before &&
          suggestion.after === input.after,
      );
      return isDuplicate ? current : [localSuggestion, ...current];
    });
    if (isDuplicate) {
      return;
    }

    if (isBackendDocsDocumentId(selectedDocument.id)) {
      setStatus("saving");
      void createDocsSuggestion({
        docId: selectedDocument.id,
        beforeText: input.before,
        afterText: input.after,
        reason: "Proposed edit",
        anchor: { label: anchor },
        metadata: { source: "web.docs-shell" },
      })
        .then((created) => {
          setSuggestions((current) =>
            current.map((item) =>
              item.id === localSuggestion.id
                ? suggestionFromApi(created, selectedDocument.id)
                : item,
            ),
          );
          setStatus("connected");
        })
        .catch(() => setStatus("offline"));
    }
  };

  const resetFilters = () => {
    setQuery("");
    setView("recent");
  };

  return (
    <section className={embeddedInDrive ? "docs-page docs-page-embedded" : "docs-page"}>
      {embeddedInDrive ? null : (
        <aside className="docs-sidebar" aria-label="Docs navigation">
          <button className="docs-create-button" onClick={createDocument} type="button">
            <Plus aria-hidden="true" size={18} />
            New doc
          </button>

          <nav className="docs-nav" aria-label="Document views">
            {viewItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  aria-current={view === item.id ? "page" : undefined}
                  className={view === item.id ? "docs-nav-item active" : "docs-nav-item"}
                  key={item.id}
                  onClick={() => setView(item.id)}
                  type="button"
                >
                  <Icon aria-hidden="true" size={17} />
                  <span>{item.label}</span>
                  <strong>{countForView(item.id, docsDocuments)}</strong>
                </button>
              );
            })}
          </nav>

          <div className="docs-sync-card" aria-label="Docs sync status">
            <StatusIcon status={status} />
            <div>
              <strong>{statusLabel(status)}</strong>
              <span>Yjs awareness preview</span>
            </div>
          </div>
        </aside>
      )}

      <div className="docs-workspace" role="main" aria-labelledby="docs-title">
        <header className="docs-header">
          <div>
            <h1 id="docs-title">
              {embeddedInDrive ? (selectedDocument?.title ?? "Document") : "Docs"}
            </h1>
            <p>{embeddedInDrive ? "Stored in Drive" : `${visibleDocuments.length} documents`}</p>
          </div>
          <div className="docs-header-actions">
            <button
              className="helix-button helix-button-secondary"
              onClick={() => setStatus(status === "offline" ? "connected" : "offline")}
              type="button"
            >
              {status === "offline" ? (
                <Wifi aria-hidden="true" size={16} />
              ) : (
                <WifiOff aria-hidden="true" size={16} />
              )}
              {status === "offline" ? "Reconnect" : "Go offline"}
            </button>
            <button className="helix-button" type="button">
              <Share2 aria-hidden="true" size={16} />
              Share
            </button>
            <button
              className="helix-button helix-button-secondary"
              disabled={selectedDocument === undefined}
              onClick={exportSelectedDocument}
              type="button"
            >
              <FileText aria-hidden="true" size={16} />
              Export
            </button>
            <button className="icon-button" aria-label="More docs actions" type="button">
              <MoreHorizontal aria-hidden="true" size={17} />
            </button>
          </div>
        </header>

        <div className="docs-toolbar">
          <label className="docs-search">
            <Search aria-hidden="true" size={17} />
            <span className="sr-only">Search Docs</span>
            <input
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search documents"
              type="search"
              value={query}
            />
          </label>
          <div className="docs-format-group" aria-label="Editor formatting">
            <button aria-label="Bold" type="button">
              <Bold aria-hidden="true" size={16} />
            </button>
            <button aria-label="Italic" type="button">
              <Italic aria-hidden="true" size={16} />
            </button>
            <button aria-label="Strikethrough" type="button">
              <Strikethrough aria-hidden="true" size={16} />
            </button>
            <button aria-label="Highlight" type="button">
              <Highlighter aria-hidden="true" size={16} />
            </button>
            <button aria-label="Checklist" type="button">
              <ListChecks aria-hidden="true" size={16} />
            </button>
          </div>
          <button
            aria-pressed={suggestionMode}
            className={
              suggestionMode
                ? "helix-button docs-suggestion-mode-toggle active"
                : "helix-button helix-button-secondary docs-suggestion-mode-toggle"
            }
            onClick={() => setSuggestionMode((current) => !current)}
            type="button"
          >
            <PenLine aria-hidden="true" size={16} />
            {suggestionMode ? "Suggesting" : "Editing"}
          </button>
        </div>

        <div className={embeddedInDrive ? "docs-content docs-content-embedded" : "docs-content"}>
          {embeddedInDrive ? null : (
            <DocumentList
              documents={visibleDocuments}
              isBackendUnavailable={docsDocumentsQuery.isError}
              isLoading={docsDocumentsQuery.isPending && docsDocuments.length === 0}
              onReset={resetFilters}
              onSelect={selectDocument}
              selectedDocumentId={selectedDocument?.id}
            />
          )}
          <EditorShell
            activeAnchor={activeAnchor}
            body={selectedBody}
            collaborators={activeCollaborators}
            document={selectedDocument}
            editorContext={editorContext}
            onBlurBlock={finishSave}
            onSelectAnchor={setActiveAnchor}
            onUpdateBody={updateDocumentBody}
            status={status}
            suggestionMode={suggestionMode}
          />
          <CommentsPanel
            activeAnchor={activeAnchor}
            comments={documentComments}
            onCommentDraftDirtyChange={setHasUnsavedCommentDraft}
            onResolveComment={resolveComment}
            onSubmitComment={submitComment}
            onUpdateSuggestionStatus={updateSuggestionStatus}
            suggestions={documentSuggestions}
          />
        </div>
      </div>
      {embeddedInDrive ? null : (
        <UnsavedCommentBlockerDialog hasUnsavedCommentDraft={hasUnsavedCommentDraft} />
      )}
    </section>
  );
}

function UnsavedCommentBlockerDialog({
  hasUnsavedCommentDraft,
}: {
  readonly hasUnsavedCommentDraft: boolean;
}) {
  const unsavedDraftBlocker = useBlocker({
    shouldBlockFn: () => hasUnsavedCommentDraft,
    disabled: !hasUnsavedCommentDraft,
    enableBeforeUnload: false,
    withResolver: true,
  });

  return (
    <AlertDialog open={unsavedDraftBlocker.status === "blocked"}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved comment?</AlertDialogTitle>
          <AlertDialogDescription>
            Your comment draft has not been posted. Leave Docs and discard it, or stay here to keep
            editing.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => unsavedDraftBlocker.reset?.()}>Stay</AlertDialogCancel>
          <AlertDialogAction onClick={() => unsavedDraftBlocker.proceed?.()}>
            Leave
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DocumentList({
  documents: visibleDocuments,
  isBackendUnavailable,
  isLoading,
  onReset,
  onSelect,
  selectedDocumentId,
}: {
  readonly documents: readonly DocsDocument[];
  readonly isBackendUnavailable: boolean;
  readonly isLoading: boolean;
  readonly onReset: () => void;
  readonly onSelect: (documentId: string) => void;
  readonly selectedDocumentId: string | undefined;
}) {
  if (visibleDocuments.length === 0) {
    if (isLoading) {
      return (
        <div className="docs-state-panel" role="status">
          <LoaderCircle aria-hidden="true" size={22} />
          <h2>Loading Docs</h2>
          <p>Checking the Docs backend for your documents.</p>
        </div>
      );
    }

    if (isBackendUnavailable) {
      return (
        <div className="docs-state-panel" role="status">
          <WifiOff aria-hidden="true" size={22} />
          <h2>Docs backend unavailable</h2>
          <p>
            Backend documents are not available. Offline/local documents created in this session
            will appear here.
          </p>
        </div>
      );
    }

    return (
      <div className="docs-state-panel">
        <Filter aria-hidden="true" size={22} />
        <h2>No documents</h2>
        <p>No docs match the current view and search.</p>
        <button className="helix-button helix-button-secondary" onClick={onReset} type="button">
          Clear filters
        </button>
      </div>
    );
  }

  return (
    <div className="docs-list" aria-label="Document list">
      {isBackendUnavailable ? (
        <div className="docs-state-panel" role="status">
          <WifiOff aria-hidden="true" size={18} />
          <h2>Docs backend unavailable</h2>
          <p>Showing documents available in this session. Offline/local docs are not synced.</p>
        </div>
      ) : null}
      {visibleDocuments.map((document) => {
        const documentCollaborators = document.collaborators
          .map(collaboratorById)
          .filter(isCollaborator);
        return (
          <button
            className={
              document.id === selectedDocumentId ? "docs-list-row selected" : "docs-list-row"
            }
            key={document.id}
            onClick={() => onSelect(document.id)}
            type="button"
          >
            <span className="docs-list-icon">
              <FileText aria-hidden="true" size={20} />
            </span>
            <span className="docs-list-main">
              <span className="docs-list-topline">
                <strong>{document.title}</strong>
                <time>{document.updatedAt}</time>
              </span>
              <span className="docs-list-meta">
                {document.folder} · {document.owner} · {document.wordCount.toLocaleString()} words
              </span>
              <span
                className="docs-collaborator-stack"
                aria-label={`${documentCollaborators.length} collaborators`}
              >
                {documentCollaborators.slice(0, 4).map((collaborator) => (
                  <span
                    className="docs-avatar"
                    key={collaborator.id}
                    style={{ "--docs-avatar-color": collaborator.color } as CSSProperties}
                    title={collaborator.name}
                  >
                    {initialsFor(collaborator.name)}
                  </span>
                ))}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function EditorShell({
  activeAnchor,
  body,
  collaborators: activeCollaborators,
  document,
  editorContext,
  onBlurBlock,
  onSelectAnchor,
  onUpdateBody,
  status,
  suggestionMode,
}: {
  readonly activeAnchor: string;
  readonly body: readonly string[];
  readonly collaborators: readonly DocsCollaborator[];
  readonly document: DocsDocument | undefined;
  readonly editorContext: Parameters<typeof SuggestionSlot>[0]["context"];
  readonly onBlurBlock: () => void;
  readonly onSelectAnchor: (anchor: string) => void;
  readonly onUpdateBody: (body: readonly string[]) => void;
  readonly status: DocStatus;
  readonly suggestionMode: boolean;
}) {
  if (!document) {
    return (
      <section className="docs-editor empty" aria-label="Document editor">
        <FileText aria-hidden="true" size={26} />
        <h2>No document selected</h2>
      </section>
    );
  }

  return (
    <section className="docs-editor" aria-label="Document editor">
      <header className="docs-editor-header">
        <div>
          <span className="docs-kicker">{document.folder}</span>
          <h2>{document.title}</h2>
        </div>
        <div className="docs-editor-status">
          <span>
            <StatusIcon status={status} />
            {statusLabel(status)}
          </span>
          <span>
            <History aria-hidden="true" size={14} />
            Updated {document.updatedAt}
          </span>
        </div>
      </header>

      <div className="docs-presence-bar" aria-label="Active collaborators">
        {activeCollaborators.map((collaborator) => (
          <span
            className={`docs-presence-chip ${collaborator.presence}`}
            key={collaborator.id}
            style={{ "--docs-avatar-color": collaborator.color } as CSSProperties}
          >
            <span className="docs-avatar">{initialsFor(collaborator.name)}</span>
            {collaborator.name}
          </span>
        ))}
      </div>

      <SuggestionSlot
        className="docs-suggestion-slot"
        context={editorContext}
        emptyFallback={<div className="docs-suggestion-empty">No smart-write suggestions</div>}
        loadingFallback={
          <div className="docs-suggestion-empty">Loading smart-write suggestions</div>
        }
        slotId="docs.smart-write"
      />

      {suggestionMode ? (
        <p className="docs-suggestion-mode-banner" role="status">
          <PenLine aria-hidden="true" size={14} />
          Suggesting mode: edits are saved as proposed changes for review, not applied
          directly.
        </p>
      ) : null}

      <div
        className={
          suggestionMode ? "docs-editor-page docs-editor-page-suggesting" : "docs-editor-page"
        }
        tabIndex={0}
      >
        <div className="docs-page-ruler" aria-hidden="true" />
        <TiptapDocumentEditor
          activeAnchor={activeAnchor}
          body={body}
          collaborators={activeCollaborators}
          document={document}
          onBlur={onBlurBlock}
          onSelectAnchor={onSelectAnchor}
          onUpdateBody={onUpdateBody}
          suggestionMode={suggestionMode}
        />
      </div>
    </section>
  );
}

function TiptapDocumentEditor({
  activeAnchor,
  body,
  collaborators: activeCollaborators,
  document,
  onBlur,
  onSelectAnchor,
  onUpdateBody,
  suggestionMode,
}: {
  readonly activeAnchor: string;
  readonly body: readonly string[];
  readonly collaborators: readonly DocsCollaborator[];
  readonly document: DocsDocument;
  readonly onBlur: () => void;
  readonly onSelectAnchor: (anchor: string) => void;
  readonly onUpdateBody: (body: readonly string[]) => void;
  readonly suggestionMode: boolean;
}) {
  const isApplyingExternalBodyRef = useRef(false);
  const editor = useEditor(
    {
      extensions: [StarterKit.configure({ undoRedo: false })],
      content: htmlFromBody(body),
      editorProps: {
        attributes: {
          "aria-label": suggestionMode ? "Document body (suggesting)" : "Document body",
          class: "docs-document-surface",
          "data-suggestion-mode": suggestionMode ? "true" : "false",
          role: "textbox",
        },
      },
      onSelectionUpdate: ({ editor: currentEditor }) => {
        onSelectAnchor(activeBlockFromEditor(currentEditor) ?? activeAnchor);
      },
      onUpdate: ({ editor: currentEditor }) => {
        if (isApplyingExternalBodyRef.current) {
          return;
        }
        onUpdateBody(bodyFromEditor(currentEditor));
      },
    },
    [document.id],
  );
  const bodyMarkdown = markdownFromBody(body);

  useEffect(() => {
    if (editor === null || editor.isDestroyed) {
      return;
    }
    if (safeMarkdownFromEditor(editor) === bodyMarkdown) {
      return;
    }

    isApplyingExternalBodyRef.current = true;
    try {
      editor.commands.setContent(htmlFromBody(body), { emitUpdate: false });
    } catch {
      // Tiptap can briefly expose a torn-down Editor during React 19 test unmounts.
    }
    isApplyingExternalBodyRef.current = false;
  }, [body, bodyMarkdown, editor]);

  return (
    <article
      className="docs-document-surface"
      data-suggestion-mode={suggestionMode ? "true" : "false"}
      onBlur={onBlur}
      onFocus={(event) => {
        onSelectAnchor(activeBlockFromEditorDom(event.currentTarget) ?? activeAnchor);
      }}
      onInput={(event) => {
        const nextBody = bodyFromEditorDom(event.currentTarget);
        if (nextBody.length > 0) {
          onUpdateBody(nextBody);
        }
      }}
    >
      {activeCollaborators
        .filter((collaborator) => collaborator.id !== meId && collaborator.presence === "editing")
        .slice(0, 1)
        .map((collaborator) => (
          <span
            className="docs-live-cursor"
            key={collaborator.id}
            style={{ "--docs-cursor-color": collaborator.color } as CSSProperties}
          >
            {collaborator.name}
          </span>
        ))}
      <EditorContent editor={editor} />
    </article>
  );
}

function CommentsPanel({
  activeAnchor,
  comments: documentComments,
  onCommentDraftDirtyChange,
  onResolveComment,
  onSubmitComment,
  onUpdateSuggestionStatus,
  suggestions: documentSuggestions,
}: {
  readonly activeAnchor: string;
  readonly comments: readonly DocsComment[];
  readonly onCommentDraftDirtyChange: (isDirty: boolean) => void;
  readonly onResolveComment: (commentId: string) => void;
  readonly onSubmitComment: (values: DocsCommentFormValues) => boolean;
  readonly onUpdateSuggestionStatus: (suggestionId: string, status: SuggestionStatus) => void;
  readonly suggestions: readonly DocsSuggestion[];
}) {
  const commentForm = useForm({
    defaultValues: {
      body: "",
    } satisfies DocsCommentFormValues,
    onSubmit: ({ value, formApi }) => {
      if (onSubmitComment(value)) {
        formApi.reset();
      }
    },
  });
  const openComments = documentComments.filter((comment) => comment.status === "open");
  const pendingSuggestions = documentSuggestions.filter(
    (suggestion) => suggestion.status === "pending",
  );

  return (
    <section className="docs-comments-panel" aria-label="Comments and suggestions">
      <header>
        <div>
          <h2>Review</h2>
          <p>
            {openComments.length} comments · {pendingSuggestions.length} suggestions
          </p>
        </div>
        <button className="icon-button" aria-label="Add comment" type="button">
          <MessageSquarePlus aria-hidden="true" size={17} />
        </button>
      </header>

      <form
        className="docs-comment-form"
        onSubmit={(event) => {
          event.preventDefault();
          void commentForm.handleSubmit();
        }}
      >
        <label>
          <span>Comment on</span>
          <strong>{activeAnchor || "Current selection"}</strong>
        </label>
        <commentForm.Field
          name="body"
          validators={{ onChange: validateWithZod(docsCommentBodySchema) }}
        >
          {(field) => (
            <textarea
              onChange={(event) => field.handleChange(event.target.value)}
              placeholder="Add a comment"
              value={field.state.value}
            />
          )}
        </commentForm.Field>
        <commentForm.Subscribe selector={(state) => state.values.body.trim().length === 0}>
          {(isCommentEmpty) => (
            <button className="helix-button" disabled={isCommentEmpty} type="submit">
              <PenLine aria-hidden="true" size={16} />
              Comment
            </button>
          )}
        </commentForm.Subscribe>
        <commentForm.Subscribe selector={(state) => state.values.body.trim().length > 0}>
          {(isCommentDirty) => (
            <CommentDraftDirtyObserver
              isDirty={isCommentDirty}
              onChange={onCommentDraftDirtyChange}
            />
          )}
        </commentForm.Subscribe>
      </form>

      <section className="docs-review-section">
        <h3>
          <MessageSquarePlus aria-hidden="true" size={16} />
          Comments
        </h3>
        {documentComments.length === 0 ? (
          <p className="docs-empty-copy">No comments on this document.</p>
        ) : null}
        {documentComments.map((comment) => (
          <article
            className={comment.status === "resolved" ? "docs-comment resolved" : "docs-comment"}
            key={comment.id}
          >
            <header>
              <span
                className="docs-avatar"
                style={
                  {
                    "--docs-avatar-color": collaboratorById(comment.authorId)?.color,
                  } as CSSProperties
                }
              >
                {initialsFor(collaboratorById(comment.authorId)?.name ?? "Unknown")}
              </span>
              <div>
                <strong>{collaboratorById(comment.authorId)?.name ?? "Unknown"}</strong>
                <time>{comment.createdAt}</time>
              </div>
              {comment.status === "resolved" ? (
                <CheckCircle2 aria-label="Resolved" size={16} />
              ) : null}
            </header>
            <span className="docs-anchor">{comment.anchor}</span>
            <p>{comment.body}</p>
            {comment.replies.map((reply) => (
              <div className="docs-comment-reply" key={reply.id}>
                <strong>{collaboratorById(reply.authorId)?.name ?? "Unknown"}</strong>
                <span>{reply.body}</span>
              </div>
            ))}
            {comment.status === "open" ? (
              <button
                className="helix-button helix-button-secondary"
                onClick={() => onResolveComment(comment.id)}
                type="button"
              >
                <Check aria-hidden="true" size={15} />
                Resolve
              </button>
            ) : null}
          </article>
        ))}
      </section>

      <section className="docs-review-section">
        <h3>
          <Sparkles aria-hidden="true" size={16} />
          Suggestions
        </h3>
        {documentSuggestions.length === 0 ? (
          <p className="docs-empty-copy">No suggestions on this document.</p>
        ) : null}
        {documentSuggestions.map((suggestion) => (
          <article className={`docs-suggestion ${suggestion.status}`} key={suggestion.id}>
            <header>
              <strong>{collaboratorById(suggestion.authorId)?.name ?? "Unknown"}</strong>
              <span>{suggestion.anchor}</span>
            </header>
            <p>{suggestion.reason}</p>
            <div className="docs-suggestion-diff">
              <del>{suggestion.before}</del>
              <ins>{suggestion.after}</ins>
            </div>
            {suggestion.status === "pending" ? (
              <div className="docs-suggestion-actions">
                <button
                  className="helix-button"
                  onClick={() => onUpdateSuggestionStatus(suggestion.id, "accepted")}
                  type="button"
                >
                  <Check aria-hidden="true" size={15} />
                  Accept
                </button>
                <button
                  className="helix-button helix-button-secondary"
                  onClick={() => onUpdateSuggestionStatus(suggestion.id, "rejected")}
                  type="button"
                >
                  <X aria-hidden="true" size={15} />
                  Reject
                </button>
              </div>
            ) : (
              <span className="docs-suggestion-state">{suggestion.status}</span>
            )}
          </article>
        ))}
      </section>
    </section>
  );
}

function CommentDraftDirtyObserver({
  isDirty,
  onChange,
}: {
  readonly isDirty: boolean;
  readonly onChange: (isDirty: boolean) => void;
}) {
  useEffect(() => {
    onChange(isDirty);
  }, [isDirty, onChange]);

  return null;
}

function StatusIcon({ status }: { readonly status: DocStatus }) {
  if (status === "saving") {
    return <LoaderCircle className="docs-status-icon saving" aria-hidden="true" size={16} />;
  }
  if (status === "offline") {
    return <WifiOff className="docs-status-icon offline" aria-hidden="true" size={16} />;
  }
  return <Wifi className="docs-status-icon connected" aria-hidden="true" size={16} />;
}

function statusLabel(status: DocStatus) {
  if (status === "saving") {
    return "Saving";
  }
  if (status === "offline") {
    return "Offline";
  }
  return "Connected";
}

function countForView(view: DocsView, sourceDocuments: readonly DocsDocument[]) {
  if (view === "owned") {
    return sourceDocuments.filter((document) => document.owner === "Maya Chen").length;
  }
  if (view === "shared") {
    return sourceDocuments.filter((document) => document.shared).length;
  }
  if (view === "starred") {
    return sourceDocuments.filter((document) => document.starred).length;
  }
  return sourceDocuments.length;
}

function upsertExportedDocument(
  current: readonly DocsDocument[],
  documentId: string,
  body: readonly string[],
): readonly DocsDocument[] {
  const outline = outlineFromBody(body);
  const existingDocument = current.find((document) => document.id === documentId);
  if (existingDocument === undefined) {
    return [
      backendDocument({
        id: documentId,
        title: body[0] ?? "Untitled document",
        body,
        sessionOnly: true,
      }),
      ...current,
    ];
  }

  return current.map((document) =>
    document.id === documentId
      ? {
          ...document,
          title: body[0] ?? document.title,
          wordCount: wordCountFor(body),
          outline,
        }
      : document,
  );
}

function mergeBackendDocuments(
  current: readonly DocsDocument[],
  backendDocuments: readonly DocsDocument[],
): readonly DocsDocument[] {
  const backendIds = new Set(backendDocuments.map((document) => document.id));
  const sessionDocuments = current.filter(
    (document) =>
      (document.source === "local" && !backendIds.has(document.id)) ||
      (document.sessionOnly === true && !backendIds.has(document.id)),
  );
  return [...sessionDocuments, ...backendDocuments];
}

function documentFromApi(
  document: DocsApiDocument,
  options: { readonly sessionOnly?: boolean } = {},
): DocsDocument {
  return backendDocument({
    id: document.id,
    title: document.title,
    body: bodyFromApiDocument(document),
    updatedAt: formatDocsTime(document.updatedAt),
    ...(options.sessionOnly === undefined ? {} : { sessionOnly: options.sessionOnly }),
  });
}

function localDocument(input: {
  readonly id: string;
  readonly title: string;
  readonly body: readonly string[];
  readonly folder?: string;
  readonly updatedAt?: string;
}): DocsDocument {
  return docsDocument({
    ...input,
    folder: input.folder ?? "Offline/local",
    shared: false,
    source: "local",
  });
}

function backendDocument(input: {
  readonly id: string;
  readonly title: string;
  readonly body: readonly string[];
  readonly updatedAt?: string;
  readonly sessionOnly?: boolean;
}): DocsDocument {
  return docsDocument({
    ...input,
    folder: "Docs",
    shared: true,
    source: "backend",
  });
}

function docsDocument(input: {
  readonly id: string;
  readonly title: string;
  readonly body: readonly string[];
  readonly folder: string;
  readonly shared: boolean;
  readonly source: "backend" | "local";
  readonly updatedAt?: string;
  readonly sessionOnly?: boolean;
}): DocsDocument {
  return {
    id: input.id,
    title: input.title,
    owner: "Maya Chen",
    updatedAt: input.updatedAt ?? "Now",
    folder: input.folder,
    shared: input.shared,
    starred: false,
    collaborators: [meId],
    wordCount: wordCountFor(input.body),
    outline: outlineFromBody(input.body),
    body: input.body,
    source: input.source,
    ...(input.sessionOnly === undefined ? {} : { sessionOnly: input.sessionOnly }),
  };
}

function bodyFromApiDocument(document: DocsApiDocument): readonly string[] {
  return bodyFromMarkdown(decodeBase64(document.ydocState ?? ""));
}

function bodyFromMarkdown(markdown: string): readonly string[] {
  const lines = markdown
    .split(/\r?\n/u)
    .map((line) => line.replace(/^#{1,6}\s+/u, "").trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines : ["Untitled document", ""];
}

function markdownFromBody(body: readonly string[]): string {
  const [title, ...blocks] = body;
  return [`# ${title ?? "Untitled document"}`, ...blocks].join("\n\n").trimEnd() + "\n";
}

function htmlFromBody(body: readonly string[]): string {
  const [title, ...blocks] = body.length > 0 ? body : ["Untitled document"];
  return [
    `<h1>${escapeHtml(title ?? "Untitled document")}</h1>`,
    ...blocks.map((block) => `<p>${escapeHtml(block)}</p>`),
  ].join("");
}

function bodyFromEditor(editor: Editor): readonly string[] {
  const blocks: string[] = [];
  editor.state.doc.descendants((node) => {
    if (!node.isTextblock) {
      return true;
    }

    const text = node.textContent.trim();
    if (text.length > 0) {
      blocks.push(text);
    }
    return false;
  });
  return blocks.length > 0 ? blocks : ["Untitled document", ""];
}

function safeMarkdownFromEditor(editor: Editor): string | undefined {
  try {
    return markdownFromBody(bodyFromEditor(editor));
  } catch {
    return undefined;
  }
}

function bodyFromEditorDom(container: HTMLElement): readonly string[] {
  const editorRoot = container.querySelector(".ProseMirror");
  const source = editorRoot instanceof HTMLElement ? editorRoot : container;
  const blocks = Array.from(source.querySelectorAll("h1, h2, h3, p, li"))
    .map((element) => element.textContent?.trim() ?? "")
    .filter((block) => block.length > 0);
  return blocks.length > 0 ? blocks : source.textContent?.trim() ? [source.textContent.trim()] : [];
}

function activeBlockFromEditor(editor: Editor): string | undefined {
  const { $from } = editor.state.selection;
  return $from.parent.textContent.trim() || undefined;
}

function activeBlockFromEditorDom(container: HTMLElement): string | undefined {
  const selection = window.getSelection();
  const anchorNode = selection?.anchorNode;
  if (anchorNode === undefined || anchorNode === null || !container.contains(anchorNode)) {
    return undefined;
  }

  const element =
    anchorNode instanceof HTMLElement ? anchorNode : (anchorNode.parentElement ?? undefined);
  const block = element?.closest("h1, h2, h3, p, li");
  return block?.textContent?.trim() || undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function validateWithZod<T>(schema: z.ZodType<T>) {
  return ({ value }: { readonly value: T }) => {
    const result = schema.safeParse(value);
    return result.success ? undefined : result.error.issues[0]?.message;
  };
}

function suggestionFromApi(
  suggestion: DocsApiSuggestion,
  documentId: string,
): DocsSuggestion {
  const anchorLabel = suggestion.anchor?.label;
  return {
    id: suggestion.id,
    backendId: suggestion.id,
    documentId,
    authorId: suggestion.actorId ?? meId,
    anchor: typeof anchorLabel === "string" && anchorLabel.length > 0 ? anchorLabel : "Document",
    before: suggestion.beforeText ?? "",
    after: suggestion.afterText ?? "",
    reason:
      typeof suggestion.reason === "string" && suggestion.reason.length > 0
        ? suggestion.reason
        : "Proposed edit",
    status: suggestion.status ?? "pending",
  };
}

/**
 * Returns the first paragraph block that differs between two document bodies, as a
 * before/after pair. Used by suggestion mode to capture an editor change as a tracked
 * change rather than persisting it directly.
 */
function firstBlockDiff(
  previousBody: readonly string[],
  nextBody: readonly string[],
): { readonly before: string; readonly after: string } | null {
  const length = Math.max(previousBody.length, nextBody.length);
  for (let index = 0; index < length; index += 1) {
    const before = previousBody[index] ?? "";
    const after = nextBody[index] ?? "";
    if (before !== after && before.length > 0) {
      return { before, after };
    }
  }
  return null;
}

function applySuggestionToBody(
  body: readonly string[],
  suggestion: DocsSuggestion,
): readonly string[] {
  const anchorIndex = body.findIndex((block) => block === suggestion.anchor);
  const anchoredMatchIndex =
    anchorIndex === -1
      ? -1
      : body.findIndex((block, index) => index >= anchorIndex && block.includes(suggestion.before));
  const matchIndex =
    anchoredMatchIndex === -1
      ? body.findIndex((block) => block.includes(suggestion.before))
      : anchoredMatchIndex;

  if (matchIndex === -1) {
    return body;
  }

  return body.map((block, index) =>
    index === matchIndex ? block.replace(suggestion.before, suggestion.after) : block,
  );
}

function outlineFromBody(body: readonly string[]): readonly string[] {
  const headings = body.filter((block, index) => index === 0 || block.length <= 80).slice(0, 4);
  return headings.length > 0 ? headings : ["Untitled document"];
}

function wordCountFor(body: readonly string[]): number {
  return body.join(" ").split(/\s+/u).filter(Boolean).length;
}

function decodeBase64(value: string | null | undefined): string {
  if (value === undefined || value === null || value.length === 0) {
    return "";
  }
  try {
    return atob(value);
  } catch {
    return "";
  }
}

function encodeBase64(value: string): string {
  try {
    return btoa(value);
  } catch {
    return "";
  }
}

function markdownFromSyncPayload(input: {
  readonly body: readonly string[] | undefined;
  readonly collaborationDocs: Map<string, DocsCollaborationDoc>;
  readonly documentId: string;
  readonly payloadBase64: string;
}): string {
  const update = uint8ArrayFromBase64(input.payloadBase64);
  if (update !== null) {
    try {
      const collaborationDoc = getCollaborationDoc({
        body: input.body,
        collaborationDocs: input.collaborationDocs,
        documentId: input.documentId,
      });
      Y.applyUpdate(collaborationDoc.doc, update, "remote");
      const markdown = collaborationMarkdown(collaborationDoc);
      if (markdown.trim().length > 0) {
        return markdown;
      }
    } catch {
      // Older sync servers sent Markdown snapshots in the same base64 field.
    }
  }

  return decodeBase64(input.payloadBase64);
}

function yjsUpdateFromMarkdown(input: {
  readonly collaborationDocs: Map<string, DocsCollaborationDoc>;
  readonly documentId: string;
  readonly markdown: string;
}): string | undefined {
  try {
    const collaborationDoc = getCollaborationDoc({
      body: bodyFromMarkdown(input.markdown),
      collaborationDocs: input.collaborationDocs,
      documentId: input.documentId,
    });
    const currentMarkdown = collaborationMarkdown(collaborationDoc);
    if (currentMarkdown !== input.markdown) {
      collaborationDoc.doc.transact(() => {
        collaborationDoc.markdown.delete(0, collaborationDoc.markdown.length);
        collaborationDoc.markdown.insert(0, input.markdown);
      }, "web.docs-shell");
    }

    return base64FromUint8Array(Y.encodeStateAsUpdate(collaborationDoc.doc));
  } catch {
    return undefined;
  }
}

function getCollaborationDoc(input: {
  readonly body: readonly string[] | undefined;
  readonly collaborationDocs: Map<string, DocsCollaborationDoc>;
  readonly documentId: string;
}): DocsCollaborationDoc {
  const existing = input.collaborationDocs.get(input.documentId);
  if (existing !== undefined) {
    return existing;
  }

  const doc = new Y.Doc();
  const markdown = doc.getText("markdown");
  const initialMarkdown = markdownFromBody(input.body ?? ["Untitled document", ""]);
  if (initialMarkdown.trim().length > 0) {
    doc.transact(() => {
      markdown.insert(0, initialMarkdown);
    }, "web.docs-shell:init");
  }

  const collaborationDoc = { doc, markdown };
  input.collaborationDocs.set(input.documentId, collaborationDoc);
  return collaborationDoc;
}

function collaborationMarkdown(collaborationDoc: DocsCollaborationDoc): string {
  return collaborationDoc.markdown.toJSON();
}

function uint8ArrayFromBase64(value: string): Uint8Array | null {
  const decoded = decodeBase64(value);
  if (decoded.length === 0) {
    return null;
  }

  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function base64FromUint8Array(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return encodeBase64(binary);
}

function downloadMarkdownExport(input: { readonly filename: string; readonly text: string }): void {
  const blob = new Blob([input.text], { type: "text/markdown; charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = input.filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

function slugForFilename(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return slug.length > 0 ? slug : "untitled-document";
}

function formatDocsTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "Now";
  }
  const ageMs = Date.now() - timestamp;
  if (ageMs >= 0 && ageMs < 60_000) {
    return "Now";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp));
}

function collaboratorById(collaboratorId: string) {
  return collaborators.find((collaborator) => collaborator.id === collaboratorId);
}

function isCollaborator(
  collaborator: DocsCollaborator | undefined,
): collaborator is DocsCollaborator {
  return Boolean(collaborator);
}

function initialsFor(name: string) {
  return name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}
