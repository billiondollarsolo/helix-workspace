import { createFileRoute } from "@tanstack/react-router";
import {
  driveItemsInputFromRouteSearch,
  driveItemsQueryOptions,
  validateDriveRouteSearch,
} from "@/features/drive/queries";

export const Route = createFileRoute("/_shell/drive/")({
  validateSearch: validateDriveRouteSearch,
  loaderDeps: ({ search }) => ({
    folder: search.folder,
    includeTrashed: search.includeTrashed,
    q: search.q,
    scope: search.scope,
  }),
  loader: async ({ context, deps }) => {
    await context.queryClient
      .ensureQueryData(driveItemsQueryOptions(driveItemsInputFromRouteSearch(deps)))
      .catch(() => undefined);
  },
});
