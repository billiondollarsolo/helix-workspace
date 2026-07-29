import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { UniversalEditorRouter } from "@/features/_open/ui/UniversalEditorRouter";
import { useEditorsAlpha } from "@/features/apps/editors-alpha";
import { NativeDocumentShell } from "@/features/docs/native-document-shell";
import { nativeDocumentSessionQueryOptions } from "@/features/docs/queries";
import { enforceFullWorkspaceRoute } from "@/components/mvp-boundary";

interface DocumentRouteSearch {
  readonly open?: "office";
}

function validateDocumentRouteSearch(search: Record<string, unknown>): DocumentRouteSearch {
  return search.open === "office" ? { open: "office" } : {};
}

export const Route = createFileRoute("/_shell/docs/$documentId")({
  beforeLoad: () => enforceFullWorkspaceRoute(),
  validateSearch: (search): DocumentRouteSearch => validateDocumentRouteSearch(search),
  component: DocumentRoute,
});

function DocumentRoute() {
  const { documentId } = Route.useParams();
  const { open } = Route.useSearch();
  const editorsAlpha = useEditorsAlpha();
  const shouldTryNative = open !== "office" && editorsAlpha.enabled;
  const nativeQuery = useQuery({
    ...nativeDocumentSessionQueryOptions(documentId),
    enabled: shouldTryNative,
  });
  const nativeFetch = shouldTryNative
    ? nativeQuery
    : { isLoading: false, isError: false, isSuccess: true, data: null };

  return (
    <UniversalEditorRouter
      objectId={documentId}
      surface="docs"
      nativeEditingEnabled={editorsAlpha.enabled}
      nativeFetch={nativeFetch}
      renderNative={() => <NativeDocumentShell documentId={documentId} />}
    />
  );
}
