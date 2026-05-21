import { queryOptions } from "@tanstack/react-query";
import {
  exportDocsDocument,
  listDocsDocuments,
  listDocsSuggestions,
  type DocsExportFormat,
} from "./api";

export interface DocsDocumentExportQueryInput {
  readonly docId: string;
  readonly format?: DocsExportFormat;
  readonly includeComments?: boolean;
  readonly filename?: string;
}

export const docsQueryKeys = {
  documents: (input: { readonly query?: string; readonly limit?: number } = {}) =>
    ["docs", "documents", input.query?.trim() ?? "", input.limit ?? 50] as const,
  documentExport: (input: DocsDocumentExportQueryInput) =>
    [
      "docs",
      "document-export",
      input.docId,
      input.format ?? "markdown",
      input.includeComments ?? true,
      input.filename ?? "",
    ] as const,
  suggestions: (docId: string) => ["docs", "suggestions", docId] as const,
};

export function docsDocumentsQueryOptions(
  input: { readonly query?: string; readonly limit?: number } = {},
) {
  return queryOptions({
    queryKey: docsQueryKeys.documents(input),
    queryFn: () =>
      listDocsDocuments({
        ...(input.query === undefined ? {} : { query: input.query }),
        limit: input.limit ?? 50,
      }),
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

export function docsSuggestionsQueryOptions(docId: string) {
  return queryOptions({
    queryKey: docsQueryKeys.suggestions(docId),
    queryFn: () => listDocsSuggestions({ docId }),
    throwOnError: false,
  });
}

export function isBackendDocsDocumentId(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}
