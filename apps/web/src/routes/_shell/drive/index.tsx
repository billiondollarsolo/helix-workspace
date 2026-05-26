import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { Icons } from "@/components/icons";
import { SurfaceFrame } from "@/components/shell";
import { DriveShell } from "@/features/drive/drive-shell";
import { driveItemsQueryOptions } from "@/features/drive/queries";

// Search params that survive `/drive` URL navigation. Folder drill-down
// + scope (my/shared/recent/...) + query keyword + selected file id all
// round-trip through the URL so the back button works and links are
// shareable. UUIDs sit in `folder=` / `file=`; bare strings handle the
// other axes.
const driveSearchSchema = z.object({
  folder: z.string().uuid().nullable().optional().catch(undefined),
  scope: z.enum(["my","shared","recent","starred","recordings","trash"]).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  file: z.string().uuid().optional().catch(undefined),
});

export const Route = createFileRoute("/_shell/drive/")({
  component: DriveRoute,
  validateSearch: (search) => driveSearchSchema.parse(search),
  loaderDeps: ({ search }) => ({
    folder: search.folder ?? null,
    scope: search.scope ?? "my",
    q: search.q?.trim() ?? "",
  }),
  loader: async ({ context, deps }) => {
    await context.queryClient
      .ensureQueryData(
        driveItemsQueryOptions({
          folderId: deps.folder,
          scope: deps.scope,
          query: deps.q,
          limit: deps.q.length > 0 ? 50 : 100,
        }),
      )
      .catch(() => undefined);
  },
});

function DriveRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const query = search.q?.trim() ?? "";

  return (
    <SurfaceFrame
      title="Drive"
      icon={<Icons.Drive />}
      searchPlaceholder="Search Drive"
      searchValue={query}
      onSearchChange={(nextQuery) => {
        void navigate({
          search: (previous) => ({
            ...previous,
            q: nextQuery.trim().length === 0 ? undefined : nextQuery,
            file: undefined,
          }),
        });
      }}
    >
      <DriveShell />
    </SurfaceFrame>
  );
}
