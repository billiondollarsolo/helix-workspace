import { createFileRoute } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { DriveShell } from "@/features/drive/drive-shell";
import { driveItemsQueryOptions } from "@/features/drive/queries";

export const Route = createFileRoute("/_shell/drive/")({
  component: DriveRoute,
  loader: async ({ context }) => {
    // Warm the default My Drive (root) listing so the surface paints with
    // real data on first render.
    await context.queryClient
      .ensureQueryData(driveItemsQueryOptions({ folderId: null, scope: "my" }))
      .catch(() => undefined);
  },
});

function DriveRoute() {
  return (
    <SurfaceFrame
      title="Drive"
      icon={<Icons.Drive />}
      searchPlaceholder="Search Drive"
    >
      <DriveShell />
    </SurfaceFrame>
  );
}
