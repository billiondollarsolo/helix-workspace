/* Docs surface — list view ⇄ editor, with the Share dialog.

   `DocsShell` renders the full standalone surface (route `_shell/docs/`).
   The Drive surface embeds the editor via `variant="drive-embedded"` +
   `initialDocumentId`; in that mode the list view and back button are hidden.

   Backend wiring:
   - List   → `drive.list` with `app:"docs"` (TanStack Query) merged over the
              handoff seed list.
   - New    → `docs.create` — creates a real backend document and opens it.
   When the backend is unavailable the surface falls back to seed data only. */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { createDocsDocument, type DocsApiDocument } from "./api";
import { DocEditor } from "./doc-editor";
import { DocList } from "./doc-list";
import { DOC_LIST, formatModified, type DocSummary } from "./data";
import { docsListFromDriveQueryOptions } from "./queries";
import { ShareDialog } from "./share-dialog";

export interface DocsShellProps {
  /** Open straight into the editor for this document id (used by Drive). */
  readonly initialDocumentId?: string;
  /** `"drive-embedded"` hides the list view + back button. */
  readonly variant?: "standalone" | "drive-embedded";
}

export function DocsShell({ initialDocumentId, variant = "standalone" }: DocsShellProps = {}) {
  const embedded = variant === "drive-embedded";
  const queryClient = useQueryClient();
  const [folder, setFolder] = useState<string>("all");
  const [query, setQuery] = useState("");
  const [openDocId, setOpenDocId] = useState<string | null>(initialDocumentId ?? null);
  const [showShare, setShowShare] = useState(false);

  const documentsQuery = useQuery(docsListFromDriveQueryOptions({ limit: 100 }));
  const isBackendUnavailable = documentsQuery.isError;

  const createMutation = useMutation({
    mutationFn: () =>
      createDocsDocument({
        title: "Untitled document",
        initialMarkdown: "",
        metadata: { createdFrom: "web.docs-shell" },
      }),
    onMutate: () => {
      // No optimistic cache write — `docs.create` returns the canonical row,
      // which `onSuccess` invalidates the list against.
    },
    onError: () => {
      // Surfaced by the caller's `onError` override (offline draft fallback).
    },
    onSuccess: (document) => {
      void queryClient.invalidateQueries({ queryKey: ["docs", "list-from-drive"] });
      // Open the real backend document so the editor connects to its Yjs room.
      setOpenDocId(document.id);
    },
  });

  useEffect(() => {
    if (initialDocumentId !== undefined) {
      setOpenDocId(initialDocumentId);
    }
  }, [initialDocumentId]);

  const documents = useMemo<readonly DocSummary[]>(
    () => mergeDriveDocuments(DOC_LIST, documentsQuery.data),
    [documentsQuery.data],
  );

  const openDocument =
    openDocId === null
      ? undefined
      : (documents.find((document) => document.id === openDocId) ??
        placeholderDocument(openDocId));

  const editor =
    openDocument !== undefined ? (
      <DocEditor
        document={openDocument}
        embedded={embedded}
        onBack={() => setOpenDocId(null)}
        onShare={() => setShowShare(true)}
      />
    ) : null;

  function createDocument() {
    if (createMutation.isPending) {
      return;
    }
    createMutation.mutate(undefined, {
      onError: () => {
        // Backend unavailable — fall back to an offline draft so the editor
        // still opens (it runs in offline mode for non-UUID ids).
        setOpenDocId(`doc-new-${String(Date.now())}`);
      },
    });
  }

  if (embedded) {
    return (
      <>
        {editor}
        {showShare && openDocument !== undefined ? (
          <ShareDialog
            documentTitle={openDocument.title}
            documentId={openDocument.id}
            onClose={() => setShowShare(false)}
          />
        ) : null}
      </>
    );
  }

  return (
    <SurfaceFrame
      title="Docs"
      icon={<Icons.Doc />}
      searchPlaceholder="Search documents"
      searchValue={query}
      onSearchChange={setQuery}
      actions={
        openDocId === null ? (
          <button
            className="btn primary"
            type="button"
            onClick={createDocument}
            disabled={createMutation.isPending}
          >
            <Icons.Plus /> {createMutation.isPending ? "Creating…" : "New"}
          </button>
        ) : null
      }
    >
      {openDocId === null ? (
        <DocList
          documents={documents}
          folder={folder}
          query={query}
          onFolder={setFolder}
          onNewDoc={createDocument}
          onOpenDoc={setOpenDocId}
          isBackendUnavailable={isBackendUnavailable}
          isCreating={createMutation.isPending}
        />
      ) : (
        editor
      )}
      {showShare && openDocument !== undefined ? (
        <ShareDialog
          documentTitle={openDocument.title}
          documentId={openDocument.id}
          onClose={() => setShowShare(false)}
        />
      ) : null}
    </SurfaceFrame>
  );
}

/**
 * Merges Drive-sourced `DocSummary` rows over the seed list,
 * de-duplicating by id. Used by `DocsShell` when `docsListFromDriveQueryOptions`
 * succeeds.
 */
export function mergeDriveDocuments(
  seed: readonly DocSummary[],
  driveRows: readonly DocSummary[] | undefined,
): readonly DocSummary[] {
  if (driveRows === undefined || driveRows.length === 0) {
    return seed;
  }
  const driveIds = new Set(driveRows.map((row) => row.id));
  return [...driveRows, ...seed.filter((document) => !driveIds.has(document.id))];
}

/** Merges live backend documents over the seed list, de-duplicating by id. */
export function mergeBackendDocuments(
  seed: readonly DocSummary[],
  backend: readonly DocsApiDocument[] | undefined,
): readonly DocSummary[] {
  if (backend === undefined || backend.length === 0) {
    return seed;
  }
  const backendRows = backend.map(documentFromApi);
  const backendIds = new Set(backendRows.map((row) => row.id));
  return [...backendRows, ...seed.filter((document) => !backendIds.has(document.id))];
}

function documentFromApi(document: DocsApiDocument): DocSummary {
  return {
    id: document.id,
    title: document.title.length > 0 ? document.title : "Untitled document",
    owner: "Alex Park",
    modified: formatModified(document.updatedAt),
    shared: 1,
    folder: "Product",
    starred: false,
    mine: true,
    source: "backend",
  };
}

function placeholderDocument(id: string): DocSummary {
  return {
    id,
    title: "Untitled document",
    owner: "Alex Park",
    modified: "Just now",
    shared: 0,
    folder: "Product",
    starred: false,
    mine: true,
    source: "local",
  };
}
