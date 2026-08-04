import { queryOptions } from "@tanstack/react-query";
import { getSessionUser } from "@/lib/auth";
import { listCalendarEvents } from "@/features/calendar/api";
import { listDrive, searchDrive, type DriveApiEntry } from "@/features/drive/api";
import { formatLabelFromEntry, previewFromEntry } from "@/features/drive/drive-data";
import { driveEntryBelongsToSurface } from "@/features/drive/format-surface";
import { entryFromSearchHit } from "@/features/drive/queries";
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
} from "./api";
import { formatModified, type DocSummary } from "./data";
import { docsQueryKeys, type DocsDocumentExportQueryInput } from "./query-keys";

export { docsQueryKeys };
export type { DocsDocumentExportQueryInput };

export interface DocsSmartChipPickerOption {
  readonly id: string;
  readonly label: string;
}

export interface DocsSmartChipPickerData {
  readonly people: readonly DocsSmartChipPickerOption[];
  readonly documents: readonly DocsSmartChipPickerOption[];
  readonly files: readonly DocsSmartChipPickerOption[];
  readonly events: readonly DocsSmartChipPickerOption[];
}

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
      const [peopleResult, documentsResult, filesResult, eventsResult] = await Promise.allSettled([
        listPeopleDirectory({ limit: 25 }),
        listDocsDocuments({ limit: 25 }),
        listDrive({
          folderId: null,
          acrossFolders: true,
          limit: 25,
        }),
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
        files:
          filesResult.status === "fulfilled"
            ? filesResult.value
                .filter((entry) => entry.deletedAt === null && entry.type === "file")
                .map((entry) => ({
                  id: entry.id,
                  label: entry.name.trim() || "Untitled file",
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
 * Native Helix docs open through `/docs/:documentId`. Foreign-format files
 * (DOCX, RTF, ODT, etc.) are imported into a fresh native helix-doc on first
 * open via the universal editor router, then routed to `/docs/:documentId`.
 */
export function docsListFromDriveQueryOptions(
  input: { readonly limit?: number; readonly query?: string } = {},
) {
  const query = input.query?.trim() ?? "";
  const limit = input.limit ?? 100;
  const searchLimit = Math.min(limit, 100);
  return queryOptions({
    queryKey: [...docsQueryKeys.listFromDrive(), "app-docs", query, limit] as const,
    queryFn: async (): Promise<readonly DocSummary[]> => {
      const entries =
        query.length > 0
          ? (await searchDrive({ query, folderId: null, limit: searchLimit })).map(
              entryFromSearchHit,
            )
          : await listDrive({
              folderId: null,
              includeTrashed: true,
              acrossFolders: true,
              app: "docs",
              limit,
            });
      return entries
        .filter((entry) => entry.type === "file" && isDocumentLike(entry))
        .map((entry): DocSummary => {
          const preview = previewFromEntry(entry);
          const owner = ownerLabelFromEntry(entry);
          return {
            id: entry.id,
            title: titleForDocumentEntry(entry),
            owner,
            modified: formatModified(entry.updatedAt),
            shared: (entry.metadata?.sharedCount as number | undefined) ?? 1,
            folder: (entry.metadata?.folder as string | undefined) ?? "Product",
            starred: entry.metadata?.starred === true,
            mine: mineFromEntry(entry, owner),
            deletedAt: entry.deletedAt,
            source: "backend",
            ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
            formatLabel: formatLabelFromEntry(entry),
            ...(preview === undefined ? {} : { preview }),
            ...(typeof entry.metadata?.editorEngine === "string"
              ? { editorEngine: entry.metadata.editorEngine }
              : {}),
            ...(typeof entry.metadata?.formatVersion === "number"
              ? { formatVersion: entry.metadata.formatVersion }
              : {}),
            openMode: hasDocumentExtension(entry.name) ? "office" : "native",
          };
        });
    },
    throwOnError: false,
  });
}

function ownerLabelFromEntry(entry: DriveApiEntry): string {
  const metadataOwner =
    typeof entry.metadata?.ownerName === "string" ? entry.metadata.ownerName : "";
  return entry.ownerDisplayName?.trim() || metadataOwner.trim() || "You";
}

function mineFromEntry(entry: DriveApiEntry, owner: string): boolean {
  if (typeof entry.metadata?.mine === "boolean") {
    return entry.metadata.mine;
  }
  return owner.trim().toLowerCase() === "you";
}

function titleForDocumentEntry(entry: DriveApiEntry): string {
  const metadataTitle = (entry.metadata?.title as string | undefined)?.trim();
  if (hasDocumentExtension(entry.name)) {
    return entry.name.trim() || metadataTitle || "Untitled document";
  }
  if (entry.app === "docs") {
    return metadataTitle || entry.name.replace(/\.(helixdoc)$/iu, "").trim() || "Untitled document";
  }
  return entry.name.trim() || metadataTitle || "Untitled document";
}

function hasDocumentExtension(name: string): boolean {
  return driveEntryBelongsToSurface({ app: null, name: name.trim(), mimeType: undefined }, "docs");
}

/** True when a drive entry should appear in the Docs list — DOCX, DOC,
 *  RTF, ODT, or a legacy native `app="docs"` row. */
function isDocumentLike(entry: {
  readonly app?: string | null;
  readonly mimeType?: string;
  readonly name: string;
}): boolean {
  return driveEntryBelongsToSurface(entry, "docs");
}
