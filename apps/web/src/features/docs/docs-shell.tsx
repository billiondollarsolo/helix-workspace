/* Docs surface — list view ⇄ editor, with the Share dialog.

   `DocsShell` renders the full standalone surface (route `_shell/docs/`).
   The Drive surface embeds the editor via `variant="drive-embedded"` +
   `initialDocumentId`; in that mode the list view and back button are hidden.

   Backend wiring:
   - List   → `drive.list` with `app:"docs"` (TanStack Query) merged over the
              handoff seed list.
   - New    → `docs.create` — creates a real backend document and opens it.
   When the backend is unavailable the surface falls back to seed data only. */

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { EditorsAlphaBadge, useEditorsAlpha } from "@/features/apps/editors-alpha";
import {
  deleteDriveObject,
  restoreDriveObject,
  setDriveObjectStarred,
  trashDriveObject,
  uploadDriveFile,
} from "@/features/drive/api";
import { driveQueryKeys } from "@/features/drive/queries";
import { createDocsDocument, migrateDocsDocumentToNative } from "./api";
import { DocList } from "./doc-list";
import type { DocSummary } from "./data";
import { docsListFromDriveQueryOptions } from "./queries";

const DOCS_LIST_DEFAULT_LIMIT = 100;
const DOCS_LIST_MAX_LIMIT = 250;
const DOCUMENT_IMPORT_ACCEPT = [
  ".docx",
  ".docm",
  ".dotx",
  ".dotm",
  ".doc",
  ".odt",
  ".rtf",
  ".txt",
  ".md",
  ".html",
  ".htm",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-word.document.macroEnabled.12",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
  "application/vnd.ms-word.template.macroEnabled.12",
  "application/msword",
  "application/vnd.oasis.opendocument.text",
  "application/rtf",
  "text/rtf",
  "text/plain",
  "text/markdown",
  "text/html",
].join(",");

function sentinelLimit(displayLimit: number, maxLimit: number): number {
  return displayLimit < maxLimit ? displayLimit + 1 : displayLimit;
}

export interface DocsShellProps {
  /** Open straight into the editor for this document id (used by Drive). */
  readonly initialDocumentId?: string;
  readonly initialOpenMode?: DocSummary["openMode"];
  readonly initialSearchQuery?: string;
  readonly onSearchQueryChange?: (query: string) => void;
  /** `"drive-embedded"` hides the list view + back button. */
  readonly variant?: "standalone" | "drive-embedded";
}

export function DocsShell({
  initialDocumentId,
  initialOpenMode,
  initialSearchQuery = "",
  onSearchQueryChange,
  variant = "standalone",
}: DocsShellProps = {}) {
  const embedded = variant === "drive-embedded";
  const queryClient = useQueryClient();
  const [folder, setFolder] = useState<string>("all");
  const [query, setQuery] = useState(initialSearchQuery);
  const [createError, setCreateError] = useState<Error | null>(null);
  const [importError, setImportError] = useState<Error | null>(null);
  const [migrationError, setMigrationError] = useState<Error | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [listLimit, setListLimit] = useState(DOCS_LIST_DEFAULT_LIMIT);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const fetchListLimit = sentinelLimit(listLimit, DOCS_LIST_MAX_LIMIT);
  const documentsQuery = useQuery(docsListFromDriveQueryOptions({ limit: fetchListLimit, query }));
  const isBackendUnavailable = documentsQuery.isError;
  const router = useRouter();
  const editorsAlpha = useEditorsAlpha();
  const invalidateLists = () => {
    void queryClient.invalidateQueries({ queryKey: ["docs", "list-from-drive"] });
    void queryClient.invalidateQueries({ queryKey: driveQueryKeys.all });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      createDocsDocument({
        title: "Untitled document",
        initialMarkdown: "",
        editorEngine: "helix-native-document",
        formatVersion: 1,
        metadata: { createdFrom: "web.docs-shell" },
      }),
    onMutate: () => {
      setCreateError(null);
      // No optimistic cache write — `docs.create` returns the canonical row,
      // which `onSuccess` invalidates the list against.
    },
    onError: (error) => {
      setCreateError(error instanceof Error ? error : new Error("Unknown create error."));
    },
    onSuccess: (document) => {
      setCreateError(null);
      void queryClient.invalidateQueries({ queryKey: ["docs", "list-from-drive"] });
      void router.navigate({ to: "/docs/$documentId", params: { documentId: document.id } });
    },
  });
  const importMutation = useMutation({
    onMutate: () => {
      setImportError(null);
    },
    onError: (error) => {
      setImportError(error instanceof Error ? error : new Error("Unknown import error."));
    },
    mutationFn: (file: File) => uploadDriveFile({ file, folderId: null }),
    onSuccess: (uploaded) => {
      setImportError(null);
      void queryClient.invalidateQueries({ queryKey: ["docs", "list-from-drive"] });
      void router.navigate({
        to: "/open/$objectId",
        params: { objectId: uploaded.objectId },
      });
    },
  });
  const migrationMutation = useMutation({
    onMutate: () => {
      setMigrationError(null);
    },
    onError: (error) => {
      setMigrationError(error instanceof Error ? error : new Error("Unknown migration error."));
    },
    mutationFn: (docId: string) => migrateDocsDocumentToNative({ docId }),
    onSuccess: (document) => {
      setMigrationError(null);
      void queryClient.invalidateQueries({ queryKey: ["docs", "list-from-drive"] });
      void router.navigate({ to: "/docs/$documentId", params: { documentId: document.id } });
    },
  });
  const trashMutation = useMutation({
    mutationFn: (objectId: string) => trashDriveObject(objectId),
    onMutate: () => {
      setActionError(null);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error : new Error("Unknown trash error."));
    },
    onSettled: invalidateLists,
  });
  const restoreMutation = useMutation({
    mutationFn: (objectId: string) => restoreDriveObject(objectId),
    onMutate: () => {
      setActionError(null);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error : new Error("Unknown restore error."));
    },
    onSettled: invalidateLists,
  });
  const deleteForeverMutation = useMutation({
    mutationFn: (objectId: string) => deleteDriveObject(objectId),
    onMutate: () => {
      setActionError(null);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error : new Error("Unknown delete error."));
    },
    onSettled: invalidateLists,
  });
  const starMutation = useMutation({
    mutationFn: (vars: { readonly objectId: string; readonly starred: boolean }) =>
      setDriveObjectStarred(vars.objectId, vars.starred),
    onMutate: () => {
      setActionError(null);
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error : new Error("Unknown star error."));
    },
    onSettled: invalidateLists,
  });

  // Native Helix documents open in the executable /docs/:documentId shell.
  useEffect(() => {
    if (initialDocumentId !== undefined) {
      void router.navigate({
        to: "/docs/$documentId",
        params: { documentId: initialDocumentId },
        search: initialOpenMode === "office" ? { open: "office" } : {},
      });
    }
  }, [initialDocumentId, initialOpenMode, router]);

  useEffect(() => {
    setQuery(initialSearchQuery);
  }, [initialSearchQuery]);

  useEffect(() => {
    setListLimit(DOCS_LIST_DEFAULT_LIMIT);
  }, [query]);

  const documents = useMemo<readonly DocSummary[]>(
    () => (documentsQuery.data ?? []).slice(0, listLimit),
    [documentsQuery.data, listLimit],
  );
  const hasMoreDocuments =
    (documentsQuery.data?.length ?? 0) > listLimit && listLimit < DOCS_LIST_MAX_LIMIT;

  // Document bodies are rendered by the standalone native editor route.

  function createDocument() {
    if (createMutation.isPending || !editorsAlpha.enabled) {
      return;
    }
    createMutation.mutate();
  }

  function openDocument(document: DocSummary) {
    void router.navigate({
      to: "/docs/$documentId",
      params: { documentId: document.id },
      search: document.openMode === "office" ? { open: "office" } : {},
    });
  }

  function chooseDocumentFile() {
    if (importMutation.isPending) {
      return;
    }
    importInputRef.current?.click();
  }

  function importDocumentFile(file: File | undefined) {
    if (file === undefined || importMutation.isPending) {
      return;
    }
    importMutation.mutate(file);
  }

  function migrateLegacyDocument(docId: string) {
    if (migrationMutation.isPending || !editorsAlpha.enabled) {
      return;
    }
    migrationMutation.mutate(docId);
  }

  function busyDocumentId(): string | null {
    if (trashMutation.isPending) return trashMutation.variables ?? null;
    if (restoreMutation.isPending) return restoreMutation.variables ?? null;
    if (deleteForeverMutation.isPending) return deleteForeverMutation.variables ?? null;
    if (starMutation.isPending) return starMutation.variables?.objectId ?? null;
    return null;
  }

  if (embedded) {
    // Drive opens native documents through /docs/:documentId directly, so the
    // old embedded list/editor variant no longer mounts an editor surface.
    return null;
  }

  return (
    <SurfaceFrame
      title="Docs"
      icon={<Icons.Doc />}
      searchPlaceholder="Search documents"
      searchValue={query}
      onSearchChange={(nextQuery) => {
        setQuery(nextQuery);
        onSearchQueryChange?.(nextQuery);
      }}
      actions={
        <>
          <input
            ref={importInputRef}
            type="file"
            accept={DOCUMENT_IMPORT_ACCEPT}
            aria-label="Import document"
            hidden
            onChange={(event) => {
              importDocumentFile(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
          <button
            className="btn"
            type="button"
            onClick={chooseDocumentFile}
            disabled={importMutation.isPending}
          >
            <Icons.Upload /> {importMutation.isPending ? "Importing..." : "Import"}
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={createDocument}
            disabled={createMutation.isPending || !editorsAlpha.enabled}
            title={
              editorsAlpha.enabled
                ? undefined
                : "Editors alpha is disabled by an admin. Import and preview files from Drive."
            }
          >
            <Icons.Plus /> {createMutation.isPending ? "Creating…" : "New"}
          </button>
          {editorsAlpha.enabled ? <EditorsAlphaBadge /> : null}
        </>
      }
    >
      <DocList
        documents={documents}
        folder={folder}
        query={query}
        onFolder={setFolder}
        onNewDoc={createDocument}
        onImportDocument={chooseDocumentFile}
        onOpenDoc={openDocument}
        isBackendUnavailable={isBackendUnavailable}
        isLoading={documentsQuery.isLoading}
        hasMore={hasMoreDocuments}
        onShowMore={() =>
          setListLimit((current) =>
            Math.min(current + DOCS_LIST_DEFAULT_LIMIT, DOCS_LIST_MAX_LIMIT),
          )
        }
        isCreating={createMutation.isPending}
        isImporting={importMutation.isPending}
        editorsEnabled={editorsAlpha.enabled}
        migratingDocumentId={migrationMutation.variables ?? null}
        createError={createError}
        importError={importError}
        migrationError={migrationError}
        actionError={actionError}
        busyDocumentId={busyDocumentId()}
        onMigrateDocument={migrateLegacyDocument}
        onTrashDocument={(id) => trashMutation.mutate(id)}
        onRestoreDocument={(id) => restoreMutation.mutate(id)}
        onDeleteDocumentForever={(id) => deleteForeverMutation.mutate(id)}
        onSetDocumentStarred={(id, starred) => starMutation.mutate({ objectId: id, starred })}
      />
    </SurfaceFrame>
  );
}
