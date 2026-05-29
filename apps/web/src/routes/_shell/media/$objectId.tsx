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
import { useQuery } from "@tanstack/react-query";
import { loadDriveObjectForEditor } from "@/features/_open/universal-loader";
import {
  ImportedAudioRenderer,
  ImportedEbookRenderer,
  ImportedImageRenderer,
  ImportedVideoRenderer,
  UnsupportedFormatPlaceholder,
} from "@/features/_open/ui";

export const Route = createFileRoute("/_shell/media/$objectId")({
  component: MediaRoute,
});

function MediaRoute() {
  const { objectId } = Route.useParams();
  const query = useQuery({
    queryKey: ["media-open", objectId],
    queryFn: () => loadDriveObjectForEditor(objectId, {}),
  });

  if (query.isLoading) return <Centered>Loading media…</Centered>;
  if (query.isError) {
    return (
      <Centered isError>Failed to load media: {(query.error as Error).message}</Centered>
    );
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
      return <ImportedAudioRenderer audio={parsed} objectId={objectId} fileName={fileName} />;
    case "video":
      return <ImportedVideoRenderer video={parsed} objectId={objectId} fileName={fileName} />;
    case "image":
      return <ImportedImageRenderer image={parsed} objectId={objectId} fileName={fileName} />;
    case "ebook":
      return <ImportedEbookRenderer ebook={parsed} objectId={objectId} fileName={fileName} />;
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

function Centered({
  children,
  isError = false,
}: {
  readonly children: React.ReactNode;
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
