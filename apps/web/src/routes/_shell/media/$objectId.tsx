/* Media route — opens any audio or video Drive object in a dedicated viewer.
 *
 * Drive's `editorDestinationForFile` routes audio/video here. The viewer
 * itself is a thin wrapper around the universal loader: fetch the blob,
 * detect the format, mount the matching Imported{Audio,Video}Renderer.
 *
 * No native session step (audio/video have no helix-native representation —
 * they're consumed in-place, not edited). PDF/image follow the same pattern
 * via their own routes.
 */

import { createFileRoute } from "@tanstack/react-router";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { lazy, Suspense, type ReactNode } from "react";
import { UnsupportedFormatPlaceholder } from "@/features/_open/ui/UnsupportedFormatPlaceholder";

const LazyImportedAudioRenderer = lazy(() =>
  import("@/features/_open/ui/ImportedAudioRenderer").then((module) => ({
    default: module.ImportedAudioRenderer,
  })),
);
const LazyImportedEbookRenderer = lazy(() =>
  import("@/features/_open/ui/ImportedEbookRenderer").then((module) => ({
    default: module.ImportedEbookRenderer,
  })),
);
const LazyImportedImageRenderer = lazy(() =>
  import("@/features/_open/ui/ImportedImageRenderer").then((module) => ({
    default: module.ImportedImageRenderer,
  })),
);
const LazyImportedVideoRenderer = lazy(() =>
  import("@/features/_open/ui/ImportedVideoRenderer").then((module) => ({
    default: module.ImportedVideoRenderer,
  })),
);

export const Route = createFileRoute("/_shell/media/$objectId")({
  component: MediaRoute,
});

function MediaRoute() {
  const { objectId } = Route.useParams();
  const query = useQuery(mediaObjectQueryOptions(objectId));

  if (query.isLoading) return <Centered>Loading media…</Centered>;
  if (query.isError) {
    return <Centered isError>Failed to load media: {query.error.message}</Centered>;
  }

  const result = query.data;
  if (!result) return <Centered>Loading media…</Centered>;
  if (result.kind === "not-found") return <Centered>This file no longer exists in Drive.</Centered>;
  if (result.kind === "unsupported") {
    return (
      <UnsupportedFormatPlaceholder
        result={result.result}
        objectId={objectId}
        fileName={result.blob.name}
        byteSize={result.blob.byteLength}
      />
    );
  }

  const fileName = result.blob.name;
  const parsed = result.parsed;
  switch (parsed.kind) {
    case "audio":
      return withMediaFallback(
        <LazyImportedAudioRenderer audio={parsed} objectId={objectId} fileName={fileName} />,
      );
    case "video":
      return withMediaFallback(
        <LazyImportedVideoRenderer video={parsed} objectId={objectId} fileName={fileName} />,
      );
    case "image":
      return withMediaFallback(
        <LazyImportedImageRenderer image={parsed} objectId={objectId} fileName={fileName} />,
      );
    case "ebook":
      return withMediaFallback(
        <LazyImportedEbookRenderer ebook={parsed} objectId={objectId} fileName={fileName} />,
      );
    case "unsupported":
      return (
        <UnsupportedFormatPlaceholder
          result={parsed}
          objectId={objectId}
          fileName={fileName}
          byteSize={result.blob.byteLength}
        />
      );
    default:
      // doc / sheet / deck / pdf etc. opened by direct URL — they have their
      // own dedicated routes via Drive click. Render the same polished
      // "Preview not available" so the user can download or navigate back
      // rather than seeing a raw error message.
      return (
        <UnsupportedFormatPlaceholder
          result={{
            kind: "unsupported",
            format: parsed.format,
            reason: `${parsed.format.label} opens in the dedicated editor — click the file from Drive to launch it there.`,
          }}
          objectId={objectId}
          fileName={fileName}
          byteSize={result.blob.byteLength}
        />
      );
  }
}

function mediaObjectQueryOptions(objectId: string) {
  return queryOptions({
    queryKey: ["media-open", objectId],
    queryFn: async () => {
      const { loadDriveObjectForEditor } = await import("@/features/_open/universal-loader");
      return loadDriveObjectForEditor(objectId, {});
    },
  });
}

function Centered({
  children,
  isError = false,
}: {
  readonly children: ReactNode;
  readonly isError?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: 320,
        padding: 32,
        color: isError ? "var(--danger)" : "var(--text-2)",
      }}
    >
      {children}
    </div>
  );
}

function withMediaFallback(content: ReactNode): ReactNode {
  return <Suspense fallback={<Centered>Loading preview…</Centered>}>{content}</Suspense>;
}
