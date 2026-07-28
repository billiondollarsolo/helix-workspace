import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { DriveShell } from "@/features/drive/drive-shell";
import { validateDriveRouteSearch, type DriveRouteSearch } from "@/features/drive/route-search";

// Search params that survive `/drive` URL navigation. Folder drill-down
// + scope (my/shared/recent/...) + query keyword + selected file id all
// round-trip through the URL so the back button works and links are
// shareable. UUIDs sit in `folder=` / `file=`; bare strings handle the
// other axes.
export const Route = createFileRoute("/_shell/drive/")({
  component: DriveRoute,
  validateSearch: (search): DriveRouteSearch => validateDriveRouteSearch(search),
  loaderDeps: ({ search }) => ({
    folder: search.folder ?? null,
    q: search.q?.trim() ?? "",
    scope: search.scope ?? "my",
  }),
  loader: async ({ context, deps }) => {
    const { driveItemsQueryOptions } = await import("@/features/drive/queries");
    await context.queryClient
      .ensureQueryData(
        driveItemsQueryOptions({
          folderId: deps.folder,
          limit: deps.q.length > 0 ? 50 : 100,
          query: deps.q,
          scope: deps.scope,
        }),
      )
      .catch(() => undefined);
  },
});

function DriveRoute() {
  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  const searchValue = search.q ?? "";

  const onSearchChange = (value: string) => {
    const q = value.trim();
    void navigate({
      to: "/drive",
      search: (prev) => ({
        ...(prev as Record<string, unknown>),
        file: undefined,
        q: q.length > 0 ? value : undefined,
      }),
      replace: true,
    });
  };

  return (
    <SurfaceFrame
      title="Drive"
      icon={<Icons.Drive />}
      searchPlaceholder="Search Drive"
      searchValue={searchValue}
      onSearchChange={onSearchChange}
    >
      <DriveShell />
    </SurfaceFrame>
  );
}
