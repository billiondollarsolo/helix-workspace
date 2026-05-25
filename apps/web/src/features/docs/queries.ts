import { queryOptions } from "@tanstack/react-query";
import { getSessionUser } from "@/lib/auth";
import { listCalendarEvents } from "@/features/calendar/api";
import { listDrive } from "@/features/drive/api";
import { formatLabelFromEntry } from "@/features/drive/drive-data";
import { listPeopleDirectory } from "@/features/people/api";
import {
  exportDocsDocument,
  getDocsDocument,
  getNativeDocumentSession,
  listDocsAskHistory,
  listDocsDocuments,
  listDocsComments,
  listDocsSuggestions,
  listDocsVersions,
  type DocsCommentStatusFilter,
  type DocsSuggestionStatus,
  type DocsExportFormat,
} from "./api";
import { formatModified, type DocSummary } from "./data";

export interface DocsDocumentExportQueryInput {
  readonly docId: string;
  readonly format?: DocsExportFormat;
  readonly includeComments?: boolean;
  readonly filename?: string;
}

export interface DocsSmartChipPickerOption {
  readonly id: string;
  readonly label: string;
}

export interface DocsSmartChipPickerData {
  readonly people: readonly DocsSmartChipPickerOption[];
  readonly documents: readonly DocsSmartChipPickerOption[];
  readonly events: readonly DocsSmartChipPickerOption[];
}

export const docsQueryKeys = {
  document: (docId: string) => ["docs", "document", docId] as const,
  nativeSession: (docId: string) => ["docs", "native-session", docId] as const,
  documentExport: (input: DocsDocumentExportQueryInput) =>
    [
      "docs",
      "document-export",
      input.docId,
      input.format ?? "markdown",
      input.includeComments ?? true,
      input.filename ?? "",
    ] as const,
  comments: (docId: string, status?: DocsCommentStatusFilter) =>
    status === undefined
      ? (["docs", "comments", docId] as const)
      : (["docs", "comments", docId, status] as const),
  suggestions: (docId: string, status?: DocsSuggestionStatus) =>
    status === undefined
      ? (["docs", "suggestions", docId] as const)
      : (["docs", "suggestions", docId, status] as const),
  versions: (docId: string) => ["docs", "versions", docId] as const,
  askHistory: (docId: string) => ["docs", "ask-history", docId] as const,
  smartChipPicker: () => ["docs", "smart-chip-picker"] as const,
};

/** Fetches a single backend document (`docs.get`). */
export function docsDocumentQueryOptions(docId: string) {
  return queryOptions({
    queryKey: docsQueryKeys.document(docId),
    queryFn: () => getDocsDocument({ docId }),
    throwOnError: false,
  });
}

export function nativeDocumentSessionQueryOptions(docId: string) {
  return queryOptions({
    queryKey: docsQueryKeys.nativeSession(docId),
    queryFn: () => getNativeDocumentSession({ documentId: docId }),
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

/** Lists comments for a document. */
export function docsCommentsQueryOptions(docId: string, status: DocsCommentStatusFilter = "open") {
  return queryOptions({
    queryKey: docsQueryKeys.comments(docId, status),
    queryFn: () => listDocsComments({ docId, status }),
    throwOnError: false,
  });
}

export function docsSuggestionsQueryOptions(docId: string, status?: DocsSuggestionStatus) {
  return queryOptions({
    queryKey: docsQueryKeys.suggestions(docId, status),
    queryFn: () => listDocsSuggestions({ docId, ...(status === undefined ? {} : { status }) }),
    throwOnError: false,
  });
}

export function docsVersionsQueryOptions(docId: string) {
  return queryOptions({
    queryKey: docsQueryKeys.versions(docId),
    queryFn: () => listDocsVersions({ docId, limit: 25 }),
    throwOnError: false,
  });
}

export function docsAskHistoryQueryOptions(docId: string) {
  return queryOptions({
    queryKey: docsQueryKeys.askHistory(docId),
    queryFn: () => listDocsAskHistory({ docId, limit: 10 }),
    throwOnError: false,
  });
}

export function docsSmartChipPickerQueryOptions() {
  return queryOptions({
    queryKey: docsQueryKeys.smartChipPicker(),
    queryFn: async (): Promise<DocsSmartChipPickerData> => {
      const [peopleResult, documentsResult, eventsResult] = await Promise.allSettled([
        listPeopleDirectory({ limit: 25 }),
        listDocsDocuments({ limit: 25 }),
        listCalendarEvents({ limit: 25 }),
      ]);
      return {
        people:
          peopleResult.status === "fulfilled"
            ? peopleResult.value.map((person) => ({
                id: person.id,
                label: person.displayName.trim() || person.email || "Unknown person",
              }))
            : [],
        documents:
          documentsResult.status === "fulfilled"
            ? documentsResult.value.map((document) => ({
                id: document.id,
                label: document.title.trim() || "Untitled document",
              }))
            : [],
        events:
          eventsResult.status === "fulfilled"
            ? eventsResult.value.map((event) => ({
                id: event.id,
                label: event.title.trim() || "Untitled event",
              }))
            : [],
      };
    },
    staleTime: 60_000,
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
 * The Docs list is sourced from Drive entries so native Helix documents and
 * uploaded word-processor files appear in one place.
 *
 * Native Helix docs open through `/docs/:documentId`; OOXML files still open
 * through `/edit/:objectId` via OnlyOffice from the Drive surface.
 */
export function docsListFromDriveQueryOptions(input: { readonly limit?: number } = {}) {
  return queryOptions({
    queryKey: ["docs", "list-from-drive", input.limit ?? 100] as const,
    queryFn: async (): Promise<readonly DocSummary[]> => {
      const entries = await listDrive({
        folderId: null,
        acrossFolders: true,
        limit: input.limit ?? 100,
      });
      return entries
        .filter(
          (entry) => entry.type === "file" && entry.deletedAt === null && isDocumentLike(entry),
        )
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
            ...(typeof entry.metadata?.editorEngine === "string"
              ? { editorEngine: entry.metadata.editorEngine }
              : {}),
            ...(typeof entry.metadata?.formatVersion === "number"
              ? { formatVersion: entry.metadata.formatVersion }
              : {}),
          }),
        );
    },
    throwOnError: false,
  });
}

/** True when a drive entry should appear in the Docs list — DOCX, DOC,
 *  RTF, ODT, or a legacy native `app="docs"` row. */
function isDocumentLike(entry: {
  readonly app?: string | null;
  readonly mimeType?: string;
  readonly name: string;
}): boolean {
  if (entry.app === "docs") return true;
  const mime = entry.mimeType ?? "";
  if (
    mime.includes("wordprocessingml") ||
    mime === "application/msword" ||
    mime.includes("opendocument.text") ||
    mime === "application/rtf"
  ) {
    return true;
  }
  const name = entry.name.toLowerCase();
  return (
    name.endsWith(".docx") ||
    name.endsWith(".doc") ||
    name.endsWith(".rtf") ||
    name.endsWith(".odt") ||
    name.endsWith(".helixdoc")
  );
}
