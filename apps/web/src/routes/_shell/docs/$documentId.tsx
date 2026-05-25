import { createFileRoute } from "@tanstack/react-router";
import { NativeDocumentShell } from "@/features/docs/native-document-shell";
import { nativeDocumentSessionQueryOptions } from "@/features/docs/queries";

export const Route = createFileRoute("/_shell/docs/$documentId")({
  loader: ({ context, params }) =>
    context.queryClient.ensureQueryData(nativeDocumentSessionQueryOptions(params.documentId)),
  component: DocumentRoute,
});

function DocumentRoute() {
  const { documentId } = Route.useParams();
  return <NativeDocumentShell documentId={documentId} />;
}
