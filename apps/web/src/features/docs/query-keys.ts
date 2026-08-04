import type { DocsCommentStatusFilter, DocsExportFormat, DocsSuggestionStatus } from "./api";

export interface DocsDocumentExportQueryInput {
  readonly docId: string;
  readonly format?: DocsExportFormat;
  readonly includeComments?: boolean;
  readonly filename?: string;
}

/**
 * Dependency-free query keys.
 *
 * Keep these separate from `queries.ts`, whose query functions intentionally
 * import the Docs, Drive, Calendar, and People API clients. Cache-only callers
 * should not pull that entire network layer into their bundle.
 */
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
  /** Prefix shared by every Drive-backed docs list; invalidate to refresh them all. */
  listFromDrive: () => ["docs", "list-from-drive"] as const,
  versions: (docId: string) => ["docs", "versions", docId] as const,
  askHistory: (docId: string) => ["docs", "ask-history", docId] as const,
  smartChipPicker: () => ["docs", "smart-chip-picker"] as const,
};
