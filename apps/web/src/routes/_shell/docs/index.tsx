import { createFileRoute } from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";
import {
  docsDocumentExportQueryOptions,
  docsDocumentsQueryOptions,
  isBackendDocsDocumentId,
} from "@/features/docs/queries";

interface DocsRouteSearch {
  readonly doc?: string;
}

const docsRouteSearchSchema = z
  .object({
    doc: z.string().trim().min(1).optional().catch(undefined),
  })
  .catch({});

export const Route = createFileRoute("/_shell/docs/")({
  validateSearch: validateDocsRouteSearch,
  loaderDeps: ({ search }) => ({
    doc: search.doc,
  }),
  loader: async ({ context, deps }) => {
    await preloadDocsRouteData(context.queryClient, deps);
  },
});

export function validateDocsRouteSearch(search: Record<string, unknown>): DocsRouteSearch {
  return docsRouteSearchSchema.parse(search);
}

export async function preloadDocsRouteData(
  queryClient: QueryClient,
  deps: DocsRouteSearch,
): Promise<void> {
  await Promise.all([
    queryClient.ensureQueryData(docsDocumentsQueryOptions({ limit: 100 })),
    isBackendDocsDocumentId(deps.doc)
      ? queryClient.ensureQueryData(
          docsDocumentExportQueryOptions({ docId: deps.doc, includeComments: true }),
        )
      : Promise.resolve(undefined),
  ]).catch(() => undefined);
}
