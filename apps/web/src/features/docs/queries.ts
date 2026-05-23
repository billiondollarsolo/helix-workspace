import { queryOptions } from "@tanstack/react-query";
import { getSessionUser } from "@/lib/auth";
import { listDrive } from "@/features/drive/api";
import { formatLabelFromEntry } from "@/features/drive/drive-data";
import {
  exportDocsDocument,
  getDocsDocument,
  listDocsComments,
  listDocsSuggestions,
  type DocsExportFormat,
} from "./api";
import { formatModified, type DocSummary } from "./data";

export interface DocsDocumentExportQueryInput {
  readonly docId: string;
  readonly format?: DocsExportFormat;
  readonly includeComments?: boolean;
  readonly filename?: string;
}

export const docsQueryKeys = {
  document: (docId: string) => ["docs", "document", docId] as const,
  documentExport: (input: DocsDocumentExportQueryInput) =>
    [
      "docs",
      "document-export",
      input.docId,
      input.format ?? "markdown",
      input.includeComments ?? true,
      input.filename ?? "",
    ] as const,
  comments: (docId: string) => ["docs", "comments", docId] as const,
  suggestions: (docId: string) => ["docs", "suggestions", docId] as const,
};

/** Fetches a single backend document (`docs.get`). */
export function docsDocumentQueryOptions(docId: string) {
  return queryOptions({
    queryKey: docsQueryKeys.document(docId),
    queryFn: () => getDocsDocument({ docId }),
    throwOnError: false,
  });
}

export function docsDocumentExportQueryOptions(input: DocsDocumentExportQueryInput) {
  return queryOptions({
    queryKey: docsQueryKeys.documentExport(input),
    queryFn: () =>
      exportDocsDocument({
        docId: input.docId,
        format: input.format ?? "markdown",
        includeComments: input.includeComments ?? true,
        ...(input.filename === undefined ? {} : { filename: input.filename }),
      }),
    throwOnError: false,
  });
}

/** Lists open comments for a document (derived from `docs.export`). */
export function docsCommentsQueryOptions(docId: string) {
  return queryOptions({
    queryKey: docsQueryKeys.comments(docId),
    queryFn: () => listDocsComments({ docId }),
    throwOnError: false,
  });
}

export function docsSuggestionsQueryOptions(docId: string) {
  return queryOptions({
    queryKey: docsQueryKeys.suggestions(docId),
    queryFn: () => listDocsSuggestions({ docId }),
    throwOnError: false,
  });
}

export interface DocsSessionActor {
  readonly actorId: string;
  readonly name: string;
}

/** Current session actor — used for awareness, caret labels, and owner copy. */
export function docsSessionQueryOptions() {
  return queryOptions({
    queryKey: ["docs", "session"] as const,
    queryFn: async (): Promise<DocsSessionActor> => {
      const user = await getSessionUser();
      return {
        actorId: user?.actorId ?? user?.id ?? "anonymous",
        name: user?.name?.trim() ?? "You",
      };
    },
    staleTime: 5 * 60_000,
    throwOnError: false,
  });
}

export function isBackendDocsDocumentId(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

/**
 * List-page query sourced from `drive.list`.
 *
 * After the .helixdoc → OOXML migration, "docs" means anything word-
 * processor-shaped the user can see:
 *  - migrated native Helix docs (now DOCX with `metadata.migratedFromNative`)
 *  - uploaded DOCX / DOC / RTF / ODT files
 *  - legacy native Helix docs still flagged `app="docs"` (any that escape
 *    the migration script — e.g. soft-deleted then restored)
 *
 * The editor route (`/edit/:objectId`) opens these via OnlyOffice.
 */
export function docsListFromDriveQueryOptions(input: { readonly limit?: number } = {}) {
  return queryOptions({
    queryKey: ["docs", "list-from-drive", input.limit ?? 100] as const,
    queryFn: async (): Promise<readonly DocSummary[]> => {
      const entries = await listDrive({ folderId: null, acrossFolders: true, limit: input.limit ?? 100 });
      return entries
        .filter((entry) => entry.type === "file" && entry.deletedAt === null && isDocumentLike(entry))
        .map(
          (entry): DocSummary => ({
            id: entry.id,
            title:
              (entry.metadata?.title as string | undefined)?.trim() ||
              entry.name.replace(/\.(docx?|rtf|odt|helixdoc)$/iu, "").trim() ||
              "Untitled document",
            owner: (entry.metadata?.ownerName as string | undefined) ?? "You",
            modified: formatModified(entry.updatedAt),
            shared: (entry.metadata?.sharedCount as number | undefined) ?? 1,
            folder: (entry.metadata?.folder as string | undefined) ?? "Product",
            starred: entry.metadata?.starred === true,
            mine: true,
            source: "backend",
            formatLabel: formatLabelFromEntry(entry),
          }),
        );
    },
    throwOnError: false,
  });
}

/** True when a drive entry should appear in the Docs list — DOCX, DOC,
 *  RTF, ODT, or a legacy native `app="docs"` row. */
function isDocumentLike(entry: { readonly app?: string | null; readonly mimeType?: string; readonly name: string }): boolean {
  if (entry.app === "docs") return true;
  const mime = entry.mimeType ?? "";
  if (mime.includes("wordprocessingml") || mime === "application/msword" || mime.includes("opendocument.text") || mime === "application/rtf") {
    return true;
  }
  const name = entry.name.toLowerCase();
  return name.endsWith(".docx") || name.endsWith(".doc") || name.endsWith(".rtf") || name.endsWith(".odt") || name.endsWith(".helixdoc");
}
