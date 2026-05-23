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
import { useRouter } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { createDocsDocument } from "./api";
import { DocList } from "./doc-list";
import type { DocSummary } from "./data";
import { docsListFromDriveQueryOptions } from "./queries";

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

  const documentsQuery = useQuery(docsListFromDriveQueryOptions({ limit: 100 }));
  const isBackendUnavailable = documentsQuery.isError;
  const router = useRouter();

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
      // After Phase 5: open the OnlyOffice editor instead of the in-page
      // Tiptap editor. The OO editor lives at /edit/:objectId.
      void router.navigate({ to: "/edit/$objectId", params: { objectId: document.id } });
    },
  });

  // After the .helixdoc → OOXML migration the in-page Tiptap editor is no
  // longer the destination. Any time something sets `openDocId` we redirect
  // to the OnlyOffice editor route instead. This keeps every legacy call
  // site (DocList row click, initialDocumentId from URL search, etc.)
  // working without rewriting them.
  useEffect(() => {
    if (openDocId !== null) {
      void router.navigate({ to: "/edit/$objectId", params: { objectId: openDocId } });
      setOpenDocId(null);
    }
  }, [openDocId, router]);

  useEffect(() => {
    if (initialDocumentId !== undefined) {
      setOpenDocId(initialDocumentId);
    }
  }, [initialDocumentId]);

  const documents = useMemo<readonly DocSummary[]>(
    () => documentsQuery.data ?? [],
    [documentsQuery.data],
  );

  // After Phase 7 (native editor retirement): we no longer render the
  // in-page DocEditor. The redirect-to-/edit effect above takes care of
  // navigating away whenever `openDocId` is non-null, so we never reach a
  // state where a document needs to be rendered here.

  function createDocument() {
    if (createMutation.isPending) {
      return;
    }
    createMutation.mutate(undefined, {
      onError: () => {
        // Backend unavailable — fall back to an offline draft so the
        // editor still opens.
        setOpenDocId(`doc-new-${String(Date.now())}`);
      },
    });
  }

  if (embedded) {
    // The drive-embedded variant used to inline the Tiptap editor below
    // a list. With OnlyOffice taking over, drive consumers should navigate
    // to /edit/:objectId directly — no embedded editor surface remains.
    return null;
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
      {/* When openDocId is set, the redirect effect above is mid-flight
          to /edit/:objectId. Render the list either way — the navigation
          completes before the next paint. */}
      <DocList
        documents={documents}
        folder={folder}
        query={query}
        onFolder={setFolder}
        onNewDoc={createDocument}
        onOpenDoc={setOpenDocId}
        isBackendUnavailable={isBackendUnavailable}
        isLoading={documentsQuery.isLoading}
        isCreating={createMutation.isPending}
      />
    </SurfaceFrame>
  );
}

