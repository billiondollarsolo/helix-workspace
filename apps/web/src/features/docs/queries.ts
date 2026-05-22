import { queryOptions } from "@tanstack/react-query";
import { getSessionUser } from "@/lib/auth";
import { listDrive } from "@/features/drive/api";
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
 * List-page query sourced from `drive.list` filtered by `app:"docs"`.
 * Returns Drive entries mapped to `DocSummary` view-model rows.
 * The editor (`docs.get`) is unaffected — this replaces only the list query.
 */
export function docsListFromDriveQueryOptions(input: { readonly limit?: number } = {}) {
  return queryOptions({
    queryKey: ["docs", "list-from-drive", input.limit ?? 100] as const,
    queryFn: async (): Promise<readonly DocSummary[]> => {
      const entries = await listDrive({ folderId: null, app: "docs", limit: input.limit ?? 100 });
      return entries
        .filter((entry) => entry.type === "file" && entry.app === "docs" && entry.deletedAt === null)
        .map(
          (entry): DocSummary => ({
            id: entry.id,
            title:
              (entry.metadata?.title as string | undefined)?.trim() ||
              entry.name.replace(/\.doc$/u, "").trim() ||
              "Untitled document",
            owner: (entry.metadata?.ownerName as string | undefined) ?? "You",
            modified: formatModified(entry.updatedAt),
            shared: (entry.metadata?.sharedCount as number | undefined) ?? 1,
            folder: (entry.metadata?.folder as string | undefined) ?? "Product",
            starred: entry.metadata?.starred === true,
            mine: true,
            source: "backend",
          }),
        );
    },
    throwOnError: false,
  });
}
