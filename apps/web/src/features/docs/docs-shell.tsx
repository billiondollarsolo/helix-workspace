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
import { createDocsDocument, importDocxDocument, migrateDocsDocumentToNative } from "./api";
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
  const [createError, setCreateError] = useState<Error | null>(null);
  const [importError, setImportError] = useState<Error | null>(null);
  const [migrationError, setMigrationError] = useState<Error | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);

  const documentsQuery = useQuery(docsListFromDriveQueryOptions({ limit: 100 }));
  const isBackendUnavailable = documentsQuery.isError;
  const router = useRouter();

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
    mutationFn: async (file: File) =>
      importDocxDocument({
        filename: file.name,
        title: titleFromDocxFilename(file.name),
        contentBase64: base64FromArrayBuffer(await file.arrayBuffer()),
        metadata: { source: "web.docs-shell.import-docx" },
      }),
    onSuccess: (document) => {
      setImportError(null);
      void queryClient.invalidateQueries({ queryKey: ["docs", "list-from-drive"] });
      void router.navigate({ to: "/docs/$documentId", params: { documentId: document.id } });
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

  // Native Helix documents open in the executable /docs/:documentId shell.
  useEffect(() => {
    if (initialDocumentId !== undefined) {
      void router.navigate({ to: "/docs/$documentId", params: { documentId: initialDocumentId } });
    }
  }, [initialDocumentId, router]);

  const documents = useMemo<readonly DocSummary[]>(
    () => documentsQuery.data ?? [],
    [documentsQuery.data],
  );

  // Document bodies are rendered by the standalone native editor route.

  function createDocument() {
    if (createMutation.isPending) {
      return;
    }
    createMutation.mutate();
  }

  function openDocument(document: DocSummary) {
    if (isNativeDocument(document)) {
      void router.navigate({ to: "/docs/$documentId", params: { documentId: document.id } });
      return;
    }
    void router.navigate({ to: "/edit/$objectId", params: { objectId: document.id } });
  }

  function chooseDocxFile() {
    if (importMutation.isPending) {
      return;
    }
    importInputRef.current?.click();
  }

  function importDocxFile(file: File | undefined) {
    if (file === undefined || importMutation.isPending) {
      return;
    }
    importMutation.mutate(file);
  }

  function migrateLegacyDocument(docId: string) {
    if (migrationMutation.isPending) {
      return;
    }
    migrationMutation.mutate(docId);
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
      onSearchChange={setQuery}
      actions={
        <>
          <input
            ref={importInputRef}
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            aria-label="Import DOCX"
            hidden
            onChange={(event) => {
              importDocxFile(event.currentTarget.files?.[0]);
              event.currentTarget.value = "";
            }}
          />
          <button
            className="btn"
            type="button"
            onClick={chooseDocxFile}
            disabled={importMutation.isPending}
          >
            <Icons.Upload /> {importMutation.isPending ? "Importing..." : "Import DOCX"}
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={createDocument}
            disabled={createMutation.isPending}
          >
            <Icons.Plus /> {createMutation.isPending ? "Creating…" : "New"}
          </button>
        </>
      }
    >
      <DocList
        documents={documents}
        folder={folder}
        query={query}
        onFolder={setFolder}
        onNewDoc={createDocument}
        onImportDocx={chooseDocxFile}
        onOpenDoc={openDocument}
        isBackendUnavailable={isBackendUnavailable}
        isLoading={documentsQuery.isLoading}
        isCreating={createMutation.isPending}
        isImporting={importMutation.isPending}
        migratingDocumentId={migrationMutation.variables ?? null}
        createError={createError}
        importError={importError}
        migrationError={migrationError}
        onMigrateDocument={migrateLegacyDocument}
      />
    </SurfaceFrame>
  );
}

function isNativeDocument(document: DocSummary): boolean {
  return document.editorEngine === "helix-native-document";
}

function titleFromDocxFilename(filename: string): string {
  return filename.replace(/\.docx$/iu, "").trim() || "Imported DOCX";
}

function base64FromArrayBuffer(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
